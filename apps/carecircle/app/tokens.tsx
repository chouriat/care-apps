import { MIN_TOUCH_TARGET_PT, radii, spacing, useTheme, type ThemeMode } from '@carecircle/ui';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import en from '../i18n/en.json';

const MODES: ReadonlyArray<{ mode: ThemeMode; label: string; a11y: string }> = [
  { mode: 'system', label: en.tokensPreview.modeSystem, a11y: en.tokensPreview.modeSystemA11y },
  { mode: 'light', label: en.tokensPreview.modeLight, a11y: en.tokensPreview.modeLightA11y },
  { mode: 'dark', label: en.tokensPreview.modeDark, a11y: en.tokensPreview.modeDarkA11y },
];

export default function TokensPreviewScreen() {
  const { scheme, mode, setMode, colors, typography } = useTheme();
  const activeCopy = scheme === 'dark' ? en.tokensPreview.schemeDark : en.tokensPreview.schemeLight;
  const headingStyle = [typography.subtitle, { color: colors.textPrimary }];

  return (
    <ScrollView
      style={[styles.screen, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
      accessibilityLabel={en.tokensPreview.title}
    >
      <Text style={[typography.heading, { color: colors.textPrimary }]}>
        {en.tokensPreview.title}
      </Text>
      <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{activeCopy}</Text>

      <View style={styles.row}>
        {MODES.map((opt) => {
          const active = mode === opt.mode;
          return (
            <Pressable
              key={opt.mode}
              onPress={() => setMode(opt.mode)}
              accessibilityRole="button"
              accessibilityLabel={opt.a11y}
              accessibilityState={{ selected: active }}
              style={[
                styles.modeBtn,
                {
                  borderColor: active ? colors.primary : colors.border,
                  backgroundColor: active ? colors.primary : colors.surface,
                },
              ]}
            >
              <Text
                style={[
                  typography.label,
                  { color: active ? colors.onPrimary : colors.textPrimary },
                ]}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={headingStyle}>{en.tokensPreview.colorsHeading}</Text>
      {Object.entries(colors).map(([key, hex]) => (
        <View
          key={key}
          style={[styles.swatch, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <View style={[styles.chip, { backgroundColor: hex, borderColor: colors.border }]} />
          <Text style={[typography.bodySmall, { color: colors.textPrimary }]}>{key}</Text>
          <Text style={[typography.caption, { color: colors.textMuted }]}>{hex}</Text>
        </View>
      ))}

      <Text style={headingStyle}>{en.tokensPreview.spacingHeading}</Text>
      {Object.entries(spacing).map(([name, px]) => (
        <View key={name} style={styles.row}>
          <Text style={[typography.caption, styles.spaceKey, { color: colors.textSecondary }]}>
            {name}
          </Text>
          <View style={[styles.spaceBar, { width: px, backgroundColor: colors.primary }]} />
        </View>
      ))}

      <Text style={headingStyle}>{en.tokensPreview.typographyHeading}</Text>
      {Object.entries(typography).map(([variant, spec]) => (
        <Text key={variant} style={[spec, { color: colors.textPrimary }]}>
          {en.tokensPreview.sampleCopy}
        </Text>
      ))}

      <Text style={headingStyle}>{en.tokensPreview.radiiHeading}</Text>
      <View style={[styles.row, styles.wrap]}>
        {Object.entries(radii).map(([name, radius]) => (
          <View
            key={name}
            style={[styles.radius, { borderRadius: radius, backgroundColor: colors.surfaceMuted }]}
          >
            <Text style={[typography.caption, { color: colors.textPrimary }]}>{name}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing.md, gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  wrap: { flexWrap: 'wrap' },
  modeBtn: {
    minHeight: MIN_TOUCH_TARGET_PT,
    minWidth: MIN_TOUCH_TARGET_PT,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatch: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.xs,
    borderRadius: radii.sm,
    borderWidth: 1,
  },
  chip: { width: spacing.lg, height: spacing.lg, borderRadius: radii.sm, borderWidth: 1 },
  spaceKey: { width: spacing.xxl },
  spaceBar: { height: spacing.sm, borderRadius: radii.sm },
  radius: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
});
