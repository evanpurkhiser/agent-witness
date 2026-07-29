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

/**
 * Bound queued requests so a locked or unattended agent cannot consume
 * unbounded worker memory.
 */
const MAX_PENDING_REQUESTS = 32;

/**
 * Durable credentials and server identity established by pairing an endpoint.
 */
export interface PairingRecord {
  endpoint: string;
  serverId: string;
  clientId: string;
  credential: Bytes;
  label: string;
  pairedAt: number;
}

/**
 * Persistence operations required by a remote session's pairing lifecycle.
 */
export interface PairingStore {
  loadPairing(endpoint: string): Promise<PairingRecord | null>;
  savePairing(pairing: PairingRecord): Promise<void>;
  deletePairing(endpoint: string): Promise<void>;
}

// REVIEW: Make this a discriminated union so status-specific fields do not
// require null placeholders.
/**
 * Display-safe connection state published to page code.
 */
export interface ConnectionSnapshot {
  status: 'disconnected' | 'connecting' | 'connected' | 'rejected' | 'error';
  serverId: string | null;
  sessionId: string | null;
  pendingRequests: number;
  error: string | null;
}

/**
 * Transport dependencies and worker callbacks for a remote session.
 */
export interface RemoteSessionOptions {
  pairingStore: PairingStore;
  handleRequest(packet: Bytes): Promise<Bytes>;
  onChange(): void;
  onDisconnect(): void;
  createSocket?: (endpoint: string) => WebSocket;
}

/**
 * A decoded agent request and whether its response is currently being produced.
 */
