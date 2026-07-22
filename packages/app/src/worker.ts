// The dedicated worker: it owns the typestate vault and exposes a flat,
// serializable API to the page over Comlink. The vault's `CryptoKey`s never
// leave the worker; callers only receive snapshots.

import * as Comlink from 'comlink';

import type {Bytes} from 'app/utils/bytes';
import {openVaultStore} from 'app/vault/storage';
import {
  assertVaultStatus,
  type CreateVaultParams,
  openVault,
  type VaultState,
} from 'app/vault/vault';
import {toSnapshot, type VaultSnapshot, type WorkerApi} from 'app/worker-api';

/**
 * Holds the current vault state and dispatches page commands to the valid
 * transition for that state, rejecting invalid ones.
 */
class VaultSession implements WorkerApi {
  #state: VaultState | null = null;

  /**
   * Lazily open the vault from storage on first use.
   */
  async #current(): Promise<VaultState> {
    this.#state ??= await openVault(await openVaultStore());
    return this.#state;
  }

  async getState(): Promise<VaultSnapshot> {
    return toSnapshot(await this.#current());
  }

  async createVault(params: CreateVaultParams): Promise<VaultSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'no-vault');
    this.#state = await state.createVault(params);
    return toSnapshot(this.#state);
  }

  async unlock(prfOutput: Bytes): Promise<VaultSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'locked');
    this.#state = await state.unlock(prfOutput);
    return toSnapshot(this.#state);
  }

  async lock(): Promise<VaultSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'unlocked');
    this.#state = state.lock();
    return toSnapshot(this.#state);
  }

  async addKey(pem: string, name?: string): Promise<VaultSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'unlocked');
    this.#state = await state.addKey(pem, name);
    return toSnapshot(this.#state);
  }

  async removeKey(keyId: string): Promise<VaultSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'locked', 'unlocked');
    this.#state = await state.removeKey(keyId);
    return toSnapshot(this.#state);
  }

  async destroy(): Promise<VaultSnapshot> {
    const state = await this.#current();
    assertVaultStatus(state, 'locked', 'unlocked');
    this.#state = await state.destroy();
    return toSnapshot(this.#state);
  }
}

Comlink.expose(new VaultSession());
