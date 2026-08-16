export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_MODE_STORAGE_KEY = 'agent-witness-theme-mode';

type ThemeStorageReader = Pick<Storage, 'getItem'>;
type ThemeStorageWriter = Pick<Storage, 'removeItem' | 'setItem'>;
type ThemeRoot = Pick<HTMLElement, 'dataset'>;

export function readThemeMode(
  storage: ThemeStorageReader = window.localStorage,
): ThemeMode {
  try {
    const stored = storage.getItem(THEME_MODE_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyThemeMode(
  mode: ThemeMode,
  root: ThemeRoot = document.documentElement,
  storage: ThemeStorageWriter = window.localStorage,
): void {
  if (mode === 'system') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = mode;
  }

  try {
    if (mode === 'system') {
      storage.removeItem(THEME_MODE_STORAGE_KEY);
    } else {
      storage.setItem(THEME_MODE_STORAGE_KEY, mode);
    }
  } catch {
    // The in-memory selection still applies when browser storage is unavailable.
  }
}

export function initializeThemeMode(): ThemeMode {
  const mode = readThemeMode();
  applyThemeMode(mode);
  return mode;
}
