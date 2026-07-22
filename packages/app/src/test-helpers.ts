import {expect} from 'vitest';

import type {ParsedKey} from 'app/ssh/key';
import type {VaultState} from 'app/vault/vault';

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
