// Generic byte-array helpers, independent of any SSH or crypto concern.

/**
 * A byte array backed by a plain ArrayBuffer — the shape WebCrypto's
 * `BufferSource` and IndexedDB accept. Prefer this over a bare `Uint8Array` for
 * data that crosses into WebCrypto or storage.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * Concatenate any number of byte arrays into a single `Bytes`.
 */
export function concatBytes(...arrs: Uint8Array[]): Bytes {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  arrs.reduce((off, a) => {
    out.set(a, off);
    return off + a.length;
  }, 0);
  return out;
}

/**
 * Compare two byte arrays for equality. Not constant-time — intended for
 * non-secret data such as public key blobs.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Decode a base64 string into bytes, tolerating embedded whitespace. Uses the
 * platform `atob`, which exists in browsers and Node 24 (no Node Buffer).
 */
export function b64decode(s: string): Bytes {
  return Uint8Array.from(atob(s.replace(/\s+/g, '')), c => c.charCodeAt(0));
}

/**
 * Encode bytes as a standard (padded) base64 string via the platform `btoa`.
 */
export function b64encode(b: Uint8Array): string {
  return btoa(Array.from(b, c => String.fromCharCode(c)).join(''));
}

/**
 * Encode bytes as an unpadded base64url string, the encoding JWK fields use.
 */
export function b64urlencode(b: Uint8Array): string {
  return b64encode(b).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Generate `length` cryptographically random bytes.
 */
export function random(length: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
