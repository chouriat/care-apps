import { colors, contrastRatio, radii, spacing, typography, type ColorPalette } from '../tokens';
import { resolveColorScheme } from './theme';

const TEXT_CONTRAST_PAIRS: ReadonlyArray<readonly [keyof ColorPalette, keyof ColorPalette]> = [
  ['textPrimary', 'background'],
  ['textPrimary', 'surface'],
  ['textPrimary', 'surfaceMuted'],
  ['textSecondary', 'background'],
  ['textSecondary', 'surface'],
  ['textSecondary', 'surfaceMuted'],
  ['textMuted', 'background'],
  ['textMuted', 'surface'],
  ['textMuted', 'surfaceMuted'],
  ['danger', 'background'],
  ['danger', 'surface'],
  ['danger', 'surfaceMuted'],
  ['onPrimary', 'primary'],
  ['onWarningSurface', 'warningSurface'],
  ['onDanger', 'danger'],
];

describe('design tokens', () => {
  it('computes WCAG 2.1 contrast ratios accurately against reference pairs', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 2);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 2);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeLessThan(4.5);
  });

  it.each(['light', 'dark'] as const)(
    'meets WCAG AA (>= 4.5:1) for every %s mode text colour pair',
    (scheme) => {
      const palette = colors[scheme];
      for (const [fgKey, bgKey] of TEXT_CONTRAST_PAIRS) {
        expect(contrastRatio(palette[fgKey], palette[bgKey])).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('defines spacing strictly on a 4 px grid and exposes type scale and radii', () => {
    for (const px of Object.values(spacing)) {
      expect(px).toBeGreaterThan(0);
      expect(px % 4).toBe(0);
    }
    expect(typography.body.fontSize).toBe(16);
    expect(typography.heading.fontSize).toBeGreaterThan(typography.body.fontSize);
    expect(radii.md).toBe(8);
  });

  it('resolves system colour scheme with light fallback and explicit overrides', () => {
    expect(resolveColorScheme('system', 'dark')).toBe('dark');
    expect(resolveColorScheme('system', 'light')).toBe('light');
    expect(resolveColorScheme('system', null)).toBe('light');
    expect(resolveColorScheme('dark', 'light')).toBe('dark');
    expect(resolveColorScheme('light', 'dark')).toBe('light');
  });
});
