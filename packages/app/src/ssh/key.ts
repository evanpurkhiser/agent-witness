// Parser for the `openssh-key-v1` private key container (unencrypted only,
// cipher "none"). Hand-rolled and browser-safe. See PROTOCOL.key in OpenSSH.

import {Reader, Writer} from 'app/ssh/encoding';
import {b64decode, bytesEqual} from 'app/utils/bytes';

const MAGIC = new TextEncoder().encode('openssh-key-v1\0');

/**
 * Base class for failures while parsing an SSH private key.
 */
export class SSHKeyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/**
 * The input is not a well-formed openssh-key-v1 private key.
 */
export class InvalidKeyFormat extends SSHKeyError {}

/**
 * The key is well-formed but uses an unsupported feature — encryption, or a key
 * type this parser does not handle.
 */
export class UnsupportedKey extends SSHKeyError {}

/**
 * An ed25519 private key parsed from an openssh-key-v1 container.
 */
export interface KeyED25519 {
  type: 'ssh-ed25519';
  comment: string;
  /**
   * Full SSH public key blob: string(keytype) + string(A).
   */
  publicBlob: Uint8Array;
  /**
   * 32-byte public key point A.
   */
  publicKey: Uint8Array;
  /**
   * 32-byte ed25519 seed.
   */
  seed: Uint8Array;
}

/**
 * An RSA private key parsed from an openssh-key-v1 container.
 */
export interface KeyRSA {
  type: 'ssh-rsa';
  comment: string;
  publicBlob: Uint8Array;
  n: Uint8Array;
  e: Uint8Array;
  d: Uint8Array;
  p: Uint8Array;
  q: Uint8Array;
  iqmp: Uint8Array;
}

/**
 * An ECDSA (nistp256) private key parsed from an openssh-key-v1 container.
 */
export interface KeyECDSA {
  type: 'ecdsa-sha2-nistp256';
  comment: string;
  publicBlob: Uint8Array;
  /**
   * Curve identifier, e.g. "nistp256".
   */
  curve: string;
  /**
   * Uncompressed EC point Q (0x04 || X || Y).
   */
  point: Uint8Array;
  /**
   * Private scalar d.
   */
  d: Uint8Array;
}

/**
 * A parsed, unencrypted OpenSSH private key, discriminated by `type`.
 */
export type ParsedKey = KeyED25519 | KeyRSA | KeyECDSA;

/**
 * Extract the base64 body from an `OPENSSH PRIVATE KEY` PEM block and decode it.
 */
function stripPem(pem: string): Uint8Array {
  const match = pem.match(
    /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/,
  );
  if (!match) {
    throw new InvalidKeyFormat('not an OPENSSH PRIVATE KEY PEM block');
  }
  return b64decode(match[1]);
}

/**
 * Verify the private section's trailing padding, which must be the increasing
 * byte sequence 1, 2, 3, … filling out to the cipher block size.
 */
function verifyPadding(r: Reader): void {
  const padding = r.bytes(r.remaining);
  padding.forEach((b, i) => {
    if (b !== ((i + 1) & 0xff)) {
      throw new InvalidKeyFormat('bad padding byte');
    }
  });
}

/**
 * Decode the openssh-key-v1 container into a discriminated key. May throw the
 * low-level `Reader` errors that `parseOpenSSHPrivateKey` normalizes.
 */
function decodeContainer(pem: string): ParsedKey {
  const raw = stripPem(pem);

  if (!bytesEqual(raw.subarray(0, MAGIC.length), MAGIC)) {
    throw new InvalidKeyFormat('bad magic — not openssh-key-v1');
  }

  const header = new Reader(raw.subarray(MAGIC.length));
  const cipher = header.str();
  const kdf = header.str();

  // Advance the cursor past the kdfoptions field (empty for cipher "none").
  header.string();

  const nKeys = header.u32();

  if (cipher !== 'none' || kdf !== 'none') {
    throw new UnsupportedKey(
      `encrypted keys are not supported (cipher=${cipher} kdf=${kdf})`,
    );
  }

  if (nKeys !== 1) {
    throw new InvalidKeyFormat(`expected exactly 1 key, got ${nKeys}`);
  }

  const publicBlob = header.string().slice();
  const priv = new Reader(header.string());

  // Encrypted keys were rejected above, so the two check-ints always match for a
  // well-formed key; a mismatch means the private section is corrupt.
  const check1 = priv.u32();
  const check2 = priv.u32();
  if (check1 !== check2) {
    throw new InvalidKeyFormat('check-int mismatch — corrupt key');
  }

  const type = priv.str();

  if (type === 'ssh-ed25519') {
    const publicKey = priv.string().slice();
    const secret = priv.string(); // 64 bytes = seed(32) || A(32)
    const comment = priv.str();
    verifyPadding(priv);

    return {type, comment, publicBlob, publicKey, seed: secret.subarray(0, 32).slice()};
  }

  if (type === 'ssh-rsa') {
    const n = priv.mpint().slice();
    const e = priv.mpint().slice();
    const d = priv.mpint().slice();
    const iqmp = priv.mpint().slice();
    const p = priv.mpint().slice();
    const q = priv.mpint().slice();
    const comment = priv.str();
    verifyPadding(priv);

    return {type, comment, publicBlob, n, e, d, p, q, iqmp};
  }

  if (type === 'ecdsa-sha2-nistp256') {
    const curve = priv.str();
    const point = priv.string().slice();
    const d = priv.mpint().slice();
    const comment = priv.str();
    verifyPadding(priv);

    return {type, comment, publicBlob, curve, point, d};
  }

  throw new UnsupportedKey(`unsupported key type: ${type}`);
}

/**
 * Parse an unencrypted `openssh-key-v1` private key from its PEM text. Always
 * throws an `SSHKeyError` on failure: `UnsupportedKey` for encrypted or
 * unhandled key types, otherwise `InvalidKeyFormat`.
 */
export function parseOpenSSHPrivateKey(pem: string): ParsedKey {
  try {
    return decodeContainer(pem);
  } catch (error) {
    if (error instanceof SSHKeyError) {
      throw error;
    }
    throw new InvalidKeyFormat('malformed OpenSSH private key', {cause: error});
  }
}

/**
 * Rebuild the SSH public key blob for an ed25519 point A: string("ssh-ed25519")
 * + string(A).
 */
export function ed25519PublicBlob(a: Uint8Array): Uint8Array {
  return new Writer().string('ssh-ed25519').string(a).finish();
}
