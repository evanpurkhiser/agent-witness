// IndexedDB persistence for the single vault and its encrypted key blobs, via
// the `idb` promise wrapper. The vault metadata (including per-key metadata)
// lives in one record; each encrypted private key is stored separately, keyed by
// its id, and written in the same transaction as the metadata so the two never
// drift apart.

import {type DBSchema, openDB} from 'idb';

import type {PairingRecord, PairingStore} from 'app/remote/session';
import type {AgentEvent} from 'app/worker/events';

import type {EncryptedKey, Vault} from './types';

const DB_NAME = 'agent-witness';
const DB_VERSION = 3;

export const MAX_STORED_AGENT_EVENTS = 250;

// There is only ever one vault; it lives under this fixed key.
const VAULT_KEY = 'vault';

interface VaultDBSchema extends DBSchema {
  vault: {key: string; value: Vault};
  keys: {key: string; value: EncryptedKey};
  pairings: {key: string; value: PairingRecord};
  events: {
    key: string;
    value: AgentEvent;
    indexes: {'by-time': [number, string]};
  };
}

/**
 * A pending add or removal of an encrypted key, applied in the same transaction
 * as the vault metadata so the two never drift apart.
 */
export type KeyChange = {put: EncryptedKey} | {remove: string};

/**
 * Persistence for the vault, backed by IndexedDB. There is at most one vault.
 */
export interface VaultStore extends PairingStore {
  /**
   * Load the vault metadata, or null if no vault has been created.
   */
  loadVault(): Promise<Vault | null>;
  /**
   * Load one encrypted private key blob by id, or null if absent.
   */
  getKey(keyId: string): Promise<EncryptedKey | null>;
  /**
   * Persist the vault, optionally adding or removing a key blob atomically.
   */
  save(vault: Vault, change?: KeyChange): Promise<void>;
  /**
   * Load retained agent events in chronological order.
   */
  loadAgentEvents(): Promise<AgentEvent[]>;
  /**
   * Append an event and prune the oldest records beyond the retention limit.
   */
  appendAgentEvent(event: AgentEvent): Promise<void>;
  /**
   * Delete the vault and every stored key.
   */
  destroy(): Promise<void>;
}

/**
 * Open the vault store. `name` selects the IndexedDB database and defaults to
 * the app's database; tests pass a unique name for isolation.
 */
export async function openVaultStore(name: string = DB_NAME): Promise<VaultStore> {
  const db = await openDB<VaultDBSchema>(name, DB_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore('vault');
        database.createObjectStore('keys', {keyPath: 'keyId'});
      }
      if (oldVersion < 2) {
        database.createObjectStore('pairings', {keyPath: 'endpoint'});
      }
      if (oldVersion < 3) {
        const events = database.createObjectStore('events', {keyPath: 'id'});
        events.createIndex('by-time', ['at', 'id']);
      }
    },
  });

  return {
    async loadVault() {
      return (await db.get('vault', VAULT_KEY)) ?? null;
    },

    async getKey(keyId) {
      return (await db.get('keys', keyId)) ?? null;
    },

    async save(vault, change) {
      const tx = db.transaction(['vault', 'keys'], 'readwrite');
      await Promise.all([
        tx.objectStore('vault').put(vault, VAULT_KEY),
        change && 'put' in change ? tx.objectStore('keys').put(change.put) : undefined,
        change && 'remove' in change
          ? tx.objectStore('keys').delete(change.remove)
          : undefined,
        tx.done,
      ]);
    },

    async loadPairing(endpoint) {
      return (await db.get('pairings', endpoint)) ?? null;
    },

    async savePairing(pairing) {
      await db.put('pairings', pairing);
    },

    async deletePairing(endpoint) {
      await db.delete('pairings', endpoint);
    },

    async loadAgentEvents() {
      return db.getAllFromIndex('events', 'by-time');
    },

    async appendAgentEvent(event) {
      const tx = db.transaction('events', 'readwrite');
      const events = tx.objectStore('events');
      await events.put(event);

      let excess = (await events.count()) - MAX_STORED_AGENT_EVENTS;
      let cursor = await events.index('by-time').openCursor();
      while (cursor && excess > 0) {
        await cursor.delete();
        excess -= 1;
        cursor = await cursor.continue();
      }

      await tx.done;
    },

    async destroy() {
      const tx = db.transaction(['vault', 'keys'], 'readwrite');
      await Promise.all([
        tx.objectStore('vault').clear(),
        tx.objectStore('keys').clear(),
        tx.done,
      ]);
    },
  };
}
