import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { colors, radii, spacing, typography, type ColorPalette, type ColorScheme } from '../tokens';

export type ThemeMode = 'system' | ColorScheme;

export interface ThemeValue {
  readonly scheme: ColorScheme;
  readonly mode: ThemeMode;
  readonly setMode: (nextMode: ThemeMode) => void;
  readonly colors: ColorPalette;
  readonly spacing: typeof spacing;
  readonly typography: typeof typography;
  readonly radii: typeof radii;
}

export function resolveColorScheme(
  mode: ThemeMode,
  systemScheme: 'light' | 'dark' | 'unspecified' | null | undefined,
): ColorScheme {
  return mode === 'light' || mode === 'dark' ? mode : systemScheme === 'dark' ? 'dark' : 'light';
}

const ThemeContext = createContext<ThemeValue>({
  scheme: 'light',
  mode: 'system',
  setMode: () => undefined,
  colors: colors.light,
  spacing,
  typography,
  radii,
});

export function ThemeProvider({
  initialMode = 'system',
  children,
}: {
  readonly initialMode?: ThemeMode;
  readonly children: ReactNode;
}) {
  const systemScheme = useColorScheme();
  const [mode, setMode] = useState<ThemeMode>(initialMode);
  const scheme = resolveColorScheme(mode, systemScheme);
  const value = useMemo<ThemeValue>(
    () => ({ scheme, mode, setMode, colors: colors[scheme], spacing, typography, radii }),
    [mode, scheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = (): ThemeValue => useContext(ThemeContext);
