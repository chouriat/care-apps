import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { radii, spacing } from '../tokens';
import { useTheme } from './theme';

export const MIN_TOUCH_PT = 44;
export const LOW_CONFIDENCE_THRESHOLD = 0.8;

type Opt<K extends string, V = string> = Partial<Record<K, V>>;
export type ActionSpec = Record<'label', string> &
  Opt<'accessibilityLabel'> & { onPress: () => void };
export type ButtonVariant = 'primary' | 'secondary' | 'danger';
export type CardTone = 'default' | 'muted' | 'warning';
export type ChipTone = 'default' | 'primary' | 'warning' | 'danger';
export type DraftField = Record<'label' | 'value', string> & { confidence: number };

export function Screen(
  p: Record<'accessibilityLabel', string> & Opt<'scrollable', boolean> & { children: ReactNode },
) {
  const { colors: c } = useTheme();
  const s = [styles.screen, { backgroundColor: c.background }];
  const base = { accessibilityLabel: p.accessibilityLabel, children: p.children };
  if (p.scrollable === false) return <View {...base} style={[s, styles.pad]} />;
  return <ScrollView {...base} style={s} contentContainerStyle={styles.pad} />;
}

export function Button(p: ActionSpec & Opt<'variant', ButtonVariant> & Opt<'disabled', boolean>) {
  const { colors: c, typography: t } = useTheme();
  const v = p.variant ?? 'primary';
  const bg = { primary: c.primary, secondary: c.surface, danger: c.danger }[v];
  const fg = { primary: c.onPrimary, secondary: c.textPrimary, danger: c.onDanger }[v];
  const borderColor = v === 'secondary' ? c.textMuted : bg;
  const box = { backgroundColor: bg, borderColor, opacity: p.disabled ? 0.5 : 1 };
  const s = [styles.touchAlign, styles.touchBox, box];
  const a11y = p.accessibilityLabel ?? p.label;
  const state = { disabled: !!p.disabled };
  const btn = { onPress: p.onPress, disabled: p.disabled, accessibilityState: state, style: s };
  return (
    <Pressable {...btn} accessibilityRole="button" accessibilityLabel={a11y}>
      <Text style={[t.label, { color: fg }]}>{p.label}</Text>
    </Pressable>
  );
}

export function Header(p: Record<'title', string> & Opt<'subtitle'> & Opt<'action', ActionSpec>) {
  const { colors: c, typography: t } = useTheme();
  const hStyle = [t.title, { color: c.textPrimary }];
  const subStyle = [t.bodySmall, { color: c.textSecondary }];
  return (
    <View style={styles.rowBetween}>
      <View style={styles.flex}>
        <Text accessibilityRole="header" style={hStyle} children={p.title} />
        {p.subtitle ? <Text style={subStyle} children={p.subtitle} /> : null}
      </View>
      {p.action ? <Button {...p.action} variant="secondary" /> : null}
    </View>
  );
}

export function Card(
  p: Opt<'tone', CardTone> & Opt<'accessibilityLabel'> & { children: ReactNode },
) {
  const { colors: c } = useTheme();
  const tone = p.tone ?? 'default';
  const bg = { default: c.surface, muted: c.surfaceMuted, warning: c.warningSurface }[tone];
  const s = [styles.card, { backgroundColor: bg, borderColor: c.border }];
  return <View accessibilityLabel={p.accessibilityLabel} style={s} children={p.children} />;
}

export function ListRow(
  p: Record<'title', string> &
    Opt<'subtitle' | 'rightText' | 'accessibilityLabel'> & { onPress?: () => void },
) {
  const { colors: c, typography: t } = useTheme();
  const a11y = p.accessibilityLabel ?? p.title;
  const press = p.onPress ? ({ onPress: p.onPress, accessibilityRole: 'button' } as const) : {};
  const surface = { backgroundColor: c.surface, borderColor: c.border };
  const s = [styles.rowBetween, styles.listRowPad, styles.boxBorder, surface];
  const sub = [t.caption, { color: c.textSecondary }];
  const right = [t.label, { color: c.textSecondary }];
  return (
    <Pressable {...press} accessibilityLabel={a11y} style={s}>
      <View style={styles.flex}>
        <Text style={[t.body, { color: c.textPrimary }]} children={p.title} />
        {p.subtitle ? <Text style={sub} children={p.subtitle} /> : null}
      </View>
      {p.rightText ? <Text style={right} children={p.rightText} /> : null}
    </Pressable>
  );
}

