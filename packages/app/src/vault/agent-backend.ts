// Vault-state ssh-agent backends: empty without a vault, public-only while
// locked, and signing-capable with a resident master key.

import {sshSign, unwrapSSHKey} from 'app/crypto/ssh';
import {
  type EmptyAgentBackend,
  type PublicAgentBackend,
  rsaFlavorFromFlags,
  type UnlockedAgentBackend,
} from 'app/ssh/agent';
import {bytesEqual} from 'app/utils/bytes';

import type {VaultStore} from './storage';
import type {Vault} from './types';

/**
 * Build an agent backend for an absent vault.
 */
export function createEmptyAgentBackend(): EmptyAgentBackend {
  return {listIdentities: () => []};
}

/**
 * Build an agent backend over a vault's public key metadata.
 */
export function createPublicAgentBackend(vault: Vault): PublicAgentBackend {
  return {
    listIdentities: () =>
      vault.keys.map(key => ({keyBlob: key.publicKey, comment: key.comment})),
  };
}

/**
 * Build an agent backend over an unlocked vault and its resident master key.
 */
export function createUnlockedAgentBackend(
  store: VaultStore,
  vault: Vault,
  masterKey: CryptoKey,
): UnlockedAgentBackend {
  return {
    ...createPublicAgentBackend(vault),

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
