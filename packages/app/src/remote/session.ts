// The worker-owned remote session: WebSocket lifecycle, pairing handshake,
// request buffering, cancellation, and application heartbeats. Vault and agent
// behavior enter through callbacks so this transport remains independently
// testable.

import type {Bytes} from 'app/utils/bytes';

import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from './protocol';

// REVIEW: Needs a comment
const MAX_PENDING_REQUESTS = 32;

// REVIEW: Lets add jsdoc style comments above all the interfaces here.
export interface PairingRecord {
  endpoint: string;
  serverId: string;
  clientId: string;
  credential: Bytes;
  label: string;
  pairedAt: number;
}

export interface PairingStore {
  loadPairing(endpoint: string): Promise<PairingRecord | null>;
  savePairing(pairing: PairingRecord): Promise<void>;
  deletePairing(endpoint: string): Promise<void>;
}

// REVIEW: Think we could make this discriminate based on status? then we wouldn't need the nulls right?
export interface ConnectionSnapshot {
  status: 'disconnected' | 'connecting' | 'connected' | 'rejected' | 'error';
  serverId: string | null;
  sessionId: string | null;
  pendingRequests: number;
  error: string | null;
}

export interface RemoteSessionOptions {
  pairingStore: PairingStore;
  handleRequest(packet: Bytes): Promise<Bytes>;
  onChange(): void;
  onDisconnect(): void;
  createSocket?: (endpoint: string) => WebSocket;
}

interface PendingRequest {
  requestId: string;
  attempt: number;
  packet: Bytes;
  processing: boolean;
}

// REVIEW: Let's add jsdoc comment sto all the methosd on the remote session

/**
 * One browser worker's connection to one agent-witness server.
 */
export class RemoteSession {
  readonly #pairingStore: PairingStore;
  readonly #handleRequest: (packet: Bytes) => Promise<Bytes>;
  readonly #onChange: () => void;
  readonly #onDisconnect: () => void;
  readonly #createSocket: (endpoint: string) => WebSocket;

  #socket: WebSocket | null = null;

  #pairing: PairingRecord | null = null;

  #ready = false;

  // REVIEW: Lets add a JSDoc comment on what the generation is used for
  #generation = 0;

  // REVIEW: Definitely needs a comment, probably should be called `receiving`
  #receive = Promise.resolve();

  // REVIEW: Needs comment
  #pending = new Map<string, PendingRequest>();

