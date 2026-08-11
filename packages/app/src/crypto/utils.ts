// Shared WebCrypto primitives for the vault's envelope encryption: AES-GCM
// seal/unseal of one CryptoKey under another. Blob format is
// `nonce(12) || AES-GCM ciphertext`.

import {concatBytes, random, type Bytes} from 'app/utils/bytes';

const subtle = globalThis.crypto.subtle;

/**
 * Encrypt (wrap) a CryptoKey under `wrappingKey`, returning `nonce || ciphertext`
 * with optional AEAD associated data.
 */
export async function seal(
  format: KeyFormat,
  key: CryptoKey,
  wrappingKey: CryptoKey,
  additionalData?: Bytes,
): Promise<Bytes> {
  const iv = random(12);
  const algorithm: AesGcmParams = additionalData
    ? {name: 'AES-GCM', iv, additionalData}
    : {name: 'AES-GCM', iv};
  const ciphertext = await subtle.wrapKey(format, key, wrappingKey, algorithm);
  return concatBytes(iv, new Uint8Array(ciphertext));
}

/**
 * Decrypt (unwrap) a `nonce || ciphertext` blob back into a non-extractable
 * CryptoKey. Throws if the AEAD tag or associated data does not verify.
 */
export function unseal(
  format: KeyFormat,
  blob: Bytes,
  wrappingKey: CryptoKey,
  importParams:
    | AlgorithmIdentifier
    | RsaHashedImportParams
    | EcKeyImportParams
    | AesKeyAlgorithm,
  usages: KeyUsage[],
  additionalData?: Bytes,
): Promise<CryptoKey> {
  const algorithm: AesGcmParams = additionalData
    ? {name: 'AES-GCM', iv: blob.subarray(0, 12), additionalData}
    : {name: 'AES-GCM', iv: blob.subarray(0, 12)};

  return subtle.unwrapKey(
    format,
    blob.subarray(12),
    wrappingKey,
    algorithm,
    importParams,
    false,
    usages,
  );
}
