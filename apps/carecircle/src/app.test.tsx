import { render, screen } from '@testing-library/react-native';
import PlaceholderScreen from '../app/index';
import appConfig from '../app.json';
import en from '../i18n/en.json';

describe('CareCircle Expo shell', () => {
  it('renders placeholder copy sourced from i18n/en.json', async () => {
    await render(<PlaceholderScreen />);
    expect(screen.getByText(en.placeholder.title)).toBeTruthy();
    expect(screen.getByText(en.placeholder.subtitle)).toBeTruthy();
  });

  it('enables React Native New Architecture in app.json', () => {
    expect(appConfig.expo.newArchEnabled).toBe(true);
  });
});