  #snapshot: ConnectionSnapshot = {
    status: 'disconnected',
    serverId: null,
    sessionId: null,
    pendingRequests: 0,
    error: null,
  };

  constructor(options: RemoteSessionOptions) {
    this.#pairingStore = options.pairingStore;
    this.#handleRequest = options.handleRequest;
    this.#onChange = options.onChange;
    this.#onDisconnect = options.onDisconnect;
    this.#createSocket = options.createSocket ?? (endpoint => new WebSocket(endpoint));
  }

  snapshot(): ConnectionSnapshot {
    return {...this.#snapshot};
  }

  async connect(endpoint: string, label: string): Promise<void> {
    this.disconnect();

    const normalized = new URL(endpoint).href;
    const generation = ++this.#generation;
    this.#setSnapshot({
      status: 'connecting',
      serverId: null,
      sessionId: null,
      error: null,
    });

    let pairing: PairingRecord | null;
    let socket: WebSocket;
    try {
      pairing = await this.#pairingStore.loadPairing(normalized);
      if (generation !== this.#generation) {
        return;
      }

      socket = this.#createSocket(normalized);
    } catch (cause) {
      if (generation === this.#generation) {
        this.#setSnapshot({
          status: 'error',
          serverId: null,
          sessionId: null,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
      throw cause;
    }

    this.#pairing = pairing;
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;

    socket.addEventListener('open', () => {
      try {
        this.#send(
          socket,
          pairing
            ? {
                type: 'authenticate',
                client_id: pairing.clientId,
                credential: pairing.credential,
              }
            : {type: 'pair_request', label},
        );
      } catch (cause) {
        this.#fail(socket, cause);
      }
    });
    socket.addEventListener('message', event => {
      this.#receive = this.#receive
        .then(() => this.#receiveMessage(socket, event.data, label))
        .catch(cause => this.#fail(socket, cause));
    });
    socket.addEventListener('error', () =>
      this.#fail(socket, new Error('WebSocket connection failed')),
    );
    socket.addEventListener('close', () => this.#closed(socket));
  }

  disconnect(): void {
    ++this.#generation;
    const socket = this.#socket;
    const wasConnected = this.#snapshot.status === 'connected';
    this.#socket = null;
    this.#pairing = null;
    this.#clearPending();
    this.#setSnapshot({
      status: 'disconnected',
      serverId: null,
      sessionId: null,
      error: null,
    });
    socket?.close();

    if (wasConnected) {
      this.#onDisconnect();
    }
  }

  async forgetPairing(endpoint: string): Promise<void> {
    const normalized = new URL(endpoint).href;
    this.disconnect();
    await this.#pairingStore.deletePairing(normalized);
  }

  setReady(ready: boolean): void {
    this.#ready = ready;
    const socket = this.#socket;
    if (!socket || this.#snapshot.status !== 'connected') {
      return;
    }

    this.#send(socket, {type: ready ? 'agent_ready' : 'agent_locked'});
    if (ready) {
      this.#drain(socket);
    }
  }

  async #receiveMessage(socket: WebSocket, data: unknown, label: string): Promise<void> {
    if (socket !== this.#socket) {
      return;
    }

    if (!(data instanceof ArrayBuffer)) {
      throw new Error('expected a binary WebSocket message');
    }

    const message = decodeServerMessage(new Uint8Array(data));
    if (this.#snapshot.status === 'connecting') {
      await this.#handshake(socket, message, label);
      return;
    }
    if (this.#snapshot.status !== 'connected') {
      return;
    }

    switch (message.type) {
      case 'ping':
        this.#send(socket, {type: 'pong'});
        break;
      case 'agent_request':
        this.#enqueue(socket, message);
        break;
      case 'cancel_request':
        this.#cancel(message.request_id, message.attempt);
        break;
      case 'paired':
      case 'authenticated':
      case 'rejected':
        throw new Error('received a handshake message after authentication');
    }
  }

  async #handshake(
    socket: WebSocket,
    message: ServerMessage,
    label: string,
  ): Promise<void> {
    if (!this.#endpoint) {
      return;
    }

    if (message.type === 'rejected') {
      this.#finish(socket, 'rejected', 'server rejected the connection');
      return;
    }

    if (message.type === 'paired') {
      if (this.#pairing) {
        throw new Error('server paired an already-known client');
      }

      const pairing: PairingRecord = {
        endpoint: this.#endpoint,
        serverId: message.server_id,
        clientId: message.client_id,
        credential: message.credential,
        label,
        pairedAt: Date.now(),
      };
      await this.#pairingStore.savePairing(pairing);
      if (socket !== this.#socket) {
        return;
      }

      this.#pairing = pairing;
      this.#connected(socket, message.server_id, message.session_id);
      return;
    }

    if (message.type === 'authenticated') {
      if (!this.#pairing || message.server_id !== this.#pairing.serverId) {
        throw new Error('server identity does not match the stored pairing');
      }

      this.#connected(socket, message.server_id, message.session_id);
      return;
    }

    throw new Error('expected a handshake response');
  }

  get #endpoint(): string | null {
    return this.#socket?.url ?? null;
  }

  #connected(socket: WebSocket, serverId: string, sessionId: string): void {
    this.#setSnapshot({
      status: 'connected',
      serverId,
      sessionId,
      error: null,
    });
    this.#send(socket, {type: this.#ready ? 'agent_ready' : 'agent_locked'});
    // REVIEW: If we made process tryProcess this ready thing could go away
    if (this.#ready) {
      this.#drain(socket);
    }
  }

  #enqueue(
    socket: WebSocket,
    message: Extract<ServerMessage, {type: 'agent_request'}>,
  ): void {
    const key = requestKey(message.request_id, message.attempt);
    if (this.#pending.has(key)) {
      throw new Error('received a duplicate agent request');
    }
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      throw new Error('remote request buffer is full');
    }

    this.#pending.set(key, {
      // REVIEW: I kind of feel like the zod thing should decode these as
      // camelcase, then we would be able to just spread the message into this
      // PendingRequest thing
      requestId: message.request_id,
      attempt: message.attempt,
      packet: message.packet,
      processing: false,
    });
    this.#pendingChanged();

    if (this.#ready) {
      // REVIEW: Let's rename this tryProcess and it will just early return immediately if it's not ready.
      this.#process(socket, key);
    }
  }

  #cancel(requestId: string, attempt: number): void {
    if (this.#pending.delete(requestKey(requestId, attempt))) {
      this.#pendingChanged();
    }
  }

  #drain(socket: WebSocket): void {
    // REVIEW: Write as FP forEach
    for (const key of this.#pending.keys()) {
      this.#process(socket, key);
    }
  }

  #process(socket: WebSocket, key: string): void {
    const pending = this.#pending.get(key);
    if (!pending || pending.processing || !this.#ready) {
      return;
    }

    pending.processing = true;
    void this.#handleRequest(pending.packet)
      .then(packet => {
        if (socket !== this.#socket || this.#pending.get(key) !== pending) {
          return;
        }

        this.#send(socket, {
          type: 'agent_response',
          request_id: pending.requestId,
          attempt: pending.attempt,
          packet,
        });
        this.#pending.delete(key);
        this.#pendingChanged();
      })
      .catch(cause => this.#fail(socket, cause));
  }

  #send(socket: WebSocket, message: ClientMessage): void {
    if (socket !== this.#socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }

    socket.send(encodeClientMessage(message));
  }

  #fail(socket: WebSocket, cause: unknown): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.#finish(socket, 'error', message);
  }

  #finish(socket: WebSocket, status: ConnectionSnapshot['status'], error: string): void {
    if (socket !== this.#socket) {
      return;
    }

    const wasConnected = this.#snapshot.status === 'connected';
    this.#socket = null;
    this.#clearPending();
    this.#setSnapshot({
      status,
      serverId: null,
      sessionId: null,
      error,
    });
    socket.close();

    if (wasConnected) {
      this.#onDisconnect();
    }
  }

  #closed(socket: WebSocket): void {
    if (socket !== this.#socket) {
      return;
    }

    const wasConnected = this.#snapshot.status === 'connected';
    this.#socket = null;
    this.#clearPending();
    this.#setSnapshot({
      status: 'disconnected',
      serverId: null,
      sessionId: null,
      error: null,
    });

    if (wasConnected) {
      this.#onDisconnect();
    }
  }

  #clearPending(): void {
    if (this.#pending.size === 0) {
      return;
    }

    this.#pending.clear();
    this.#pendingChanged();
  }

  #pendingChanged(): void {
    this.#setSnapshot({pendingRequests: this.#pending.size});
  }

  #setSnapshot(update: Partial<ConnectionSnapshot>): void {
    this.#snapshot = {...this.#snapshot, ...update};
    this.#onChange();
  }
}

function requestKey(requestId: string, attempt: number): string {
  return `${requestId}:${attempt}`;
}
