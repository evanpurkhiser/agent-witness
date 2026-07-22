// The Comlink API the worker exposes to the page, plus the serializable,
// secret-free views it returns. The typestate vault lives inside the worker;
// the page only ever sees these snapshots.

import type {Bytes} from 'app/utils/bytes';
import type {KeyType, Vault} from 'app/vault/types';
import type {CreateVaultParams, VaultState} from 'app/vault/vault';

/**
 * A passkey as shown to the page: enough to drive the WebAuthn unlock, minus
 * the wrapped master key.
 */
export interface PasskeyView {
  label: string;
  credentialId: Bytes;
  salt: Bytes;
  addedAt: number;
}

/**
 * A stored key's public metadata, safe to render.
 */
export interface KeyView {
  id: string;
  name: string;
  type: KeyType;
  fingerprint: string;
  comment: string;
  addedAt: number;
}

/**
 * The page-facing projection of a vault, with no secret-bearing fields.
 */
export interface VaultView {
  id: string;
  createdAt: number;
  passkeys: PasskeyView[];
  keys: KeyView[];
}

/**
 * A serializable snapshot of the vault state, returned by every worker call.
 */
export type VaultSnapshot =
  | {status: 'no-vault'; vault: null}
  | {status: 'locked'; vault: VaultView}
  | {status: 'unlocked'; vault: VaultView};

/**
 * The worker interface the page calls over Comlink. Every method resolves to
 * the resulting snapshot; invalid transitions reject. It will grow beyond the
 * vault (agent session, websocket) as those land.
 */
export interface WorkerApi {
  /**
   * Get the current vault snapshot.
   */
  getState(): Promise<VaultSnapshot>;
  /**
   * Create the vault from a passkey's PRF material, leaving it unlocked.
   */
  createVault(params: CreateVaultParams): Promise<VaultSnapshot>;
  /**
   * Unlock the vault with a passkey's PRF output.
   */
  unlock(prfOutput: Bytes): Promise<VaultSnapshot>;
  /**
   * Lock the vault, dropping the resident master key.
   */
  lock(): Promise<VaultSnapshot>;
  /**
   * Add a passphrase-free SSH private key to the unlocked vault.
   */
  addKey(pem: string, name?: string): Promise<VaultSnapshot>;
  /**
   * Remove a key by id.
   */
  removeKey(keyId: string): Promise<VaultSnapshot>;
  /**
   * Delete the vault and all its keys.
   */
  destroy(): Promise<VaultSnapshot>;
}

/**
 * Project a stored vault into its secret-free page view.
 */
export function toView(vault: Vault): VaultView {
  return {
    id: vault.id,
    createdAt: vault.createdAt,
    passkeys: vault.passkeys.map(passkey => ({
      label: passkey.label,
      credentialId: passkey.credentialId,
      salt: passkey.salt,
      addedAt: passkey.addedAt,
    })),
    keys: vault.keys.map(key => ({
      id: key.id,
      name: key.name,
      type: key.type,
      fingerprint: key.fingerprint,
      comment: key.comment,
      addedAt: key.addedAt,
    })),
  };
}

/**
 * Build the page-facing snapshot for a vault state.
 */
export function toSnapshot(state: VaultState): VaultSnapshot {
  if (state.status === 'no-vault') {
    return {status: 'no-vault', vault: null};
  }
  if (state.status === 'locked') {
    return {status: 'locked', vault: toView(state.vault)};
  }
  return {status: 'unlocked', vault: toView(state.vault)};
}
