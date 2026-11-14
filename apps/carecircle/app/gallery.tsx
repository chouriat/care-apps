import * as UI from '@carecircle/ui';
import { useState } from 'react';
import { Text } from 'react-native';
import en from '../i18n/en.json';

const g = en.gallery;
const tp = en.tokensPreview;
const INITIAL_DRAFT: ReadonlyArray<UI.DraftField> = [
  { label: g.draftName, value: 'Metformin', confidence: 0.96 },
  { label: g.draftSchedule, value: '08:00, 20:00', confidence: 0.71 },
];

export default function GalleryScreen() {
  const { scheme, setMode, colors: c, typography: t } = UI.useTheme();
  const [sheetOpen, setSheetOpen] = useState(true);
  const [selectedChip, setSelectedChip] = useState(true);
  const active = scheme === 'dark' ? tp.schemeDark : tp.schemeLight;
  const noop = () => undefined;
  const closeSheet = () => setSheetOpen(false);
  const headAct = { label: g.action, onPress: () => setMode(scheme === 'dark' ? 'light' : 'dark') };
  const mainNode = <Text style={[t.body, { color: c.textPrimary }]} children={g.cardCopy} />;
  const sub = [t.bodySmall, { color: c.textSecondary }];
  const warnStyle = [t.bodySmall, { color: c.onWarningSurface }];
  const subNode = <Text style={sub} children={tp.sampleCopy} />;
  const warn = <Text style={warnStyle} children={g.chipWarning} />;
  const staticNode = <Text style={[t.caption, { color: c.textMuted }]} children={g.staticScreen} />;
  const rowProps = { title: g.rowInteractive, subtitle: tp.sampleCopy, rightText: tp.modeSystem };
  const flipChip = () => setSelectedChip((prev) => !prev);
  const sheetProps = { title: g.sheetTitle, closeLabel: g.sheetClose, onClose: closeSheet };
  const emptyAct = { label: g.btnPrimary, onPress: noop };
  const errRetry = { retryLabel: tp.modeLight, onRetry: noop };
  const draftLabels = { saveLabel: g.draftSave, lowConfidenceLabel: g.draftLow };
  const staticProps = { accessibilityLabel: g.staticScreen, scrollable: false };

  return (
    <UI.Screen accessibilityLabel={g.title}>
      <UI.Header title={g.title} subtitle={active} action={headAct} />
      <UI.Header title={g.compact} />
      <UI.Button label={g.btnPrimary} variant="primary" onPress={noop} />
      <UI.Button label={tp.modeLight} variant="secondary" onPress={noop} />
      <UI.Button label={tp.modeDark} variant="danger" onPress={noop} />
      <UI.Button label={g.btnDisabled} disabled onPress={noop} />
      <UI.Card accessibilityLabel={g.cardCopy} children={mainNode} />
      <UI.Card tone="muted" children={subNode} />
      <UI.Card tone="warning" children={warn} />
      <UI.ListRow {...rowProps} onPress={() => setSheetOpen(true)} />
      <UI.ListRow title={g.rowStatic} />
      <UI.Chip label={tp.modeSystem} selected={false} onPress={() => setSelectedChip(false)} />
      <UI.Chip label={g.rowInteractive} tone="primary" selected={selectedChip} onPress={flipChip} />
      <UI.Chip label={g.chipWarning} tone="warning" />
      <UI.Chip label={g.errorTitle} tone="danger" />
      <UI.Sheet visible={sheetOpen} {...sheetProps} children={subNode} />
      <UI.Sheet visible={false} {...sheetProps} title={g.compact} children={subNode} />
      <UI.EmptyState title={g.emptyTitle} message={tp.sampleCopy} action={emptyAct} />
      <UI.EmptyState title={g.compact} message={tp.sampleCopy} />
      <UI.ErrorState title={g.errorTitle} message={tp.sampleCopy} {...errRetry} />
      <UI.ErrorState title={g.rowStatic} message={tp.sampleCopy} />
      <UI.ConfirmDraft fields={INITIAL_DRAFT} {...draftLabels} onConfirm={noop} />
      <UI.Screen {...staticProps} children={staticNode} />
    </UI.Screen>
  );
}
