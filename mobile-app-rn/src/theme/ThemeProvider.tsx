import React, { createContext, useContext, useMemo } from 'react';
import { MMKV } from 'react-native-mmkv';
import { themes, Theme, ThemeName } from './colors';

const mmkv = new MMKV();

const ThemeContext = createContext<{ theme: Theme; themeName: ThemeName; setTheme: (n: ThemeName) => void }>({
  theme: themes.light,
  themeName: 'light',
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeName, setThemeName] = React.useState<ThemeName>(
    (mmkv.getString('theme') as ThemeName) || 'light',
  );

  const setTheme = (n: ThemeName) => {
    mmkv.set('theme', n);
    setThemeName(n);
  };

  const value = useMemo(() => ({ theme: themes[themeName], themeName, setTheme }), [themeName]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
