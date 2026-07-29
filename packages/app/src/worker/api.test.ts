import {describe, expect, it} from 'vitest';

import type {Vault} from 'app/vault/types';

import {toView} from './api';

/**
 * Build an ArrayBuffer-backed byte array from literal values.
 */
function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

/**
 * A vault with one passkey and one key, carrying secret-bearing fields.
 */
function sampleVault(): Vault {
  return {
    id: 'vault-1',
    version: 1,
    createdAt: 500,
    passkeys: [
      {
        label: 'iPhone',
        credentialId: bytes(1, 2, 3),
        salt: bytes(4, 5, 6),
        wrappedMasterKey: bytes(7, 8, 9),
        addedAt: 1000,
      },
    ],
    keys: [
      {
        id: 'key-1',
        name: 'my key',
        type: 'ssh-ed25519',
        publicKey: bytes(10, 11, 12),
        fingerprint: 'SHA256:abc',
        comment: 'test@host',
        addedAt: 2000,
      },
    ],
  };
}

describe('toView', () => {
  it('exposes unlock material but drops the wrapped master key', () => {
    const view = toView(sampleVault());

    expect(view.passkeys[0].credentialId).toEqual(bytes(1, 2, 3));
    expect(view.passkeys[0].salt).toEqual(bytes(4, 5, 6));
    expect(view.passkeys[0]).not.toHaveProperty('wrappedMasterKey');
  });

  it('exposes only public key metadata', () => {
    const view = toView(sampleVault());

    expect(view.keys[0]).toEqual({
      id: 'key-1',
      name: 'my key',
      type: 'ssh-ed25519',
      fingerprint: 'SHA256:abc',
      comment: 'test@host',
      addedAt: 2000,
    });
    expect(view.keys[0]).not.toHaveProperty('publicKey');
  });
});
