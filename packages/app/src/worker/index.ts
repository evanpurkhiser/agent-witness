// The dedicated worker: it owns the typestate vault and exposes a flat,
// serializable API to the page over Comlink. The vault's `CryptoKey`s never
// leave the worker; callers only receive snapshots.

import * as Comlink from 'comlink';

import {
  type RemoteRequest,
  type RemoteRequestOutcome,
  RemoteSession,
  type PushSubscriptionRegistration,
} from 'app/remote/session';
import {
  AgentMessage,
  handleAgentRequest,
  inspectAgentRequest,
  parseSignRequest,
  readFrame,
} from 'app/ssh/agent';
import type {Bytes} from 'app/utils/bytes';
import {bytesEqual} from 'app/utils/bytes';
import {
  MAX_STORED_AGENT_EVENTS,
  openVaultStore,
  type VaultStore,
} from 'app/vault/storage';
import {
  assertVaultStatus,
  type CreateVaultParams,
  openVault,
  type VaultState,
} from 'app/vault/vault';

import {
  type AuthorizationRequestView,
  type SettledAuthorizationView,
  type StateListener,
  toSnapshot,
  type WorkerApi,
  type WorkerSnapshot,
} from './api';
import type {AgentEvent, NewAgentEvent, VaultLockReason} from './events';

const MAX_SETTLED_AUTHORIZATIONS = 64;

/**
 * Owns the vault and remote agent session, exposing only display-safe snapshots
 * and control operations to the page.
 */
