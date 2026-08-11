import 'fake-indexeddb/auto';

import {describe, expect, it} from 'vitest';

import {Reader} from 'app/ssh/encoding';
import {expectVaultState, keyFixture} from 'app/test-helpers';
import {random} from 'app/utils/bytes';

import {openVaultStore} from './storage';
import {openVault, type UnlockedVault} from './vault';

const subtle = globalThis.crypto.subtle;

/**
 * Create a vault, add the ed25519 fixture, and return the unlocked state.
 */
async function unlockedWithKey(): Promise<UnlockedVault> {
  const state = await openVault(await openVaultStore(globalThis.crypto.randomUUID()));
  expectVaultState(state, 'no-vault');
  const unlocked = await state.createVault({
    prfOutput: random(32),
    credentialId: random(16),
    salt: random(32),
    label: 'iPhone',
  });
  return unlocked.addKey(keyFixture('ed25519'));
}

describe('vault agent backend', () => {
  it('lists no identities without a vault', async () => {
    const vault = await openVault(await openVaultStore(globalThis.crypto.randomUUID()));

    const backend = vault.agentBackend();

    expect(await backend.listIdentities()).toEqual([]);
    expect(backend.sign).toBeUndefined();
  });

  it('lists the vault identities while locked', async () => {
    const vault = (await unlockedWithKey()).lock();

    const backend = vault.agentBackend();
    const identities = await backend.listIdentities();

    expect(identities).toHaveLength(1);
    expect(identities[0].comment).toBe('test@agent-witness');
    expect(identities[0].keyBlob).toEqual(vault.vault.keys[0].publicKey);
    expect(backend.sign).toBeUndefined();
  });

  it('signs a request verifiably against the key it names', async () => {
    const vault = await unlockedWithKey();
    const [key] = vault.vault.keys;
    const data = random(32);

    const blob = await vault
      .agentBackend()
      .sign({keyBlob: key.publicKey, data, flags: 0});

    const reader = new Reader(blob);
    expect(reader.str()).toBe('ssh-ed25519');
    const signature = reader.string().slice();

    // Extract the raw 32-byte public point from the SSH public blob.
    const publicBlob = new Reader(key.publicKey);
    publicBlob.str();
    const point = publicBlob.string().slice();

    const publicKey = await subtle.importKey('raw', point, {name: 'Ed25519'}, false, [
      'verify',
    ]);
    expect(await subtle.verify({name: 'Ed25519'}, publicKey, signature, data)).toBe(true);
  });

  it('rejects signing for an unknown key', async () => {
    const vault = await unlockedWithKey();

    await expect(
      vault.agentBackend().sign({keyBlob: random(32), data: random(16), flags: 0}),
    ).rejects.toThrow();
  });
});
