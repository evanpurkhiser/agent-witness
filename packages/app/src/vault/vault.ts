// Vault operations as a typestate machine. The vault is one of three states —
// NoVault, LockedVault, UnlockedVault — each exposing only the transitions valid
// from it, so e.g. `addKey` is reachable only once you hold an `UnlockedVault`.
// States are immutable; every transition returns the next state.

import {
  deriveWrappingKey,
  generateMasterKey,
  unwrapMasterKey,
  wrapMasterKey,
} from 'app/crypto/master-key';
import {importSSHKey, wrapSSHKey} from 'app/crypto/ssh';
import type {AgentBackend} from 'app/ssh/agent';
import {sshFingerprint} from 'app/ssh/fingerprint';
import {parseOpenSSHPrivateKey} from 'app/ssh/key';
import type {Bytes} from 'app/utils/bytes';

import {createAgentBackend} from './agent-backend';
import type {VaultStore} from './storage';
import type {PrivateKeyMeta, Vault} from './types';

const VAULT_VERSION = 1;

/**
 * Base class for vault operation failures.
 */
export class VaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/**
 * No enrolled passkey could unlock the vault with the supplied PRF output.
 */
export class WrongPasskey extends VaultError {}

/**
 * A key with the same fingerprint is already in the vault.
 */
export class DuplicateKey extends VaultError {}

/**
 * The material needed to create the vault, produced by the page's WebAuthn + PRF
 * flow.
 */
export interface CreateVaultParams {
  prfOutput: Bytes;
  credentialId: Bytes;
  salt: Bytes;
  label: string;
}

/**
 * No vault exists yet. The only move is to create one.
 */
export interface NoVault {
  readonly status: 'no-vault';
  /**
   * Create the single vault, leaving it unlocked.
   */
  createVault(params: CreateVaultParams): Promise<UnlockedVault>;
}

/**
 * Functionality shared by any loaded vault, whether locked or unlocked. `Self`
 * is the concrete state, so `removeKey` returns that same state.
 */
export interface LoadedVault<Self> {
  readonly vault: Vault;
  /**
   * Remove a key and its blob. Needs no master key, so it works in any state.
   */
  removeKey(keyId: string): Promise<Self>;
  /**
   * Delete the vault and every stored key.
   */
  destroy(): Promise<NoVault>;
}

/**
 * A vault exists but its master key is not resident.
 */
export interface LockedVault extends LoadedVault<LockedVault> {
  readonly status: 'locked';
  /**
   * Recover the master key from any enrolled passkey the PRF output can unwrap.
   * Rejects with `WrongPasskey` if none match.
   */
  unlock(prfOutput: Bytes): Promise<UnlockedVault>;
}

/**
 * A vault with its master key resident. Keys can be added and signed with.
 */
export interface UnlockedVault extends LoadedVault<UnlockedVault> {
  readonly status: 'unlocked';
  /**
   * Parse, encrypt, and store a passphrase-free SSH private key. Rejects with
   * `DuplicateKey` if the key is already present.
   */
  addKey(pem: string, name?: string): Promise<UnlockedVault>;
  /**
   * An ssh-agent backend serving this vault's keys. Available only while
   * unlocked, since signing needs the resident master key.
   */
  agentBackend(): AgentBackend;
  /**
   * Drop the resident master key, returning to the locked state.
   */
  lock(): LockedVault;
}

/**
 * Any vault state.
 */
export type VaultState = NoVault | LockedVault | UnlockedVault;

/**
 * Assert the vault is in one of the given states, narrowing it to match, and
 * throw a `VaultError` otherwise.
 */
export function assertVaultStatus<S extends VaultState['status']>(
  state: VaultState,
  ...statuses: readonly S[]
): asserts state is Extract<VaultState, {status: S}> {
  if (!(statuses as readonly string[]).includes(state.status)) {
    throw new VaultError(`vault is ${state.status}, expected ${statuses.join(' or ')}`);
  }
}

/**
 * Build and persist a new vault, returning it with its resident master key.
 */
async function createNewVault(
  store: VaultStore,
  params: CreateVaultParams,
): Promise<{vault: Vault; masterKey: CryptoKey}> {
  const wrappingKey = await deriveWrappingKey(params.prfOutput, params.salt);
  const masterKey = await generateMasterKey();
  const wrappedMasterKey = await wrapMasterKey(masterKey, wrappingKey);
  const now = Date.now();

  const vault: Vault = {
    id: globalThis.crypto.randomUUID(),
    version: VAULT_VERSION,
    createdAt: now,
    passkeys: [
      {
        label: params.label,
        credentialId: params.credentialId,
        salt: params.salt,
        wrappedMasterKey,
        addedAt: now,
      },
    ],
    keys: [],
  };

  await store.save(vault);
  return {vault, masterKey};
}