class WorkerSession implements WorkerApi {
  #store: VaultStore | null = null;
  #state: VaultState | null = null;
  #events: AgentEvent[] | null = null;
  #eventWrite: Promise<void> = Promise.resolve();
  #listener: StateListener | null = null;
  #settledAuthorizations = new Map<string, SettledAuthorizationView>();
  readonly #remote = new RemoteSession({
    pairingStore: {
      loadPairing: endpoint =>
        this.#currentStore().then(store => store.loadPairing(endpoint)),
      savePairing: pairing =>
        this.#currentStore().then(store => store.savePairing(pairing)),
      deletePairing: endpoint =>
        this.#currentStore().then(store => store.deletePairing(endpoint)),
    },
    handleRequest: packet => this.#handleRequest(packet),
    canProcessBeforeReady: request =>
      inspectAgentRequest(request.packet).type === 'identities',
    onRequestSettled: (request, outcome) =>
      this.#recordSettledAuthorization(request, outcome),
    onChange: () => void this.#publish(),
    onDisconnect: () => void this.#handleDisconnect(),
    onRequestPending: request => void this.#recordPendingRequest(request),
    onRequestProcessing: request => void this.#recordSigningRequest(request),
    onRequestClosed: request => void this.#recordClosedRequest(request),
  });

  async #currentStore(): Promise<VaultStore> {
    this.#store ??= await openVaultStore();
    return this.#store;
  }

  /**
   * Lazily open the vault from storage on first use.
   */
  async #current(): Promise<VaultState> {
    this.#state ??= await openVault(await this.#currentStore());
    return this.#state;
  }

  async #currentEvents(): Promise<AgentEvent[]> {
    this.#events ??= await (await this.#currentStore()).loadAgentEvents();
    return this.#events;
  }

  async #snapshot(): Promise<WorkerSnapshot> {
    const state = await this.#current();

    return {
      vault: toSnapshot(state),
      connection: this.#remote.snapshot(),
      events: [...(await this.#currentEvents())],
      authorizationRequests: this.#authorizationRequests(state),
      settledAuthorizations: [...this.#settledAuthorizations.values()],
    };
  }

  #recordSettledAuthorization(
    request: RemoteRequest,
    status: RemoteRequestOutcome,
  ): void {
    if (!signingRequest(request.packet)) {
      return;
    }

    const settled = {
      id: request.requestId,
      attempt: request.attempt,
      status,
      settledAt: Date.now(),
    };
    this.#settledAuthorizations.set(requestKey(request), settled);

    if (this.#settledAuthorizations.size <= MAX_SETTLED_AUTHORIZATIONS) {
      return;
    }

    const oldest = this.#settledAuthorizations.keys().next().value;
    if (oldest) {
      this.#settledAuthorizations.delete(oldest);
    }
  }

  #authorizationRequests(state: VaultState): AuthorizationRequestView[] {
    if (state.status === 'no-vault') {
      return [];
    }

    return this.#remote.pendingRequests().flatMap(request => {
      const signing = signingRequest(request.packet);
      if (!signing) {
        return [];
      }

      const key = state.vault.keys.find(candidate =>
        bytesEqual(candidate.publicKey, signing.keyBlob),
      );
      if (!key) {
        return [];
      }

      return [
        {
          id: request.requestId,
          attempt: request.attempt,
          requestedAt: request.requestedAt,
          deadline: request.deadline,
          key: {id: key.id, name: key.name},
        },
      ];
    });
  }

  async #publish(): Promise<WorkerSnapshot> {
    const snapshot = await this.#snapshot();
    this.#listener?.(snapshot);
    return snapshot;
  }

  async #handleRequest(packet: Bytes): Promise<Bytes> {
    const request = readFrame(packet);
    if (!request || request.consumed !== packet.length) {
      throw new Error('received an invalid SSH-agent packet');
    }

    const state = await this.#current();
    return handleAgentRequest(request.payload, state.agentBackend());
  }

  #record(event: NewAgentEvent): Promise<void> {
    const write = this.#eventWrite.then(() => this.#appendEvent(event));
    this.#eventWrite = write.catch(() => undefined);
    return write;
  }

  async #appendEvent(event: NewAgentEvent): Promise<void> {
    const recorded = {...event, id: crypto.randomUUID(), at: Date.now()} as AgentEvent;
    const events = await this.#currentEvents();
    events.push(recorded);
    if (events.length > MAX_STORED_AGENT_EVENTS) {
      events.splice(0, events.length - MAX_STORED_AGENT_EVENTS);
    }

    await (await this.#currentStore()).appendAgentEvent(recorded).catch(() => undefined);
    await this.#publish();
  }

  async #recordPendingRequest(request: RemoteRequest): Promise<void> {
    const signing = signingRequest(request.packet);
    if (!signing) {
      return;
    }

    await this.#record({
      type: 'request_pending',
      requestId: request.requestId,
      bytes: signing.data.length,
    });
  }

  async #recordSigningRequest(request: RemoteRequest): Promise<void> {
    const signing = signingRequest(request.packet);
    const state = await this.#current();
    if (!signing || state.status === 'no-vault') {
      return;
    }

    const key = state.vault.keys.find(candidate =>
      bytesEqual(candidate.publicKey, signing.keyBlob),
    );
    if (!key) {
      return;
    }

    await this.#record({
      type: 'request_signing',
      requestId: request.requestId,
      bytes: signing.data.length,
      fingerprint: key.fingerprint,
    });
  }

  async #recordClosedRequest(request: RemoteRequest): Promise<void> {
    if (!signingRequest(request.packet)) {
      return;
    }

    await this.#record({type: 'request_closed', requestId: request.requestId});
  }

  async #lock(reason: VaultLockReason): Promise<void> {
    if (this.#state?.status !== 'unlocked') {
      return;
    }

    this.#state = this.#state.lock();
    this.#remote.setReady(false);
    await this.#record({type: 'vault_locked', reason});
  }

  async #handleDisconnect(): Promise<void> {
    await this.#lock('disconnected');
    await this.#publish();
  }

  getState(): Promise<WorkerSnapshot> {
    return this.#snapshot();
  }

  subscribe(listener: StateListener): Promise<WorkerSnapshot> {
    this.#listener = listener;
    return this.#snapshot();
  }

  async connect(endpoint: string, label: string): Promise<WorkerSnapshot> {
    const state = await this.#current();
    this.#remote.setReady(state.status === 'unlocked');
    await this.#remote.connect(endpoint, label);
    return this.#snapshot();
  }

  async setConnectionActive(active: boolean): Promise<WorkerSnapshot> {
    if (!active) {
      await this.#lock('backgrounded');
    }

    this.#remote.setActive(active);
    return this.#snapshot();
  }

  async forgetPairing(endpoint: string): Promise<WorkerSnapshot> {
    await this.#remote.forgetPairing(endpoint);
    return this.#snapshot();
  }

  registerPushSubscription(
    subscription: PushSubscriptionRegistration,
  ): Promise<WorkerSnapshot> {
    this.#remote.registerPushSubscription(subscription);
    return this.#snapshot();
  }

  async createVault(params: CreateVaultParams): Promise<WorkerSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'no-vault');
    this.#state = await state.createVault(params);
    await this.#record({type: 'vault_unlocked'});
    this.#remote.setReady(true);
    return this.#publish();
  }

  async unlock(prfOutput: Bytes): Promise<WorkerSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'locked');
    this.#state = await state.unlock(prfOutput);
    await this.#record({type: 'vault_unlocked'});
    this.#remote.setReady(true);
    return this.#publish();
  }

  async lock(): Promise<WorkerSnapshot> {
    await this.#current();
    await this.#lock('manual');
    return this.#snapshot();
  }

  async addKey(pem: string, name?: string): Promise<WorkerSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'unlocked');
    this.#state = await state.addKey(pem, name);
    return this.#publish();
  }

  async removeKey(keyId: string): Promise<WorkerSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'locked', 'unlocked');
    this.#state = await state.removeKey(keyId);
    return this.#publish();
  }

  async destroy(): Promise<WorkerSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'locked', 'unlocked');
    this.#state = await state.destroy();
    this.#remote.setReady(false);
    return this.#publish();
  }
}

function signingRequest(packet: Bytes) {
  const frame = readFrame(packet);
  if (
    !frame ||
    frame.consumed !== packet.length ||
    frame.payload[0] !== AgentMessage.SignRequest
  ) {
    return null;
  }

  try {
    return parseSignRequest(frame.payload);
  } catch {
    return null;
  }
}

function requestKey(request: Pick<RemoteRequest, 'requestId' | 'attempt'>): string {
  return `${request.requestId}:${request.attempt}`;
}

Comlink.expose(new WorkerSession());
