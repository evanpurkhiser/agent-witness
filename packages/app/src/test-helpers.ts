import {expect} from 'vitest';

import {readFileSync} from 'node:fs';

import {parseOpenSSHPrivateKey, type ParsedKey} from 'app/ssh/key';
import {b64decode, type Bytes} from 'app/utils/bytes';
import type {VaultState} from 'app/vault/vault';

/**
 * Read a key fixture (from the repo-root fixtures/keys directory) as text.
 */
export function keyFixture(name: string): string {
  return readFileSync(new URL(`../../../fixtures/keys/${name}`, import.meta.url), 'utf8');
}

/**
 * Parse a private-key fixture into its `ParsedKey`.
 */
export function parseKeyFixture(name: string): ParsedKey {
  return parseOpenSSHPrivateKey(keyFixture(name));
}

/**
 * The base64-decoded public key blob from a `.pub` fixture file.
 */
export function pubKeyFixture(name: string): Bytes {
  return b64decode(keyFixture(`${name}.pub`).split(/\s+/)[1]);
}

/**
 * Assert a parsed key's algorithm and narrow it to the matching variant, so
 * tests can read variant-specific fields without a branching type guard.
 */
export function expectKeyType<T extends ParsedKey['type']>(
  key: ParsedKey,
  type: T,
): asserts key is Extract<ParsedKey, {type: T}> {
  expect(key.type).toBe(type);
}

/**
 * Assert a vault's state and narrow it to that state, so tests can reach its
 * state-specific transitions without a branching type guard.
 */
export function expectVaultState<S extends VaultState['status']>(
  state: VaultState,
  status: S,
): asserts state is Extract<VaultState, {status: S}> {
  expect(state.status).toBe(status);
}
