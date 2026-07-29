// The dedicated worker: it owns the typestate vault and exposes a flat,
// serializable API to the page over Comlink. The vault's `CryptoKey`s never
// leave the worker; callers only receive snapshots.

// REVIEW: Let's create a worker module and move this into there, along with the test and worker-api

import * as Comlink from 'comlink';

import {RemoteSession} from 'app/remote/session';
import {handleAgentRequest, readFrame} from 'app/ssh/agent';
import type {Bytes} from 'app/utils/bytes';
import {openVaultStore, type VaultStore} from 'app/vault/storage';
import {
  assertVaultStatus,
  type CreateVaultParams,
  openVault,
  type VaultState,
} from 'app/vault/vault';

import {
  type StateListener,
  toSnapshot,
  type WorkerApi,
  type WorkerSnapshot,
} from './worker-api';

/**
 * Owns the vault and remote agent session, exposing only display-safe snapshots
 * and control operations to the page.
 */
class WorkerSession implements WorkerApi {
  #store: VaultStore | null = null;
  #state: VaultState | null = null;
  #listener: StateListener | null = null;
  readonly #remote = new RemoteSession({
    pairingStore: {
      loadPairing: endpoint =>
        this.#currentStore().then(store => store.loadPairing(endpoint)),
      savePairing: pairing =>
        this.#currentStore().then(store => store.savePairing(pairing)),
    },
    handleRequest: packet => this.#handleRequest(packet),
    onChange: () => void this.#publish(),
    onDisconnect: () => {
      // REVIEW: Kind of feel like we can move this to a `#handleDisconnect` and make it `void this.#handleDisconnect()`.
      if (this.#state?.status === 'unlocked') {
        this.#state = this.#state.lock();
      }
      void this.#publish();
    },
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

  async #snapshot(): Promise<WorkerSnapshot> {
    return {
      vault: toSnapshot(await this.#current()),
      connection: this.#remote.snapshot(),
    };
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
    assertVaultStatus(state, 'unlocked');
    return handleAgentRequest(request.payload, state.agentBackend());
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

  disconnect(): Promise<WorkerSnapshot> {
    this.#remote.disconnect();
    return this.#snapshot();
  }

  async createVault(params: CreateVaultParams): Promise<WorkerSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'no-vault');
    this.#state = await state.createVault(params);
    this.#remote.setReady(true);
    return this.#publish();
  }

  async unlock(prfOutput: Bytes): Promise<WorkerSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'locked');
    this.#state = await state.unlock(prfOutput);
    this.#remote.setReady(true);
    return this.#publish();
  }

  async lock(): Promise<WorkerSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'unlocked');
    this.#state = state.lock();
    this.#remote.setReady(false);
    return this.#publish();
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

Comlink.expose(new WorkerSession());
