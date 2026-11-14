import { colors, MIN_TOUCH_TARGET_PT, ThemeProvider } from '@carecircle/ui';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { StyleSheet } from 'react-native';
import TokensPreviewScreen from '../app/tokens';
import en from '../i18n/en.json';

// The swatch list prints every hex, so check the painted screen colour, not just the text.
const screenBackground = () =>
  StyleSheet.flatten(screen.getByLabelText(en.tokensPreview.title).props.style).backgroundColor;

describe('TokensPreviewScreen', () => {
  afterEach(() => jest.restoreAllMocks());

  it('follows system light setting and renders light tokens', async () => {
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('light');
    await render(
      <ThemeProvider>
        <TokensPreviewScreen />
      </ThemeProvider>,
    );
    expect(screen.getByText(en.tokensPreview.title)).toBeTruthy();
    expect(screen.getByText(en.tokensPreview.schemeLight)).toBeTruthy();
    expect(screenBackground()).toBe(colors.light.background);
    expect(screen.getByText(colors.light.surfaceMuted)).toBeTruthy();
  });

  it('follows system dark setting and switches modes via 44 pt accessible controls', async () => {
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('dark');
    await render(
      <ThemeProvider>
        <TokensPreviewScreen />
      </ThemeProvider>,
    );
    expect(screen.getByText(en.tokensPreview.schemeDark)).toBeTruthy();
    expect(screenBackground()).toBe(colors.dark.background);

    const lightButton = screen.getByLabelText(en.tokensPreview.modeLightA11y);
    expect(StyleSheet.flatten(lightButton.props.style)).toEqual(
      expect.objectContaining({ minHeight: MIN_TOUCH_TARGET_PT }),
    );
    await fireEvent.press(lightButton);
    expect(screen.getByText(en.tokensPreview.schemeLight)).toBeTruthy();
    expect(screenBackground()).toBe(colors.light.background);
  });
});
