// The Comlink API the worker exposes to the page, plus the serializable,
// secret-free views it returns. The typestate vault lives inside the worker;
// the page only ever sees these snapshots.

import type {ConnectionSnapshot, PushSubscriptionRegistration} from 'app/remote/session';
import type {Bytes} from 'app/utils/bytes';
import type {KeyType, Vault} from 'app/vault/types';
import type {CreateVaultParams, VaultState} from 'app/vault/vault';

import type {AgentEvent} from './events';

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
 * The complete display-safe state published by the worker.
 */
export interface WorkerSnapshot {
  vault: VaultSnapshot;
  connection: ConnectionSnapshot;
  events: AgentEvent[];
}

export type StateListener = (snapshot: WorkerSnapshot) => void;

/**
 * The worker interface the page calls over Comlink. Every method resolves to
 * the resulting snapshot; invalid transitions reject. Incoming network events
 * are published through the single page subscription.
 */
export interface WorkerApi {
  /**
   * Get the current worker snapshot.
   */
  getState(): Promise<WorkerSnapshot>;
  /**
   * Receive snapshots produced by asynchronous connection and request events.
   */
  subscribe(listener: StateListener): Promise<WorkerSnapshot>;
  /**
   * Connect to an agent-witness WebSocket endpoint.
   */
  connect(endpoint: string, label: string): Promise<WorkerSnapshot>;
  /**
   * Reconcile the desired connection with page visibility and network state.
   */
  setConnectionActive(active: boolean): Promise<WorkerSnapshot>;
  /**
   * Remove the stored credential for one server without changing the vault.
   */
  forgetPairing(endpoint: string): Promise<WorkerSnapshot>;
  /**
   * Send the browser's current push subscription to the paired server.
   */
  registerPushSubscription(
    subscription: PushSubscriptionRegistration,
  ): Promise<WorkerSnapshot>;
  /**
   * Create the vault from a passkey's PRF material, leaving it unlocked.
   */
  createVault(params: CreateVaultParams): Promise<WorkerSnapshot>;
  /**
   * Unlock the vault with a passkey's PRF output.
   */
  unlock(prfOutput: Bytes): Promise<WorkerSnapshot>;
  /**
   * Lock the vault, dropping the resident master key.
   */
  lock(): Promise<WorkerSnapshot>;
  /**
   * Add a passphrase-free SSH private key to the unlocked vault.
   */
  addKey(pem: string, name?: string): Promise<WorkerSnapshot>;
  /**
   * Remove a key by id.
   */
  removeKey(keyId: string): Promise<WorkerSnapshot>;
  /**
   * Delete the vault and all its keys.
   */
  destroy(): Promise<WorkerSnapshot>;
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
