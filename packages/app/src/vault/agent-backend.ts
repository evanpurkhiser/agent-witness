// The vault as an ssh-agent backend: it presents the vault's public identities
// and signs requests by unwrapping the matching key under the master key. Built
// for an unlocked vault (see vault/vault.ts), which supplies the store, current
// metadata, and resident master key.

import {sshSign, unwrapSSHKey} from 'app/crypto/ssh';
import {type AgentBackend, rsaFlavorFromFlags} from 'app/ssh/agent';
import {bytesEqual} from 'app/utils/bytes';
import type {VaultStore} from 'app/vault/storage';
import type {Vault} from 'app/vault/types';

/**
 * Build an agent backend over an unlocked vault's keys and resident master key.
 */
export function createAgentBackend(
  store: VaultStore,
  vault: Vault,
  masterKey: CryptoKey,
): AgentBackend {
  return {
    listIdentities() {
      return vault.keys.map(key => ({keyBlob: key.publicKey, comment: key.comment}));
    },

    async sign(request) {
      const key = vault.keys.find(candidate =>
        bytesEqual(candidate.publicKey, request.keyBlob),
      );
      if (!key) {
        throw new Error('no matching identity');
      }

      const encrypted = await store.getKey(key.id);
      if (!encrypted) {
        throw new Error('missing key material');
      }

      const flavor = rsaFlavorFromFlags(request.flags);
      const rsaHash = flavor === 'rsa-sha2-512' ? 'SHA-512' : 'SHA-256';
      const signingKey = await unwrapSSHKey(
        encrypted.data,
        key.type,
        masterKey,
        key.id,
        rsaHash,
      );
      return sshSign(signingKey, key.type, request.data, flavor);
    },
  };
}
