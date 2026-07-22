import {describe, expect, it} from 'vitest';

import {generateMasterKey} from 'app/crypto/master-key';
import {importSSHKey, sshSign, unwrapSSHKey, wrapSSHKey} from 'app/crypto/ssh';
import {Reader} from 'app/ssh/encoding';
import {expectKeyType, parseKeyFixture} from 'app/test-helpers';
import {b64urlencode, concatBytes} from 'app/utils/bytes';

const subtle = globalThis.crypto.subtle;
const DATA = new TextEncoder().encode('agent-witness ssh key test');

/**
 * The WebCrypto sign/verify algorithm for each supported key type.
 */
const SIGN_ALGO = {
  'ssh-ed25519': {name: 'Ed25519'},
  'ssh-rsa': {name: 'RSASSA-PKCS1-v1_5'},
  'ecdsa-sha2-nistp256': {name: 'ECDSA', hash: 'SHA-256'},
} as const;

describe('ssh key wrapping', () => {
  it('recovers an identical ed25519 signing key, non-extractable', async () => {
    const key = parseKeyFixture('ed25519');
    const master = await generateMasterKey();
    const imported = await importSSHKey(key);
    const before = await subtle.sign(SIGN_ALGO[key.type], imported, DATA);

    const blob = await wrapSSHKey(imported, key.type, master, 'key-under-test');
    const recovered = await unwrapSSHKey(blob, key.type, master, 'key-under-test');
    const after = await subtle.sign(SIGN_ALGO[key.type], recovered, DATA);

    expect(new Uint8Array(after)).toEqual(new Uint8Array(before));
    await expect(subtle.exportKey('pkcs8', recovered)).rejects.toThrow();
  });

  it('recovers an identical rsa signing key', async () => {
    const key = parseKeyFixture('rsa');
    const master = await generateMasterKey();
    const imported = await importSSHKey(key);
    const before = await subtle.sign(SIGN_ALGO[key.type], imported, DATA);

    const blob = await wrapSSHKey(imported, key.type, master, 'key-under-test');
    const recovered = await unwrapSSHKey(blob, key.type, master, 'key-under-test');
    const after = await subtle.sign(SIGN_ALGO[key.type], recovered, DATA);

    expect(new Uint8Array(after)).toEqual(new Uint8Array(before));
  });

  it('recovers a usable ecdsa signing key', async () => {
    const key = parseKeyFixture('ecdsa');
    expectKeyType(key, 'ecdsa-sha2-nistp256');

    const master = await generateMasterKey();
    const imported = await importSSHKey(key);
    const blob = await wrapSSHKey(imported, key.type, master, 'key-under-test');
    const recovered = await unwrapSSHKey(blob, key.type, master, 'key-under-test');
    const signature = await subtle.sign(SIGN_ALGO[key.type], recovered, DATA);

    const publicKey = await subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: b64urlencode(key.point.subarray(1, 33)),
        y: b64urlencode(key.point.subarray(33, 65)),
      },
      {name: 'ECDSA', namedCurve: 'P-256'},
      false,
      ['verify'],
    );
    expect(await subtle.verify(SIGN_ALGO[key.type], publicKey, signature, DATA)).toBe(
      true,
    );
  });

  it('binds an encrypted key blob to its key id', async () => {
    const key = parseKeyFixture('ed25519');
    const master = await generateMasterKey();
    const imported = await importSSHKey(key);
    const blob = await wrapSSHKey(imported, key.type, master, 'right-id');

    await expect(unwrapSSHKey(blob, key.type, master, 'wrong-id')).rejects.toThrow();
  });
});

/**
 * Left-pad a big-endian magnitude to an exact width.
 */
function fixedWidth(b: Uint8Array, length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  out.set(b, length - b.length);
  return out;
}

describe('sshSign', () => {
  it('produces a verifiable ed25519 signature', async () => {
    const key = parseKeyFixture('ed25519');
    expectKeyType(key, 'ssh-ed25519');
    const blob = await sshSign(await importSSHKey(key), key.type, DATA);

    const reader = new Reader(blob);
    expect(reader.str()).toBe('ssh-ed25519');
    const signature = reader.string().slice();

    const publicKey = await subtle.importKey(
      'raw',
      key.publicKey.slice(),
      {name: 'Ed25519'},
      false,
      ['verify'],
    );
    expect(await subtle.verify({name: 'Ed25519'}, publicKey, signature, DATA)).toBe(true);
  });

  it('produces a verifiable rsa-sha2-256 signature', async () => {
    const key = parseKeyFixture('rsa');
    expectKeyType(key, 'ssh-rsa');
    const blob = await sshSign(await importSSHKey(key), key.type, DATA, 'rsa-sha2-256');

    const reader = new Reader(blob);
    expect(reader.str()).toBe('rsa-sha2-256');
    const signature = reader.string().slice();

    const publicKey = await subtle.importKey(
      'jwk',
      {kty: 'RSA', n: b64urlencode(key.n), e: b64urlencode(key.e)},
      {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'},
      false,
      ['verify'],
    );
    expect(
      await subtle.verify({name: 'RSASSA-PKCS1-v1_5'}, publicKey, signature, DATA),
    ).toBe(true);
  });

  it('produces a verifiable ecdsa signature', async () => {
    const key = parseKeyFixture('ecdsa');
    expectKeyType(key, 'ecdsa-sha2-nistp256');
    const blob = await sshSign(await importSSHKey(key), key.type, DATA);

    const reader = new Reader(blob);
    expect(reader.str()).toBe('ecdsa-sha2-nistp256');
    const inner = new Reader(reader.string());
    const raw = concatBytes(fixedWidth(inner.mpint(), 32), fixedWidth(inner.mpint(), 32));

    const publicKey = await subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: b64urlencode(key.point.subarray(1, 33)),
        y: b64urlencode(key.point.subarray(33, 65)),
      },
      {name: 'ECDSA', namedCurve: 'P-256'},
      false,
      ['verify'],
    );
    expect(
      await subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, publicKey, raw, DATA),
    ).toBe(true);
  });
});