export function Chip(
  p: Partial<ActionSpec> &
    Record<'label', string> &
    Opt<'selected', boolean> &
    Opt<'tone', ChipTone>,
) {
  const { colors: c, typography: t } = useTheme();
  const pairs = { default: [c.surfaceMuted, c.textPrimary], primary: [c.primary, c.onPrimary] };
  const warn = { warning: [c.warningSurface, c.onWarningSurface], danger: [c.danger, c.onDanger] };
  const [bg, fg] = { ...pairs, ...warn }[p.tone ?? (p.selected ? 'primary' : 'default')];
  const a11y = p.accessibilityLabel ?? p.label;
  const state = { selected: !!p.selected };
  const press = p.onPress
    ? ({ onPress: p.onPress, accessibilityRole: 'button', accessibilityState: state } as const)
    : {};
  const box = { backgroundColor: bg, borderColor: c.border };
  const s = [p.onPress ? styles.touchAlign : null, styles.chip, box];
  return (
    <Pressable {...press} accessibilityLabel={a11y} style={s}>
      <Text style={[p.onPress ? t.label : t.caption, { color: fg }]} children={p.label} />
    </Pressable>
  );
}

export function Sheet(
  p: Record<'title' | 'closeLabel', string> &
    Record<'visible', boolean> &
    Record<'onClose', () => void> & { children: ReactNode },
) {
  const { colors: c, typography: t } = useTheme();
  if (!p.visible) return null;
  const s = [styles.card, { backgroundColor: c.surface, borderColor: c.textMuted }];
  return (
    <View accessibilityLabel={p.title} style={s}>
      <View style={styles.rowBetween}>
        <Text style={[t.subtitle, { color: c.textPrimary }]} children={p.title} />
        <Button label={p.closeLabel} variant="secondary" onPress={p.onClose} />
      </View>
      {p.children}
    </View>
  );
}

export function EmptyState(p: Record<'title' | 'message', string> & Opt<'action', ActionSpec>) {
  const { colors: c, typography: t } = useTheme();
  return (
    <Card tone="muted" accessibilityLabel={p.title}>
      <Text style={[t.subtitle, { color: c.textPrimary }]} children={p.title} />
      <Text style={[t.bodySmall, { color: c.textSecondary }]} children={p.message} />
      {p.action ? <Button {...p.action} /> : null}
    </Card>
  );
}

export function ErrorState(
  p: Record<'title' | 'message', string> & Opt<'retryLabel'> & Opt<'onRetry', () => void>,
) {
  const { colors: c, typography: t } = useTheme();
  const s = [styles.card, { backgroundColor: c.surface, borderColor: c.danger }];
  const retry = p.onRetry && p.retryLabel ? { label: p.retryLabel, onPress: p.onRetry } : null;
  return (
    <View accessibilityLabel={p.title} style={s}>
      <Text style={[t.subtitle, { color: c.danger }]} children={p.title} />
      <Text style={[t.bodySmall, { color: c.textSecondary }]} children={p.message} />
      {retry ? <Button {...retry} variant="danger" /> : null}
    </View>
  );
}

export function ConfirmDraft(
  p: Record<'saveLabel' | 'lowConfidenceLabel', string> &
    Record<'fields', ReadonlyArray<DraftField>> & { onConfirm: (fields: DraftField[]) => void },
) {
  const { colors: c, typography: t } = useTheme();
  const [draft, setDraft] = useState<DraftField[]>(() => p.fields.map((f) => ({ ...f })));
  const update = (idx: number, value: string) =>
    setDraft((prev) => prev.map((item, i) => (i === idx ? { ...item, value } : item)));
  return (
    <Card>
      {draft.map((f, idx) => {
        const low = f.confidence < LOW_CONFIDENCE_THRESHOLD;
        const [bg, fg] = low ? [c.warningSurface, c.onWarningSurface] : [c.surface, c.textPrimary];
        const borderColor = low ? c.onWarningSurface : c.textMuted;
        const palette = { backgroundColor: bg, borderColor };
        const inp = [styles.input, styles.boxBorder, t.body, { color: fg, ...palette }];
        const inputProps = { value: f.value, accessibilityLabel: f.label, style: inp };
        const cap = [t.caption, { color: fg }];
        return (
          <View key={f.label} style={[styles.card, palette]}>
            <View style={styles.rowBetween}>
              <Text style={[t.label, { color: fg }]} children={f.label} />
              {low ? <Text style={cap} children={p.lowConfidenceLabel} /> : null}
            </View>
            <TextInput {...inputProps} onChangeText={(v) => update(idx, v)} />
          </View>
        );
      })}
      <Button label={p.saveLabel} onPress={() => p.onConfirm(draft)} />
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  pad: { padding: spacing.md, gap: spacing.sm },
  flex: { flex: 1 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  touchAlign: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  touchBox: { paddingHorizontal: spacing.md, borderRadius: radii.md, borderWidth: 1 },
  card: { padding: spacing.md, borderRadius: radii.lg, borderWidth: 1, gap: spacing.xs },
  listRowPad: { minHeight: 44, paddingHorizontal: spacing.md, paddingVertical: 8 },
  boxBorder: { borderRadius: radii.md, borderWidth: 1 },
  chip: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: radii.pill, borderWidth: 1 },
  input: { minHeight: 44, paddingHorizontal: spacing.sm },
});
