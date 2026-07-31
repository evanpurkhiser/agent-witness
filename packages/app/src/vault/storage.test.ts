import 'fake-indexeddb/auto';

import {describe, expect, it} from 'vitest';

import type {PairingRecord} from 'app/remote/session';

import {MAX_STORED_AGENT_EVENTS, openVaultStore} from './storage';
import type {EncryptedKey, Vault} from './types';

/**
 * Build an ArrayBuffer-backed byte array from literal values.
 */
function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

/**
 * A representative vault with one passkey and one key's metadata.
 */
function sampleVault(): Vault {
  return {
    id: 'vault-1',
    version: 1,
    createdAt: 500,
    passkeys: [
      {
        label: 'Test passkey',
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

/**
 * A representative encrypted key blob for the given id.
 */
function sampleKey(keyId: string): EncryptedKey {
  return {keyId, data: bytes(0xaa, 0xbb, 0xcc)};
}

/**
 * Open a store backed by a fresh, uniquely named database for isolation.
 */
function freshStore() {
  return openVaultStore(globalThis.crypto.randomUUID());
}

describe('VaultStore', () => {
  it('returns null when no vault exists', async () => {
    const store = await freshStore();

    expect(await store.loadVault()).toBeNull();
    expect(await store.getKey('missing')).toBeNull();
  });

  it('round-trips the vault metadata including byte fields', async () => {
    const store = await freshStore();
    const vault = sampleVault();

    await store.save(vault);

    expect(await store.loadVault()).toEqual(vault);
  });

  it('adds an encrypted key atomically with the vault', async () => {
    const store = await freshStore();
    const key = sampleKey('key-1');

    await store.save(sampleVault(), {put: key});

    expect(await store.getKey('key-1')).toEqual(key);
  });

  it('removes an encrypted key', async () => {
    const store = await freshStore();
    await store.save(sampleVault(), {put: sampleKey('key-1')});

    await store.save(sampleVault(), {remove: 'key-1'});

    expect(await store.getKey('key-1')).toBeNull();
  });

  it('persists pairing independently from the vault', async () => {
    const store = await freshStore();
    const pairing: PairingRecord = {
      endpoint: 'wss://server.example/api/agent',
      serverId: '11111111-2222-4333-8444-555555555555',
      clientId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      credential: bytes(1, 2, 3),
      label: 'Browser',
      pairedAt: 1000,
    };

    await store.savePairing(pairing);
    await store.save(sampleVault());
    await store.destroy();

    expect(await store.loadPairing(pairing.endpoint)).toEqual(pairing);

    await store.deletePairing(pairing.endpoint);
    expect(await store.loadPairing(pairing.endpoint)).toBeNull();
  });

  it('persists agent events chronologically', async () => {
    const store = await freshStore();

    await store.appendAgentEvent({id: 'later', at: 200, type: 'vault_unlocked'});
    await store.appendAgentEvent({
      id: 'earlier',
      at: 100,
      type: 'vault_locked',
      reason: 'manual',
    });

    expect(await store.loadAgentEvents()).toEqual([
      {id: 'earlier', at: 100, type: 'vault_locked', reason: 'manual'},
      {id: 'later', at: 200, type: 'vault_unlocked'},
    ]);
  });

  it('prunes the oldest agent events beyond the retention limit', async () => {
    const store = await freshStore();

    for (let index = 0; index <= MAX_STORED_AGENT_EVENTS; index += 1) {
      await store.appendAgentEvent({
        id: String(index).padStart(3, '0'),
        at: index,
        type: 'vault_unlocked',
      });
    }

    const events = await store.loadAgentEvents();
    expect(events).toHaveLength(MAX_STORED_AGENT_EVENTS);
    expect(events[0]).toMatchObject({id: '001', at: 1});
  });

  it('destroys the vault and all keys', async () => {
    const store = await freshStore();
    await store.save(sampleVault(), {put: sampleKey('key-1')});

    await store.destroy();

    expect(await store.loadVault()).toBeNull();
    expect(await store.getKey('key-1')).toBeNull();
  });
});