/**
 * Recover the master key from whichever enrolled passkey the PRF output unwraps.
 */
async function recoverMasterKey(vault: Vault, prfOutput: Bytes): Promise<CryptoKey> {
  try {
    return await Promise.any(
      vault.passkeys.map(async passkey =>
        unwrapMasterKey(
          passkey.wrappedMasterKey,
          await deriveWrappingKey(prfOutput, passkey.salt),
        ),
      ),
    );
  } catch {
    throw new WrongPasskey('could not unlock with the provided passkey');
  }
}

/**
 * Add a parsed, encrypted key to the vault, returning the updated metadata.
 */
async function storeAddKey(
  store: VaultStore,
  vault: Vault,
  masterKey: CryptoKey,
  pem: string,
  name?: string,
): Promise<Vault> {
  const parsed = parseOpenSSHPrivateKey(pem);
  const publicKey = parsed.publicBlob.slice();
  const fingerprint = await sshFingerprint(publicKey);

  if (vault.keys.some(key => key.fingerprint === fingerprint)) {
    throw new DuplicateKey('this key is already in the vault');
  }

  const id = globalThis.crypto.randomUUID();
  const imported = await importSSHKey(parsed);
  const data = await wrapSSHKey(imported, parsed.type, masterKey, id);

  const meta: PrivateKeyMeta = {
    id,
    name: name ?? parsed.comment,
    type: parsed.type,
    publicKey,
    fingerprint,
    comment: parsed.comment,
    addedAt: Date.now(),
  };

  const updated: Vault = {...vault, keys: [...vault.keys, meta]};
  await store.save(updated, {put: {keyId: id, data}});
  return updated;
}

/**
 * Remove a key from the vault, returning the updated metadata (unchanged if the
 * key was absent).
 */
async function storeRemoveKey(
  store: VaultStore,
  vault: Vault,
  keyId: string,
): Promise<Vault> {
  const keys = vault.keys.filter(key => key.id !== keyId);
  if (keys.length === vault.keys.length) {
    return vault;
  }

  const updated: Vault = {...vault, keys};
  await store.save(updated, {remove: keyId});
  return updated;
}

/**
 * The state for when no vault has been created.
 */
function noVault(store: VaultStore): NoVault {
  return {
    status: 'no-vault',
    async createVault(params) {
      const {vault, masterKey} = await createNewVault(store, params);
      return unlockedVault(store, vault, masterKey);
    },
  };
}

/**
 * The state for an existing but locked vault.
 */
function lockedVault(store: VaultStore, vault: Vault): LockedVault {
  return {
    status: 'locked',
    vault,
    async unlock(prfOutput) {
      return unlockedVault(store, vault, await recoverMasterKey(vault, prfOutput));
    },
    async removeKey(keyId) {
      return lockedVault(store, await storeRemoveKey(store, vault, keyId));
    },
    async destroy() {
      await store.destroy();
      return noVault(store);
    },
  };
}

/**
 * The state for an unlocked vault with its master key resident.
 */
function unlockedVault(
  store: VaultStore,
  vault: Vault,
  masterKey: CryptoKey,
): UnlockedVault {
  return {
    status: 'unlocked',
    vault,
    async addKey(pem, name) {
      const updated = await storeAddKey(store, vault, masterKey, pem, name);
      return unlockedVault(store, updated, masterKey);
    },
    async removeKey(keyId) {
      return unlockedVault(store, await storeRemoveKey(store, vault, keyId), masterKey);
    },
    agentBackend() {
      return createAgentBackend(store, vault, masterKey);
    },
    lock() {
      return lockedVault(store, vault);
    },
    async destroy() {
      await store.destroy();
      return noVault(store);
    },
  };
}

/**
 * Open the vault from storage, returning whichever state it is in: `NoVault` if
 * none exists yet, otherwise `LockedVault`.
 */
export async function openVault(store: VaultStore): Promise<NoVault | LockedVault> {
  const vault = await store.loadVault();
  return vault ? lockedVault(store, vault) : noVault(store);
}
