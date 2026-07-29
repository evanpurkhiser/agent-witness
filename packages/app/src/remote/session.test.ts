import {decode, encode} from '@msgpack/msgpack';
import {describe, expect, it, vi} from 'vitest';

import type {Bytes} from 'app/utils/bytes';

import {type PairingRecord, type PairingStore, RemoteSession} from './session';

const SERVER_ID = '11111111-2222-4333-8444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION_ID = '12345678-9abc-4def-8123-456789abcdef';
const REQUEST_ID = '99999999-8888-4777-8666-555555555555';
const ENDPOINT = 'ws://localhost/api/agent';

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
    });
    await settle();

    expect(session.snapshot().status).toBe('connected');
    expect(sentMessages(socket).at(-1)).toEqual({type: 'agent_ready'});
  });

  it('forgets a rejected server pairing without changing other state', async () => {
    const store = new MemoryPairingStore(pairing());
    const {session, socket} = await connectSession({store});
    socket.receive({type: 'rejected'});
    await settle();

    await session.forgetPairing(ENDPOINT);

    expect(await store.loadPairing(ENDPOINT)).toBeNull();
    expect(session.snapshot().status).toBe('disconnected');
  });

  it('buffers requests while locked and drains them after unlock', async () => {
    const store = new MemoryPairingStore(pairing());
    const handleRequest = vi.fn(() => Promise.resolve(bytes(0, 0, 0, 1, 12)));
    const {session, socket} = await connectSession({store, handleRequest});
    socket.receive({
      type: 'authenticated',
      server_id: SERVER_ID,
      session_id: SESSION_ID,
    });
    await settle();

    socket.receive({
      type: 'agent_request',
      request_id: REQUEST_ID,
      attempt: 2,
      packet: bytes(0, 0, 0, 1, 11),
    });
    await settle();

    expect(handleRequest).not.toHaveBeenCalled();
    expect(session.snapshot().pendingRequests).toBe(1);

    session.setReady(true);
    await settle();

    expect(handleRequest).toHaveBeenCalledWith(bytes(0, 0, 0, 1, 11));
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
    });
    await settle();

    socket.receive({
      type: 'agent_request',
      request_id: REQUEST_ID,
      attempt: 3,
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

  it('answers application heartbeats', async () => {
    const {socket} = await connectSession({
      store: new MemoryPairingStore(pairing()),
    });
    socket.receive({
      type: 'authenticated',
      server_id: SERVER_ID,
      session_id: SESSION_ID,
    });
    await settle();

    socket.receive({type: 'ping'});
    await settle();

    expect(sentMessages(socket).at(-1)).toEqual({type: 'pong'});
  });
});

async function connectSession({
  store,
  ready = false,
  handleRequest = () => Promise.resolve(bytes(0, 0, 0, 1, 5)),
}: {
  store: PairingStore;
  ready?: boolean;
  handleRequest?: (packet: Bytes) => Promise<Bytes>;
}): Promise<{session: RemoteSession; socket: FakeSocket}> {
  const socket = new FakeSocket(ENDPOINT);
  const session = new RemoteSession({
    pairingStore: store,
    handleRequest,
    onChange() {},
    onDisconnect() {},
    createSocket: () => socket as unknown as WebSocket,
  });
  session.setReady(ready);
  await session.connect(ENDPOINT, 'Browser');
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

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
