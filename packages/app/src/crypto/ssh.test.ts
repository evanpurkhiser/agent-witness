import {describe, expect, it} from 'vitest';

import {readFileSync} from 'node:fs';

import {generateMasterKey} from 'app/crypto/master-key';
import {importSSHKey, unwrapSSHKey, wrapSSHKey} from 'app/crypto/ssh';
import {parseOpenSSHPrivateKey, type ParsedKey} from 'app/ssh/key';
import {expectKeyType} from 'app/test-helpers';
import {b64urlencode} from 'app/utils/bytes';

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

/**
 * Parse a private-key fixture from the ssh module's fixtures directory.
 */
function fixture(name: string): ParsedKey {
  return parseOpenSSHPrivateKey(
    readFileSync(new URL(`../../../../fixtures/keys/${name}`, import.meta.url), 'utf8'),
  );
}

describe('ssh key wrapping', () => {
  it('recovers an identical ed25519 signing key, non-extractable', async () => {
    const key = fixture('ed25519');
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
    const key = fixture('rsa');
    const master = await generateMasterKey();
    const imported = await importSSHKey(key);
    const before = await subtle.sign(SIGN_ALGO[key.type], imported, DATA);

    const blob = await wrapSSHKey(imported, key.type, master, 'key-under-test');
    const recovered = await unwrapSSHKey(blob, key.type, master, 'key-under-test');
    const after = await subtle.sign(SIGN_ALGO[key.type], recovered, DATA);

    expect(new Uint8Array(after)).toEqual(new Uint8Array(before));
  });

  it('recovers a usable ecdsa signing key', async () => {
    const key = fixture('ecdsa');
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
    const key = fixture('ed25519');
    const master = await generateMasterKey();
    const imported = await importSSHKey(key);
    const blob = await wrapSSHKey(imported, key.type, master, 'right-id');

    await expect(unwrapSSHKey(blob, key.type, master, 'wrong-id')).rejects.toThrow();
  });
});
