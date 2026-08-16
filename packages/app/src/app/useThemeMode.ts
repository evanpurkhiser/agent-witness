import {useCallback, useState} from 'react';

import {applyThemeMode, readThemeMode, type ThemeMode} from './theme';

export function useThemeMode(): readonly [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState(readThemeMode);

  const selectMode = useCallback((selected: ThemeMode) => {
    setMode(selected);
    applyThemeMode(selected);
  }, []);

  return [mode, selectMode] as const;
}
