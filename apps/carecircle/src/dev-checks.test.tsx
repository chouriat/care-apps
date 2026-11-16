import * as UI from '@carecircle/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';
import DevChecksScreen, { oneMinuteFromNowInPhoneTz } from '../app/dev-checks';
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

  it('accepts only the exact value 1 for EXPO_PUBLIC_DEV_CHECKS, and __DEV__ alone also opens it', async () => {
    globalDev.__DEV__ = false;
    for (const value of ['0', 'true', '', ' 1']) {
      process.env.EXPO_PUBLIC_DEV_CHECKS = value;
      mockRedirect.mockClear();
      await render(
        <UI.ThemeProvider>
          <DevChecksScreen />
        </UI.ThemeProvider>,
      );
      expect(mockRedirect).toHaveBeenCalledWith(expect.objectContaining({ href: '/' }));
    }
    delete process.env.EXPO_PUBLIC_DEV_CHECKS;
    globalDev.__DEV__ = true;
    mockRedirect.mockClear();
    await render(
      <UI.ThemeProvider>
        <DevChecksScreen />
      </UI.ThemeProvider>,
    );
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(screen.getByText(en.devChecks.testReminder)).toBeTruthy();
  });

  it('schedules the test reminder one minute after now, not at the current minute', () => {
    const now = Date.UTC(2026, 0, 1, 10, 0, 30);
    const { time } = oneMinuteFromNowInPhoneTz(now);
    // Every time zone offset is a whole number of 15 minutes, so 10:00:30 UTC + 1 min ends in :01.
    expect(Number(time.slice(3)) % 15).toBe(1);
  });

  it('says so when Sentry or PostHog is off in this build, and when the reminder fails', async () => {
    jest.spyOn(NotificationsApi, 'scheduleNeutralDoseReminder').mockRejectedValue(new Error('x'));
    const sendTestCrash = jest.fn();
    const sendTestEvent = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(ObservabilityApi, 'getAppObservability').mockReturnValue({
      analytics: { track: jest.fn(), sendTestEvent },
      crashReporter: { captureError: jest.fn(), sendTestCrash },
      isSentryEnabled: false,
      isPostHogEnabled: false,
      setUser: jest.fn(),
      syncAuthState: jest.fn(),
    });
    await render(
      <UI.ThemeProvider>
        <DevChecksScreen />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('dev-checks-sdk-state').props.children).toContain(en.devChecks.off);
    const status = () => screen.getByTestId('dev-checks-status').props.children;
    await fireEvent.press(screen.getByRole('button', { name: en.devChecks.testReminder }));
    await waitFor(() => expect(status()).toBe(en.devChecks.statusReminderFailed));
    await fireEvent.press(screen.getByRole('button', { name: en.devChecks.sendTestCrash }));
    expect(status()).toBe(en.devChecks.statusSentryOff);
    await fireEvent.press(screen.getByRole('button', { name: en.devChecks.sendTestEvent }));
    await waitFor(() => expect(status()).toBe(en.devChecks.statusPostHogOff));
  });

  it('fails any EAS build other than development or preview that sets EXPO_PUBLIC_DEV_CHECKS', () => {
    process.env.EXPO_PUBLIC_DEV_CHECKS = '1';
    try {
      for (const profile of ['production', 'store']) {
        process.env.EAS_BUILD_PROFILE = profile;
        expect(() => appConfigFn({ config: appJson.expo })).toThrow(/EXPO_PUBLIC_DEV_CHECKS/);
      }
      for (const profile of ['development', 'preview']) {
        process.env.EAS_BUILD_PROFILE = profile;
        expect(() => appConfigFn({ config: appJson.expo })).not.toThrow();
      }
      delete process.env.EAS_BUILD_PROFILE; // local `expo start`
      expect(() => appConfigFn({ config: appJson.expo })).not.toThrow();
    } finally {
      delete process.env.EAS_BUILD_PROFILE;
    }
  });

  it('refuses to build a store profile with mocks mode on (EXPO_PUBLIC_MOCKS or MOCKS)', () => {
    const saved = { pub: process.env.EXPO_PUBLIC_MOCKS, plain: process.env.MOCKS };
    try {
      for (const key of ['EXPO_PUBLIC_MOCKS', 'MOCKS'] as const) {
        delete process.env.EXPO_PUBLIC_MOCKS;
        delete process.env.MOCKS;
        process.env[key] = '1';
        for (const profile of ['production', 'store']) {
          process.env.EAS_BUILD_PROFILE = profile;
          expect(() => appConfigFn({ config: appJson.expo })).toThrow(new RegExp(key));
        }
        for (const profile of ['development', 'preview']) {
          process.env.EAS_BUILD_PROFILE = profile;
          expect(() => appConfigFn({ config: appJson.expo })).not.toThrow();
        }
        delete process.env.EAS_BUILD_PROFILE; // local `pnpm start:mocks`
        expect(() => appConfigFn({ config: appJson.expo })).not.toThrow();
      }
      delete process.env.EXPO_PUBLIC_MOCKS;
      delete process.env.MOCKS;
      process.env.EAS_BUILD_PROFILE = 'production';
      expect(() => appConfigFn({ config: appJson.expo })).not.toThrow();
    } finally {
      delete process.env.EAS_BUILD_PROFILE;
      if (saved.pub === undefined) delete process.env.EXPO_PUBLIC_MOCKS;
      else process.env.EXPO_PUBLIC_MOCKS = saved.pub;
      if (saved.plain === undefined) delete process.env.MOCKS;
      else process.env.MOCKS = saved.plain;
    }
  });

  it('configures @sentry/react-native/expo and uploads source maps only with token, org and project', () => {
    expect(appJson.expo.plugins).toContain('@sentry/react-native/expo');
    const sentryOptions = () =>
      (
        appConfigFn({ config: appJson.expo }).plugins.find(
          (p) => Array.isArray(p) && p[0] === '@sentry/react-native/expo',
        ) as [string, { disableAutoUpload: boolean }]
      )[1];
    const saved = { org: process.env.SENTRY_ORG, project: process.env.SENTRY_PROJECT };
    try {
      delete process.env.SENTRY_ORG;
      delete process.env.SENTRY_PROJECT;
      expect(sentryOptions()).toEqual({ disableAutoUpload: true });
      process.env.SENTRY_AUTH_TOKEN = 'sntrys_secret_token';
      expect(sentryOptions()).toEqual({ disableAutoUpload: true });
      process.env.SENTRY_PROJECT = 'project';
      expect(sentryOptions()).toEqual({ disableAutoUpload: true });
      process.env.SENTRY_ORG = 'org';
      delete process.env.SENTRY_PROJECT;
      expect(sentryOptions()).toEqual({ disableAutoUpload: true });
      process.env.SENTRY_PROJECT = 'project';
      expect(sentryOptions()).toEqual({ disableAutoUpload: false });
      expect(JSON.stringify(appConfigFn({ config: appJson.expo }))).not.toContain('sntrys_');
    } finally {
      if (saved.org === undefined) delete process.env.SENTRY_ORG;
      else process.env.SENTRY_ORG = saved.org;
      if (saved.project === undefined) delete process.env.SENTRY_PROJECT;
      else process.env.SENTRY_PROJECT = saved.project;
    }
  });
});
