import 'fake-indexeddb/auto';

import {describe, expect, it} from 'vitest';

import {expectVaultState, keyFixture} from 'app/test-helpers';
import {random} from 'app/utils/bytes';

import {openVaultStore, type VaultStore} from './storage';
import {
  type CreateVaultParams,
  DuplicateKey,
  openVault,
  type UnlockedVault,
  WrongPasskey,
} from './vault';

// Ground-truth fingerprint from `ssh-keygen -lf ed25519.pub`.
const ED25519_FINGERPRINT = 'SHA256:wCyFHQrqFBBRWCuNhhcbEGlxmNh8w/nfJ1Bpf64T1Bc';

/**
 * Fresh create-vault material.
 */
function params(): CreateVaultParams {
  return {
    prfOutput: random(32),
    credentialId: random(16),
    salt: random(32),
    label: 'iPhone',
  };
}

/**
 * A store backed by a fresh, uniquely named database.
 */
function freshStore(): Promise<VaultStore> {
  return openVaultStore(globalThis.crypto.randomUUID());
}

/**
 * Create a vault in the store and return its unlocked state.
 */
async function createUnlocked(
  store: VaultStore,
  created: CreateVaultParams = params(),
): Promise<UnlockedVault> {
  const state = await openVault(store);
  expectVaultState(state, 'no-vault');
  return state.createVault(created);
}

describe('openVault', () => {
  it('is no-vault for an empty store', async () => {
    const state = await openVault(await freshStore());

    expect(state.status).toBe('no-vault');
  });

  it('reopens an existing vault as locked', async () => {
    const store = await freshStore();
    await createUnlocked(store);

    const reopened = await openVault(store);

    expectVaultState(reopened, 'locked');
    expect(reopened.vault.passkeys).toHaveLength(1);
    expect('addKey' in reopened).toBe(false);
  });
});

describe('creating and unlocking', () => {
  it('creates a vault, leaving it unlocked and empty', async () => {
    const unlocked = await createUnlocked(await freshStore());

    expect(unlocked.status).toBe('unlocked');
    expect(unlocked.vault.passkeys[0].label).toBe('iPhone');
    expect(unlocked.vault.keys).toHaveLength(0);
  });

  it('unlocks a locked vault with the right passkey', async () => {
    const created = params();
    const locked = (await createUnlocked(await freshStore(), created)).lock();

    const unlocked = await locked.unlock(created.prfOutput);

    expect(unlocked.status).toBe('unlocked');
  });

  it('rejects unlocking with the wrong passkey', async () => {
    const locked = (await createUnlocked(await freshStore())).lock();

    await expect(locked.unlock(random(32))).rejects.toThrow(WrongPasskey);
  });
});

describe('managing keys', () => {
  it('adds a key and records its metadata', async () => {
    const unlocked = await (
      await createUnlocked(await freshStore())
    ).addKey(keyFixture('ed25519'));

    expect(unlocked.vault.keys).toHaveLength(1);
    const [key] = unlocked.vault.keys;
    expect(key.type).toBe('ssh-ed25519');
    expect(key.name).toBe('test@agent-witness');
    expect(key.comment).toBe('test@agent-witness');
    expect(key.fingerprint).toBe(ED25519_FINGERPRINT);
  });

  it('stores the encrypted key blob alongside the metadata', async () => {
    const store = await freshStore();
    const unlocked = await (await createUnlocked(store)).addKey(keyFixture('ed25519'));

    expect(await store.getKey(unlocked.vault.keys[0].id)).not.toBeNull();
  });

  it('honors an explicit key name', async () => {
    const unlocked = await (
      await createUnlocked(await freshStore())
    ).addKey(keyFixture('ed25519'), 'work laptop');

    expect(unlocked.vault.keys[0].name).toBe('work laptop');
  });

  it('rejects a duplicate key', async () => {
    const unlocked = await (
      await createUnlocked(await freshStore())
    ).addKey(keyFixture('ed25519'));

    await expect(unlocked.addKey(keyFixture('ed25519'))).rejects.toThrow(DuplicateKey);
  });

  it('removes a key and its blob', async () => {
    const store = await freshStore();
    const unlocked = await (await createUnlocked(store)).addKey(keyFixture('ed25519'));
    const {id} = unlocked.vault.keys[0];

    const after = await unlocked.removeKey(id);

    expect(after.vault.keys).toHaveLength(0);
    expect(await store.getKey(id)).toBeNull();
  });

  it('removes a key while locked', async () => {
    const store = await freshStore();
    const unlocked = await (await createUnlocked(store)).addKey(keyFixture('ed25519'));
    const {id} = unlocked.vault.keys[0];

    const after = await unlocked.lock().removeKey(id);

    expect(after.status).toBe('locked');
    expect(after.vault.keys).toHaveLength(0);
  });
});

describe('destroying', () => {
  it('deletes the vault and its keys', async () => {
    const store = await freshStore();
    const unlocked = await (await createUnlocked(store)).addKey(keyFixture('ed25519'));
    const {id} = unlocked.vault.keys[0];

    const empty = await unlocked.destroy();

    expect(empty.status).toBe('no-vault');
    expect(await store.getKey(id)).toBeNull();
  });
});
