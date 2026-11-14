export type ColorScheme = 'light' | 'dark';

const lightColors = {
  background: '#F8FAFC',
  surface: '#FFFFFF',
  surfaceMuted: '#EEF2F6',
  textPrimary: '#0F172A',
  textSecondary: '#334155',
  textMuted: '#475569',
  primary: '#0F766E',
  onPrimary: '#FFFFFF',
  success: '#15803D',
  warningSurface: '#FEF3C7',
  onWarningSurface: '#92400E',
  danger: '#B91C1C',
  onDanger: '#FFFFFF',
  border: '#CBD5E1',
};

export type ColorPalette = { readonly [K in keyof typeof lightColors]: string };

export const colors: Record<ColorScheme, ColorPalette> = {
  light: lightColors,
  dark: {
    background: '#0B1120',
    surface: '#111827',
    surfaceMuted: '#1E293B',
    textPrimary: '#F8FAFC',
    textSecondary: '#CBD5E1',
    textMuted: '#94A3B8',
    primary: '#2DD4BF',
    onPrimary: '#042F2E',
    success: '#4ADE80',
    warningSurface: '#451A03',
    onWarningSurface: '#FDE68A',
    danger: '#F87171',
    onDanger: '#450A0A',
    border: '#334155',
  },
};

export const spacing = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

export const typography = {
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  bodySmall: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  subtitle: { fontSize: 18, lineHeight: 26, fontWeight: '600' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  heading: { fontSize: 28, lineHeight: 36, fontWeight: '700' },
} as const;

export const radii = { none: 0, sm: 4, md: 8, lg: 12, xl: 16, pill: 9999 } as const;

function toLinear(byteValue: number): number {
  const s = byteValue / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const clean = hex.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) throw new Error(`Invalid hex colour: ${hex}`);
  const n = parseInt(clean, 16);
  return (
    0.2126 * toLinear((n >> 16) & 255) +
    0.7152 * toLinear((n >> 8) & 255) +
    0.0722 * toLinear(n & 255)
  );
}

export function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
