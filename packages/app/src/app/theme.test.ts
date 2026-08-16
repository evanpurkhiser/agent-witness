import {describe, expect, it} from 'vitest';

import {
  applyThemeMode,
  readThemeMode,
  THEME_MODE_STORAGE_KEY,
  type ThemeMode,
} from './theme';

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set(THEME_MODE_STORAGE_KEY, initial);
  }

  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    value: () => values.get(THEME_MODE_STORAGE_KEY),
  };
}

describe('theme mode', () => {
  it.each([
    [undefined, 'system'],
    ['unknown', 'system'],
    ['light', 'light'],
    ['dark', 'dark'],
  ] as const)('reads %s as %s', (stored, expected) => {
    expect(readThemeMode(storage(stored))).toBe(expected);
  });

  it.each(['light', 'dark'] as const)('stores and applies %s mode', mode => {
    const target = storage();
    const root: {dataset: DOMStringMap} = {dataset: {}};

    applyThemeMode(mode, root, target);

    expect(root.dataset.theme).toBe(mode);
    expect(target.value()).toBe(mode);
  });

  it('removes the explicit override for system mode', () => {
    const target = storage('dark');
    const root: {dataset: DOMStringMap} = {dataset: {theme: 'dark' as ThemeMode}};

    applyThemeMode('system', root, target);

    expect(root.dataset.theme).toBeUndefined();
    expect(target.value()).toBeUndefined();
  });
});
