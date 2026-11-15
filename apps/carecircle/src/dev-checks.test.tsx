import * as UI from '@carecircle/ui';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Share } from 'react-native';
import DevChecksScreen from '../app/dev-checks';
import appJson from '../app.json';
import easJson from '../eas.json';
import en from '../i18n/en.json';
import * as NotificationsApi from './features/notifications/api';
import * as ObservabilityApi from './features/observability/api';

const appConfigFn =
  jest.requireActual<(ctx: { config: typeof appJson.expo }) => { plugins: unknown[] }>(
    '../app.config.js',
  );

const mockRedirect = jest.fn((_props: { href: string }) => null);
jest.mock('expo-router', () => ({
  Redirect: (props: { href: string }) => mockRedirect(props),
}));

describe('F-6b/F-7b dev-checks screen and Sentry/PostHog build config', () => {
  const globalDev = globalThis as { __DEV__?: boolean };
  const originalDev = globalDev.__DEV__;
  const originalFlag = process.env.EXPO_PUBLIC_DEV_CHECKS;
  const originalSentryToken = process.env.SENTRY_AUTH_TOKEN;

  beforeEach(() => {
    mockRedirect.mockClear();
    globalDev.__DEV__ = true;
    delete process.env.EXPO_PUBLIC_DEV_CHECKS;
    delete process.env.SENTRY_AUTH_TOKEN;
  });

  afterEach(() => {
    globalDev.__DEV__ = originalDev;
    if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_DEV_CHECKS;
    else process.env.EXPO_PUBLIC_DEV_CHECKS = originalFlag;
    if (originalSentryToken === undefined) delete process.env.SENTRY_AUTH_TOKEN;
    else process.env.SENTRY_AUTH_TOKEN = originalSentryToken;
    jest.restoreAllMocks();
  });

  it('redirects to / when neither __DEV__ nor EXPO_PUBLIC_DEV_CHECKS=1 is set, and never sets the flag in production EAS', async () => {
    expect(easJson.build.development.env.EXPO_PUBLIC_DEV_CHECKS).toBe('1');
    expect(easJson.build.preview.env.EXPO_PUBLIC_DEV_CHECKS).toBe('1');
    expect((easJson.build.production as { env?: Record<string, string> }).env).toBeUndefined();

    globalDev.__DEV__ = false;
    await render(
      <UI.ThemeProvider>
        <DevChecksScreen />
      </UI.ThemeProvider>,
    );
    expect(mockRedirect).toHaveBeenCalledWith(expect.objectContaining({ href: '/' }));
    expect(screen.queryByText(en.devChecks.testReminder)).toBeNull();
  });

  it('triggers reminder in 1 minute, shows/copies push token without logging it, and sends test crash and event', async () => {
    globalDev.__DEV__ = false;
    process.env.EXPO_PUBLIC_DEV_CHECKS = '1';

    const reminderSpy = jest
      .spyOn(NotificationsApi, 'scheduleNeutralDoseReminder')
      .mockResolvedValue({
        notificationId: 'notif-1',
        triggerDate: new Date(),
        triggerAtMs: Date.now() + 60_000,
        triggerAtIso: new Date().toISOString(),
        adjustedLocalTime: '12:01',
      });
    const fakeToken = 'ExponentPushToken[DevChecksToken123]';
    jest.spyOn(NotificationsApi, 'getAppPushNotificationsController').mockReturnValue({
      syncAuthStatus: jest.fn(),
      unregisterBeforeSignOut: jest.fn(),
      getCurrentToken: () => fakeToken,
    });
    const sendTestCrash = jest.fn();
    const sendTestEvent = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(ObservabilityApi, 'getAppObservability').mockReturnValue({
      analytics: { track: jest.fn(), sendTestEvent },
      crashReporter: { captureError: jest.fn(), sendTestCrash },
      isSentryEnabled: true,
      isPostHogEnabled: true,
      setUser: jest.fn(),
      syncAuthState: jest.fn(),
    });
    const shareSpy = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction', activityType: undefined });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await render(
      <UI.ThemeProvider>
        <DevChecksScreen />
      </UI.ThemeProvider>,
    );

    await fireEvent.press(screen.getByRole('button', { name: en.devChecks.testReminder }));
    expect(reminderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        doseEventId: '00000000-0000-4000-8000-000000000001',
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        time: expect.stringMatching(/^\d{2}:\d{2}$/),
      }),
    );

    await fireEvent.press(screen.getByRole('button', { name: en.devChecks.showPushToken }));
    expect(screen.getByTestId('dev-checks-push-token').props.children).toBe(fakeToken);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(fakeToken);

    await fireEvent.press(screen.getByRole('button', { name: en.devChecks.copyPushToken }));
    expect(shareSpy).toHaveBeenCalledWith({ message: fakeToken });

    await fireEvent.press(screen.getByRole('button', { name: en.devChecks.sendTestCrash }));
    expect(sendTestCrash).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByRole('button', { name: en.devChecks.sendTestEvent }));
    expect(sendTestEvent).toHaveBeenCalledTimes(1);
  });

  it('configures @sentry/react-native/expo and skips source-map upload when SENTRY_AUTH_TOKEN is missing', () => {
    expect(appJson.expo.plugins).toContain('@sentry/react-native/expo');

    const withoutToken = appConfigFn({ config: appJson.expo });
    expect(withoutToken.plugins).toContainEqual([
      '@sentry/react-native/expo',
      { disableAutoUpload: true },
    ]);

    process.env.SENTRY_AUTH_TOKEN = 'sntrys_secret_token';
    const withToken = appConfigFn({ config: appJson.expo });
    expect(withToken.plugins).toContainEqual([
      '@sentry/react-native/expo',
      { disableAutoUpload: false },
    ]);
    expect(JSON.stringify(withToken)).not.toContain('sntrys_secret_token');
  });
});
