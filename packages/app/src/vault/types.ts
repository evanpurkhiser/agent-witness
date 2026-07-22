// Persisted vault data model — the shapes stored in IndexedDB. The worker owns
// these and never exposes secret-bearing fields to the page. Byte fields are
// Uint8Array (IndexedDB and postMessage structured-clone them directly).

import type {ParsedKey} from 'app/ssh/key';
import type {Bytes} from 'app/utils/bytes';

/**
 * The SSH key algorithms the vault supports, mirroring the parser's output.
 */
export type KeyType = ParsedKey['type'];

/**
 * One passkey enrolled to unlock the vault. Each passkey derives its own
 * wrapping key (from its PRF output + salt) that encrypts the shared master
 * key, so any enrolled passkey can unlock the vault.
 */
export interface EnrolledPasskey {
  /**
   * User-facing label for this passkey.
   */
  label: string;
  /**
   * WebAuthn credential id, used as `allowCredentials` when unlocking.
   */
  credentialId: Bytes;
  /**
   * Random salt used as both the PRF eval input and the HKDF salt.
   */
  salt: Bytes;
  /**
   * The master key encrypted under this passkey's wrapping key, formatted as
   * `nonce(12) || AES-GCM ciphertext`.
   */
  wrappedMasterKey: Bytes;
  /**
   * Unix epoch millis when this passkey was enrolled.
   */
  addedAt: number;
}

/**
 * Public metadata for one stored SSH key. Never includes private material — the
 * encrypted private key lives separately in `EncryptedKey`, keyed by `id`.
 */
export interface PrivateKeyMeta {
  /**
   * Stable UUID, also used as the encrypted-blob key and the AEAD associated
   * data that binds a ciphertext to its metadata.
   */
  id: string;
  /**
   * User-facing label, defaulting to the key's SSH comment.
   */
  name: string;
  /**
   * The key's SSH algorithm.
   */
  type: KeyType;
  /**
   * SSH wire-format public key blob (non-secret).
   */
  publicKey: Bytes;
  /**
   * OpenSSH fingerprint, e.g. `SHA256:…`.
   */
  fingerprint: string;
  /**
   * The key's original SSH comment.
   */
  comment: string;
  /**
   * Unix epoch millis when the key was added.
   */
  addedAt: number;
}

/**
 * The vault record: plaintext metadata that drives the UI, plus the wrapped
 * master key held per enrolled passkey. There is at most one vault.
 */
export interface Vault {
  id: string;
  /**
   * Schema version, for future migrations.
   */
  version: number;
  /**
   * Passkeys enrolled to unlock the vault (always at least one).
   */
  passkeys: EnrolledPasskey[];
  /**
   * The SSH keys stored in the vault.
   */
  keys: PrivateKeyMeta[];
  /**
   * Unix epoch millis when the vault was created.
   */
  createdAt: number;
}

/**
 * An encrypted SSH private key, stored apart from metadata and keyed by the
 * owning `PrivateKeyMeta.id`. Format is `nonce(12) || AES-GCM ciphertext`, with
 * the key id bound as AEAD associated data.
 */
export interface EncryptedKey {
  keyId: string;
  data: Bytes;
}
