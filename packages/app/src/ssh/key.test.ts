import {describe, expect, it} from 'vitest';

import {readFileSync} from 'node:fs';

import {Writer} from 'app/ssh/encoding';
import {
  ed25519PublicBlob,
  InvalidKeyFormat,
  parseOpenSSHPrivateKey,
  UnsupportedKey,
} from 'app/ssh/key';
import {expectKeyType} from 'app/test-helpers';
import {b64decode, b64encode} from 'app/utils/bytes';

/**
 * Read a key fixture as text.
 */
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../../../fixtures/keys/${name}`, import.meta.url),
    'utf8',
  );
}

/**
 * The base64-decoded key blob from an SSH `.pub` fixture file.
 */
function pubBlob(name: string): Uint8Array {
  return b64decode(fixture(name).split(/\s+/)[1]);
}

/**
 * Wrap raw bytes in an OPENSSH PRIVATE KEY PEM block.
 */
function asPem(bytes: Uint8Array): string {
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64encode(bytes)}\n-----END OPENSSH PRIVATE KEY-----`;
}

describe('parseOpenSSHPrivateKey', () => {
  it('parses ed25519 and rebuilds its public blob', () => {
    const key = parseOpenSSHPrivateKey(fixture('ed25519'));
    expectKeyType(key, 'ssh-ed25519');

    expect(key.comment).toBe('test@agent-witness');
    expect(key.publicBlob).toEqual(pubBlob('ed25519.pub'));
    expect(key.seed).toHaveLength(32);
    expect(key.publicKey).toHaveLength(32);
    expect(ed25519PublicBlob(key.publicKey)).toEqual(key.publicBlob);
  });

  it('parses rsa and its e/n rebuild the public blob', () => {
    const key = parseOpenSSHPrivateKey(fixture('rsa'));
    expectKeyType(key, 'ssh-rsa');

    expect(key.publicBlob).toEqual(pubBlob('rsa.pub'));
    const rebuilt = new Writer().string('ssh-rsa').mpint(key.e).mpint(key.n).finish();
    expect(rebuilt).toEqual(key.publicBlob);
  });

  it('parses ecdsa and its curve/point rebuild the public blob', () => {
    const key = parseOpenSSHPrivateKey(fixture('ecdsa'));
    expectKeyType(key, 'ecdsa-sha2-nistp256');

    expect(key.publicBlob).toEqual(pubBlob('ecdsa.pub'));
    const rebuilt = new Writer()
      .string('ecdsa-sha2-nistp256')
      .string(key.curve)
      .string(key.point)
      .finish();
    expect(rebuilt).toEqual(key.publicBlob);
  });

  it('rejects an encrypted key', () => {
    expect(() => parseOpenSSHPrivateKey(fixture('ed25519_encrypted'))).toThrow(
      UnsupportedKey,
    );
  });

  it('rejects non-PEM input', () => {
    expect(() => parseOpenSSHPrivateKey('not a key')).toThrow(InvalidKeyFormat);
  });

  it('rejects a bad magic header', () => {
    expect(() => parseOpenSSHPrivateKey(asPem(new Uint8Array(64)))).toThrow(
      InvalidKeyFormat,
    );
  });

  it('rejects a truncated key body', () => {
    const full = b64decode(fixture('ed25519').replace(/-----[^-]+-----/g, ''));
    expect(() =>
      parseOpenSSHPrivateKey(asPem(full.subarray(0, full.length >> 1))),
    ).toThrow(InvalidKeyFormat);
  });
});
