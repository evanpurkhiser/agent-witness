// The vault master key envelope. A passkey's PRF output derives a wrapping key
// (HKDF) that encrypts the shared master key; the master key in turn encrypts
// each SSH private key (see crypto/ssh.ts).

import type {Bytes} from 'app/utils/bytes';

import {seal, unseal} from './utils';

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

/**
 * Derive the vault's wrapping key from a passkey's PRF output and salt via
 * HKDF-SHA256. The PRF output is already high-entropy, so no slow KDF is needed.
 */
export async function deriveWrappingKey(
  prfOutput: Bytes,
  salt: Bytes,
): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('agent-witness/wrap')},
    base,
    {name: 'AES-GCM', length: 256},
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/**
 * Generate a new vault master key. Extractable only so it can be wrapped for
 * storage; the unwrapped copies held at runtime are non-extractable.
 */
export function generateMasterKey(): Promise<CryptoKey> {
  return subtle.generateKey({name: 'AES-GCM', length: 256}, true, [
    'wrapKey',
    'unwrapKey',
  ]);
}

/**
 * Wrap the master key under a passkey's wrapping key for storage in
 * `EnrolledPasskey.wrappedMasterKey`.
 */
export function wrapMasterKey(master: CryptoKey, wrappingKey: CryptoKey): Promise<Bytes> {
  return seal('raw', master, wrappingKey);
}

/**
 * Recover the master key from its wrapped blob as a non-extractable key.
 */
export function unwrapMasterKey(blob: Bytes, wrappingKey: CryptoKey): Promise<CryptoKey> {
  return unseal('raw', blob, wrappingKey, {name: 'AES-GCM', length: 256}, [
    'wrapKey',
    'unwrapKey',
  ]);
}
