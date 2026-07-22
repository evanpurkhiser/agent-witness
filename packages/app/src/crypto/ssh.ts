// Encrypting SSH private keys into and out of the vault. Keys are imported from
// their parsed form, wrapped under the master key (see crypto/master-key.ts),
// and recovered as non-extractable signing keys.

import {seal, unseal} from 'app/crypto/utils';
import type {ParsedKey} from 'app/ssh/key';
import {b64urlencode, concatBytes, type Bytes} from 'app/utils/bytes';

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

type KeyType = ParsedKey['type'];
type RsaHash = 'SHA-256' | 'SHA-512';

/**
 * Fixed PKCS#8 DER prefix for an Ed25519 private key, wrapping the 32-byte seed.
 */
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22,
  0x04, 0x20,
]);

/**
 * The wrapKey/unwrapKey serialization format for a given key type.
 */
function keyFormat(type: KeyType): 'pkcs8' | 'jwk' {
  return type === 'ssh-ed25519' ? 'pkcs8' : 'jwk';
}

/**
 * The WebCrypto import parameters for a given key type. RSA binds its hash at
 * import time, so the desired signing hash must be supplied.
 */
function importParamsFor(
  type: KeyType,
  rsaHash: RsaHash,
): AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams {
  switch (type) {
    case 'ssh-ed25519':
      return {name: 'Ed25519'};
    case 'ecdsa-sha2-nistp256':
      return {name: 'ECDSA', namedCurve: 'P-256'};
    case 'ssh-rsa':
      return {name: 'RSASSA-PKCS1-v1_5', hash: rsaHash};
  }
}

/**
 * Left-pad (or trim) a big-endian magnitude to an exact byte length, as JWK
 * fixed-width fields require.
 */
function fixedWidth(b: Uint8Array, length: number): Uint8Array {
  if (b.length >= length) {
    return b.subarray(b.length - length);
  }
  const out = new Uint8Array(length);
  out.set(b, length - b.length);
  return out;
}

/**
 * Parse a big-endian byte magnitude into a bigint.
 */
function toBigInt(b: Uint8Array): bigint {
  return Array.from(b).reduce((n, x) => (n << 8n) | BigInt(x), 0n);
}

/**
 * Serialize a non-negative bigint to a minimal big-endian byte magnitude.
 */
function fromBigInt(n: bigint): Uint8Array {
  const hex = n.toString(16);
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  return Uint8Array.from(padded.match(/../g) ?? [], h => parseInt(h, 16));
}

/**
 * Build the private JWK for an RSA key, computing the CRT exponents OpenSSH does
 * not store (dp, dq) from d, p, q.
 */
function rsaJwk(key: Extract<ParsedKey, {type: 'ssh-rsa'}>): JsonWebKey {
  const d = toBigInt(key.d);
  const p = toBigInt(key.p);
  const q = toBigInt(key.q);
  return {
    kty: 'RSA',
    n: b64urlencode(key.n),
    e: b64urlencode(key.e),
    d: b64urlencode(key.d),
    p: b64urlencode(key.p),
    q: b64urlencode(key.q),
    dp: b64urlencode(fromBigInt(d % (p - 1n))),
    dq: b64urlencode(fromBigInt(d % (q - 1n))),
    qi: b64urlencode(key.iqmp),
    ext: true,
  };
}

/**
 * Build the private JWK for an ECDSA P-256 key from its uncompressed point and
 * scalar.
 */
function ecdsaJwk(key: Extract<ParsedKey, {type: 'ecdsa-sha2-nistp256'}>): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlencode(key.point.subarray(1, 33)),
    y: b64urlencode(key.point.subarray(33, 65)),
    d: b64urlencode(fixedWidth(key.d, 32)),
    ext: true,
  };
}

/**
 * Import a parsed SSH private key as an extractable signing key, ready to be
 * wrapped under the master key. Extractable because wrapping must export it;
 * it is never exposed outside the crypto layer.
 */
export function importSSHKey(key: ParsedKey): Promise<CryptoKey> {
  if (key.type === 'ssh-ed25519') {
    return subtle.importKey(
      'pkcs8',
      concatBytes(ED25519_PKCS8_PREFIX, key.seed),
      {name: 'Ed25519'},
      true,
      ['sign'],
    );
  }
  if (key.type === 'ssh-rsa') {
    return subtle.importKey(
      'jwk',
      rsaJwk(key),
      importParamsFor(key.type, 'SHA-256'),
      true,
      ['sign'],
    );
  }
  return subtle.importKey(
    'jwk',
    ecdsaJwk(key),
    importParamsFor(key.type, 'SHA-256'),
    true,
    ['sign'],
  );
}

/**
 * Encrypt an imported SSH signing key under the master key, binding it to its
 * key id as AEAD associated data. The result is stored as `EncryptedKey.data`.
 */
export function wrapSSHKey(
  sshKey: CryptoKey,
  type: KeyType,
  master: CryptoKey,
  keyId: string,
): Promise<Bytes> {
  return seal(keyFormat(type), sshKey, master, te.encode(keyId));
}

/**
 * Recover a stored SSH key as a non-extractable signing key. `keyId` must match
 * the id the blob was wrapped with, and `rsaHash` selects the RSA signing hash.
 */
export function unwrapSSHKey(
  blob: Bytes,
  type: KeyType,
  master: CryptoKey,
  keyId: string,
  rsaHash: RsaHash = 'SHA-256',
): Promise<CryptoKey> {
  return unseal(
    keyFormat(type),
    blob,
    master,
    importParamsFor(type, rsaHash),
    ['sign'],
    te.encode(keyId),
  );
}