type PendingRequest = Extract<ServerMessage, {type: 'agent_request'}> & {
  processing: boolean;
};

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

  /**
   * Invalidates async connection work when a newer connect or disconnect wins.
   */
  #generation = 0;

  /**
   * Serializes inbound messages so async handshakes preserve wire order.
   */
  #receiving = Promise.resolve();

  /**
   * Requests awaiting or undergoing handling, keyed by request id and attempt.
   */
  #pending = new Map<string, PendingRequest>();

  #snapshot: ConnectionSnapshot = {
    status: 'disconnected',
    serverId: null,
    sessionId: null,
    pendingRequests: 0,
    error: null,
  };

  /**
   * Create a session around its persistence, request handling, and lifecycle
   * dependencies.
   */
  constructor(options: RemoteSessionOptions) {
    this.#pairingStore = options.pairingStore;
    this.#handleRequest = options.handleRequest;
    this.#onChange = options.onChange;
    this.#onDisconnect = options.onDisconnect;
    this.#createSocket = options.createSocket ?? (endpoint => new WebSocket(endpoint));
  }

  /**
   * Return a copy of the latest display-safe connection state.
   */
  snapshot(): ConnectionSnapshot {
    return {...this.#snapshot};
  }

  /**
   * Replace any active connection and pair or authenticate with an endpoint.
   */
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
                clientId: pairing.clientId,
                credential: pairing.credential,
              }
            : {type: 'pair_request', label},
        );
      } catch (cause) {
        this.#fail(socket, cause);
      }
    });
    socket.addEventListener('message', event => {
      this.#receiving = this.#receiving
        .then(() => this.#receiveMessage(socket, event.data, label))
        .catch(cause => this.#fail(socket, cause));
    });
    socket.addEventListener('error', () =>
      this.#fail(socket, new Error('WebSocket connection failed')),
    );
    socket.addEventListener('close', () => this.#closed(socket));
  }

  /**
   * Close the active socket and discard all connection-scoped state.
   */
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

  /**
   * Disconnect and remove the credential stored for an endpoint.
   */
  async forgetPairing(endpoint: string): Promise<void> {
    const normalized = new URL(endpoint).href;
    this.disconnect();
    await this.#pairingStore.deletePairing(normalized);
  }

  /**
   * Publish agent availability and attempt buffered requests when unlocked.
   */
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

  /**
   * Decode and route one message after all earlier messages have settled.
   */
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
        this.#cancel(message.requestId, message.attempt);
        break;
      case 'paired':
      case 'authenticated':
      case 'rejected':
        throw new Error('received a handshake message after authentication');
    }
  }

  /**
   * Complete pairing or authentication for a connecting socket.
   */
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
        serverId: message.serverId,
        clientId: message.clientId,
        credential: message.credential,
        label,
        pairedAt: Date.now(),
      };
      await this.#pairingStore.savePairing(pairing);
      if (socket !== this.#socket) {
        return;
      }

      this.#pairing = pairing;
      this.#connected(socket, message.serverId, message.sessionId);
      return;
    }

    if (message.type === 'authenticated') {
      if (!this.#pairing || message.serverId !== this.#pairing.serverId) {
        throw new Error('server identity does not match the stored pairing');
      }

      this.#connected(socket, message.serverId, message.sessionId);
      return;
    }

    throw new Error('expected a handshake response');
  }

  /**
   * Return the normalized endpoint reported by the active socket.
   */
  get #endpoint(): string | null {
    return this.#socket?.url ?? null;
  }

  /**
   * Publish an authenticated connection and offer pending work for processing.
   */
  #connected(socket: WebSocket, serverId: string, sessionId: string): void {
    this.#setSnapshot({
      status: 'connected',
      serverId,
      sessionId,
      error: null,
    });
    this.#send(socket, {type: this.#ready ? 'agent_ready' : 'agent_locked'});
    this.#drain(socket);
  }

  /**
   * Buffer a unique request and attempt it immediately when the agent is ready.
   */
  #enqueue(
    socket: WebSocket,
    message: Extract<ServerMessage, {type: 'agent_request'}>,
  ): void {
    const key = requestKey(message.requestId, message.attempt);
    if (this.#pending.has(key)) {
      throw new Error('received a duplicate agent request');
    }
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      throw new Error('remote request buffer is full');
    }

    this.#pending.set(key, {
      ...message,
      processing: false,
    });
    this.#pendingChanged();

    this.#tryProcess(socket, key);
  }

  /**
   * Remove a buffered request or suppress its in-flight response.
   */
  #cancel(requestId: string, attempt: number): void {
    if (this.#pending.delete(requestKey(requestId, attempt))) {
      this.#pendingChanged();
    }
  }

  /**
   * Offer every pending request for processing.
   */
  #drain(socket: WebSocket): void {
    this.#pending.forEach((_pending, key) => this.#tryProcess(socket, key));
  }

  /**
   * Start a request when it is still pending, idle, and the agent is ready.
   */
  #tryProcess(socket: WebSocket, key: string): void {
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
          requestId: pending.requestId,
          attempt: pending.attempt,
          packet,
        });
        this.#pending.delete(key);
        this.#pendingChanged();
      })
      .catch(cause => this.#fail(socket, cause));
  }

  /**
   * Encode and send a message only through the currently open socket.
   */
  #send(socket: WebSocket, message: ClientMessage): void {
    if (socket !== this.#socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }

    socket.send(encodeClientMessage(message));
  }

  /**
   * Convert an unexpected transport failure into an error state.
   */
  #fail(socket: WebSocket, cause: unknown): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.#finish(socket, 'error', message);
  }

  /**
   * Close the current socket with a terminal status and user-facing error.
   */
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

  /**
   * Handle a peer-initiated close without affecting a replacement socket.
   */
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

  /**
   * Discard all request state and publish the changed count when necessary.
   */
  #clearPending(): void {
    if (this.#pending.size === 0) {
      return;
    }

    this.#pending.clear();
    this.#pendingChanged();
  }

  /**
   * Publish the current number of buffered or processing requests.
   */
  #pendingChanged(): void {
    this.#setSnapshot({pendingRequests: this.#pending.size});
  }

  /**
   * Merge and publish a display-safe connection-state update.
   */
  #setSnapshot(update: Partial<ConnectionSnapshot>): void {
    this.#snapshot = {...this.#snapshot, ...update};
    this.#onChange();
  }
}

function requestKey(requestId: string, attempt: number): string {
  return `${requestId}:${attempt}`;
}
