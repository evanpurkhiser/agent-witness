import {decode, encode} from '@msgpack/msgpack';
import {describe, expect, it, vi} from 'vitest';

import {inspectAgentRequest} from 'app/ssh/agent';
import type {Bytes} from 'app/utils/bytes';

import {type PairingRecord, type PairingStore, RemoteSession} from './session';

const SERVER_ID = '11111111-2222-4333-8444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION_ID = '12345678-9abc-4def-8123-456789abcdef';
const REQUEST_ID = '99999999-8888-4777-8666-555555555555';
const ENDPOINT = 'ws://localhost/api/agent';
const VAPID_PUBLIC_KEY = bytes(4, ...Array.from({length: 64}, () => 1));
const P256_DH =
  'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU';
const AUTH = 'AAECAwQFBgcICQoLDA0ODw';

describe('RemoteSession', () => {
  it('pairs a new client, persists its credential, and reports locked', async () => {
    const store = new MemoryPairingStore();
    const {session, socket} = await connectSession({store});

    expect(sentMessages(socket)).toEqual([{type: 'pair_request', label: 'Browser'}]);

    socket.receive({
      type: 'paired',
      server_id: SERVER_ID,
      client_id: CLIENT_ID,
      credential: bytes(1, 2, 3),
      session_id: SESSION_ID,
      vapid_public_key: VAPID_PUBLIC_KEY,
    });
    await settle();

    expect(await store.loadPairing(ENDPOINT)).toEqual({
      endpoint: ENDPOINT,
      serverId: SERVER_ID,
      clientId: CLIENT_ID,
      credential: bytes(1, 2, 3),
      label: 'Browser',
      pairedAt: expect.any(Number),
    });
    expect(session.snapshot()).toMatchObject({
      status: 'connected',
      serverId: SERVER_ID,
      sessionId: SESSION_ID,
      vapidPublicKey: VAPID_PUBLIC_KEY,
    });
    expect(sentMessages(socket).at(-1)).toEqual({type: 'agent_locked'});
  });

  it('authenticates a stored pairing and reports ready', async () => {
    const store = new MemoryPairingStore(pairing());
    const {session, socket} = await connectSession({store, ready: true});

    expect(sentMessages(socket)).toEqual([
      {
        type: 'authenticate',
        client_id: CLIENT_ID,
        credential: bytes(1, 2, 3),
      },
    ]);

    socket.receive({
      type: 'authenticated',
      server_id: SERVER_ID,
      session_id: SESSION_ID,
      vapid_public_key: VAPID_PUBLIC_KEY,
    });
    await settle();

    expect(session.snapshot()).toMatchObject({
      status: 'connected',
      vapidPublicKey: VAPID_PUBLIC_KEY,
    });
    expect(sentMessages(socket).at(-1)).toEqual({type: 'agent_ready'});
  });

  it('forgets a rejected server pairing without changing other state', async () => {
    const store = new MemoryPairingStore(pairing());
    const {session, socket} = await connectSession({store});
    socket.receive({type: 'rejected'});
    await settle();

    session.setActive(false);
    session.setActive(true);
    expect(session.snapshot().status).toBe('rejected');

    await session.forgetPairing(ENDPOINT);

    expect(await store.loadPairing(ENDPOINT)).toBeNull();
    expect(session.snapshot().status).toBe('reconnecting');
    expect(session.snapshot().vapidPublicKey).toBeNull();
  });

  it('processes allowed requests while locked', async () => {
    const store = new MemoryPairingStore(pairing());
    const handleRequest = vi.fn(() => Promise.resolve(bytes(0, 0, 0, 1, 12)));
    const packet = bytes(0, 0, 0, 1, 11);
    const {session, socket} = await connectSession({
      store,
      handleRequest,
      canProcessBeforeReady: request =>
        inspectAgentRequest(request.packet).type === 'identities',
    });
    socket.receive({
      type: 'authenticated',
      server_id: SERVER_ID,
      session_id: SESSION_ID,
      vapid_public_key: VAPID_PUBLIC_KEY,
    });
    await settle();

    socket.receive({
      type: 'agent_request',
      request_id: REQUEST_ID,
      attempt: 1,
      deadline: 1_800_000_000_000,
      packet,
    });
    await settle();

    expect(handleRequest).toHaveBeenCalledWith(packet);
    expect(sentMessages(socket).at(-1)).toEqual({
      type: 'agent_response',
      request_id: REQUEST_ID,
      attempt: 1,
      packet: bytes(0, 0, 0, 1, 12),
    });
    expect(session.snapshot().pendingRequests).toBe(0);
  });

  it('buffers signing requests while locked and drains them after unlock', async () => {
    const store = new MemoryPairingStore(pairing());
    const handleRequest = vi.fn(() => Promise.resolve(bytes(0, 0, 0, 1, 12)));
    const {session, socket} = await connectSession({store, handleRequest});
    socket.receive({
      type: 'authenticated',
      server_id: SERVER_ID,
      session_id: SESSION_ID,
      vapid_public_key: VAPID_PUBLIC_KEY,
    });
    await settle();

    socket.receive({
      type: 'agent_request',
      request_id: REQUEST_ID,
      attempt: 2,
      deadline: 1_800_000_000_000,
      packet: signPacket(),
    });
    await settle();

    expect(handleRequest).not.toHaveBeenCalled();
    expect(session.snapshot().pendingRequests).toBe(1);

    session.setReady(true);
    await settle();

    expect(handleRequest).toHaveBeenCalledWith(signPacket());
    expect(sentMessages(socket).at(-1)).toEqual({
      type: 'agent_response',
      request_id: REQUEST_ID,
      attempt: 2,
      packet: bytes(0, 0, 0, 1, 12),
    });
    expect(session.snapshot().pendingRequests).toBe(0);
  });

  it('suppresses a response cancelled during processing', async () => {
    const store = new MemoryPairingStore(pairing());
    let finish!: (packet: Bytes) => void;
    const handleRequest = vi.fn(() => new Promise<Bytes>(resolve => (finish = resolve)));
    const {session, socket} = await connectSession({
      store,
      ready: true,
      handleRequest,
    });
    socket.receive({
      type: 'authenticated',
      server_id: SERVER_ID,
      session_id: SESSION_ID,
      vapid_public_key: VAPID_PUBLIC_KEY,
    });
    await settle();

    socket.receive({
      type: 'agent_request',
      request_id: REQUEST_ID,
      attempt: 3,
      deadline: 1_800_000_000_000,
      packet: bytes(0, 0, 0, 1, 11),
    });
    await settle();
    socket.receive({
      type: 'cancel_request',
      request_id: REQUEST_ID,
      attempt: 3,
    });
    await settle();

    finish(bytes(0, 0, 0, 1, 12));
    await settle();

    expect(session.snapshot().pendingRequests).toBe(0);
    expect(sentMessages(socket)).not.toContainEqual(
      expect.objectContaining({type: 'agent_response'}),
    );
  });

  it('reports request lifecycle transitions with request context', async () => {
    const pending = vi.fn();
    const processing = vi.fn();
    const closed = vi.fn();
    const sockets: FakeSocket[] = [];
    const session = new RemoteSession({
      pairingStore: new MemoryPairingStore(pairing()),
      handleRequest: () => Promise.resolve(bytes(0, 0, 0, 1, 5)),
      onChange() {},
      onDisconnect() {},
      onRequestPending: pending,
      onRequestProcessing: processing,
      onRequestClosed: closed,
      createSocket: endpoint => {
        const socket = new FakeSocket(endpoint);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    await session.connect(ENDPOINT, 'Browser');
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      type: 'authenticated',
      server_id: SERVER_ID,
      session_id: SESSION_ID,
      vapid_public_key: VAPID_PUBLIC_KEY,
    });
    await settle();

    const packet = signPacket();
    socket.receive({
      type: 'agent_request',
      request_id: REQUEST_ID,
      attempt: 4,
      deadline: 1_800_000_000_000,
      packet,
    });
    await settle();

    const request = {
      requestId: REQUEST_ID,
      attempt: 4,
      deadline: 1_800_000_000_000,
      packet,
    };
    expect(pending).toHaveBeenCalledWith(request);
    expect(processing).not.toHaveBeenCalled();

    socket.receive({type: 'cancel_request', request_id: REQUEST_ID, attempt: 4});
    await settle();

    expect(closed).toHaveBeenCalledWith(expect.objectContaining(request));
  });

  it('answers application heartbeats', async () => {
    const {socket} = await connectSession({
      store: new MemoryPairingStore(pairing()),
    });
    socket.receive({
      type: 'authenticated',
      server_id: SERVER_ID,
      session_id: SESSION_ID,
      vapid_public_key: VAPID_PUBLIC_KEY,
    });
    await settle();

    socket.receive({type: 'ping'});
    await settle();

    expect(sentMessages(socket).at(-1)).toEqual({type: 'pong'});
  });

  it('sends a push subscription through an authenticated session', async () => {
    const {session, socket} = await connectSession({
      store: new MemoryPairingStore(pairing()),
    });
    socket.receive({
      type: 'authenticated',
      server_id: SERVER_ID,
      session_id: SESSION_ID,
      vapid_public_key: VAPID_PUBLIC_KEY,
    });
    await settle();

    session.registerPushSubscription({
      endpoint: 'https://push.example.test/subscription',
      expirationTime: null,
      p256Dh: P256_DH,
      auth: AUTH,
    });

    expect(sentMessages(socket).at(-1)).toEqual({
      type: 'set_push_subscription',
      endpoint: 'https://push.example.test/subscription',
      expiration_time: null,
      p256_dh: P256_DH,
      auth: AUTH,
    });
  });

  it('closes while inactive and reconnects immediately when reactivated', async () => {
    const store = new MemoryPairingStore(pairing());
    const sockets: FakeSocket[] = [];
    const onDisconnect = vi.fn();
    const session = new RemoteSession({
      pairingStore: store,
      handleRequest: () => Promise.resolve(bytes(0, 0, 0, 1, 5)),
      onChange() {},
      onDisconnect,
      createSocket: endpoint => {
        const socket = new FakeSocket(endpoint);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    await session.connect(ENDPOINT, 'Browser');
    sockets[0]!.open();
    sockets[0]!.receive({
      type: 'authenticated',
      server_id: SERVER_ID,
      session_id: SESSION_ID,
      vapid_public_key: VAPID_PUBLIC_KEY,
    });
    await settle();

    session.setActive(false);

    expect(session.snapshot().status).toBe('reconnecting');
    expect(session.snapshot().vapidPublicKey).toBeNull();
    expect(sockets[0]!.readyState).toBe(WebSocket.CLOSED);
    expect(onDisconnect).toHaveBeenCalledOnce();

    session.setActive(true);
    await settle();

    expect(sockets).toHaveLength(2);
    expect(session.snapshot().status).toBe('reconnecting');
  });

  it('keeps retrying transport failures with only one pending retry', async () => {
    vi.useFakeTimers();

    try {
      const sockets: FakeSocket[] = [];
      const session = new RemoteSession({
        pairingStore: new MemoryPairingStore(pairing()),
        handleRequest: () => Promise.resolve(bytes(0, 0, 0, 1, 5)),
        onChange() {},
        onDisconnect() {},
        createSocket: endpoint => {
          const socket = new FakeSocket(endpoint);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      });

      await session.connect(ENDPOINT, 'Browser');
      sockets[0]!.fail();

      expect(session.snapshot().status).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(2_000);
      expect(sockets).toHaveLength(2);

      sockets[1]!.fail();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sockets).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

async function connectSession({
  store,
  ready = false,
  handleRequest = () => Promise.resolve(bytes(0, 0, 0, 1, 5)),
  canProcessBeforeReady,
}: {
  store: PairingStore;
  ready?: boolean;
  handleRequest?: (packet: Bytes) => Promise<Bytes>;
  canProcessBeforeReady?: (request: {packet: Bytes}) => boolean;
}): Promise<{session: RemoteSession; socket: FakeSocket}> {
  const sockets: FakeSocket[] = [];
  const session = new RemoteSession({
    pairingStore: store,
    handleRequest,
    canProcessBeforeReady,
    onChange() {},
    onDisconnect() {},
    createSocket: endpoint => {
      const socket = new FakeSocket(endpoint);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  session.setReady(ready);
  await session.connect(ENDPOINT, 'Browser');
  const socket = sockets[0]!;
  socket.open();
  return {session, socket};
}

class FakeSocket extends EventTarget {
  readonly url: string;
  binaryType: BinaryType = 'blob';
  readyState: number = WebSocket.CONNECTING;
  sent: Bytes[] = [];

  constructor(url: string) {
    super();
    this.url = url;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  receive(message: unknown): void {
    const frame = encode({version: 1, message});
    const data = frame.buffer.slice(
      frame.byteOffset,
      frame.byteOffset + frame.byteLength,
    ) as ArrayBuffer;
    this.dispatchEvent(new MessageEvent('message', {data}));
  }

  send(data: Bytes): void {
    this.sent.push(data);
  }

  fail(): void {
    this.readyState = WebSocket.CLOSING;
    this.dispatchEvent(new Event('error'));
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close'));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

class MemoryPairingStore implements PairingStore {
  #pairing: PairingRecord | null;

  constructor(pairing: PairingRecord | null = null) {
    this.#pairing = pairing;
  }

  loadPairing(endpoint: string): Promise<PairingRecord | null> {
    return Promise.resolve(this.#pairing?.endpoint === endpoint ? this.#pairing : null);
  }

  savePairing(pairing: PairingRecord): Promise<void> {
    this.#pairing = pairing;
    return Promise.resolve();
  }

  deletePairing(endpoint: string): Promise<void> {
    if (this.#pairing?.endpoint === endpoint) {
      this.#pairing = null;
    }
    return Promise.resolve();
  }
}

function pairing(): PairingRecord {
  return {
    endpoint: ENDPOINT,
    serverId: SERVER_ID,
    clientId: CLIENT_ID,
    credential: bytes(1, 2, 3),
    label: 'Browser',
    pairedAt: 1000,
  };
}

function sentMessages(socket: FakeSocket): unknown[] {
  return socket.sent.map(frame => {
    const envelope = decode(frame) as {message: unknown};
    return envelope.message;
  });
}

function bytes(...values: number[]): Bytes {
  return new Uint8Array(values);
}

function signPacket(): Bytes {
  return bytes(0, 0, 0, 15, 13, 0, 0, 0, 1, 7, 0, 0, 0, 1, 8, 0, 0, 0, 0);
}

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
