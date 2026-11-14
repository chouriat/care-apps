import * as UI from '@carecircle/ui';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { StyleSheet } from 'react-native';
import GalleryScreen from '../app/gallery';
import en from '../i18n/en.json';

const g = en.gallery;
const flatBg = (label: string) =>
  StyleSheet.flatten(screen.getByLabelText(label).props.style).backgroundColor;
const renderGallery = (mode: UI.ColorScheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(mode);
  return render(<UI.ThemeProvider children={<GalleryScreen />} />);
};

describe('Shared UI gallery and components (F-3b)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('renders every component in every state in light and dark mode', async () => {
    await renderGallery('light');
    expect(flatBg(g.title)).toBe(UI.colors.light.background);
    expect(flatBg(g.staticScreen)).toBe(UI.colors.light.background);
    expect(screen.getByLabelText(g.compact)).toBeTruthy();
    const disabledState = screen.getByLabelText(g.btnDisabled).props.accessibilityState;
    expect(disabledState).toEqual({ disabled: true });
    expect(flatBg(g.cardCopy)).toBe(UI.colors.light.surface);
    expect(screen.getAllByLabelText(g.rowStatic).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText(g.chipWarning)).toBeTruthy();
    expect(screen.queryByLabelText(g.sheetTitle)).toBeNull();
    await fireEvent.press(screen.getByLabelText(g.rowInteractive));
    expect(screen.getByLabelText(g.sheetTitle)).toBeTruthy();
    expect(screen.getByLabelText(g.emptyTitle)).toBeTruthy();
    expect(screen.getAllByLabelText(g.errorTitle).length).toBeGreaterThanOrEqual(1);

    await fireEvent.press(screen.getByLabelText(g.sheetClose));
    expect(screen.queryByLabelText(g.sheetTitle)).toBeNull();

    expect(flatBg(g.chipToggle)).toBe(UI.colors.light.primary);
    await fireEvent.press(screen.getByLabelText(g.chipToggle));
    expect(flatBg(g.chipToggle)).toBe(UI.colors.light.surfaceMuted);

    await fireEvent.press(screen.getByLabelText(g.action));
    expect(screen.getByText(en.tokensPreview.schemeDark)).toBeTruthy();
    expect(flatBg(g.title)).toBe(UI.colors.dark.background);
  });

  it('enforces accessibility labels, 44 pt touch targets, and >= 3:1 input borders', async () => {
    await renderGallery('dark');
    const buttons = screen.getAllByRole('button');
    const nameInput = screen.getByLabelText(g.draftName);
    const inputs = [nameInput, screen.getByLabelText(g.draftSchedule)];
    expect(buttons.length).toBeGreaterThanOrEqual(10);

    for (const control of [...buttons, ...inputs]) {
      expect(control.props.accessibilityLabel).toEqual(expect.stringMatching(/\S/));
      const flat = StyleSheet.flatten(control.props.style);
      expect(flat.minHeight).toBeGreaterThanOrEqual(UI.MIN_TOUCH_TARGET_PT);
    }
    for (const b of buttons) {
      expect(StyleSheet.flatten(b.props.style).minWidth).toBeGreaterThanOrEqual(44);
    }
    expect(flatBg(g.cardCopy)).toBe(UI.colors.dark.surface);
    expect(flatBg(g.draftSchedule)).toBe(UI.colors.dark.warningSurface);

    const inputStyle = StyleSheet.flatten(nameInput.props.style);
    const borderRatio = UI.contrastRatio(String(inputStyle.borderColor), UI.colors.dark.surface);
    expect(borderRatio).toBeGreaterThanOrEqual(3);
  });

  it('highlights confidence < 0.8 and never calls onConfirm without Save tap', async () => {
    const onConfirm = jest.fn<void, [UI.DraftField[]]>();
    const fields: UI.DraftField[] = [
      { label: g.draftName, value: 'Metformin', confidence: 0.95 },
      { label: g.draftSchedule, value: '08:00', confidence: 0.72 },
    ];
    const props = { fields, saveLabel: g.draftSave, lowConfidenceLabel: g.draftLow, onConfirm };
    await render(<UI.ConfirmDraft {...props} />);

    expect(flatBg(g.draftSchedule)).toBe(UI.colors.light.warningSurface);
    expect(flatBg(g.draftName)).toBe(UI.colors.light.surface);
    expect(screen.getByText(g.draftLow)).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText(g.draftName), 'Metformin XR');
    await fireEvent.changeText(screen.getByLabelText(g.draftSchedule), '08:00, 20:00');
    expect(onConfirm).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText(g.draftSave));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith([
      { ...fields[0], value: 'Metformin XR' },
      { ...fields[1], value: '08:00, 20:00' },
    ]);
  });
});
