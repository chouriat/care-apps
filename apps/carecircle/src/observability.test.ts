import { AnalyticsValidationError } from '@carecircle/core';
import * as Sentry from '@sentry/react-native';
import type { Breadcrumb, ErrorEvent } from '@sentry/react-native';
import PostHog, { type PostHogOptions } from 'posthog-react-native';
import {
  POSTHOG_AUTOCAPTURE_DISABLED,
  createObservabilityController,
} from './features/observability/api';

describe('F-7b Sentry and PostHog in the app (apps/carecircle)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps both Sentry and PostHog off when EXPO_PUBLIC_ keys are missing or in NODE_ENV=test', () => {
    const initSpy = jest.spyOn(Sentry, 'init');
    const posthogCtorMock = PostHog as unknown as jest.Mock;

    // Missing keys -> both disabled even when allowInTests is true
    const missingKeysObs = createObservabilityController({
      env: {
        sentryDsn: '',
        posthogApiKey: '',
        nodeEnv: 'production',
        allowInTests: true,
      },
    });
    expect(missingKeysObs.isSentryEnabled).toBe(false);
    expect(missingKeysObs.isPostHogEnabled).toBe(false);
    expect(initSpy).not.toHaveBeenCalled();
    expect(posthogCtorMock).not.toHaveBeenCalled();

    // Keys present, but NODE_ENV === 'test' without allowInTests -> both disabled
    const testEnvObs = createObservabilityController({
      env: {
        sentryDsn: 'https://public@o0.ingest.sentry.io/1',
        posthogApiKey: 'phc_test_key_123',
        nodeEnv: 'test',
      },
    });
    expect(testEnvObs.isSentryEnabled).toBe(false);
    expect(testEnvObs.isPostHogEnabled).toBe(false);
    expect(initSpy).not.toHaveBeenCalled();
    expect(posthogCtorMock).not.toHaveBeenCalled();
  });

  it('configures Sentry and PostHog so crashes with emails, tokens, and sign-in links arrive scrubbed and identify receives only user.id', async () => {
    let capturedSentryOptions: Sentry.ReactNativeOptions | undefined;
    const initSpy = jest.spyOn(Sentry, 'init').mockImplementation((options) => {
      capturedSentryOptions = options;
    });
    const setUserSpy = jest.spyOn(Sentry, 'setUser');
    const captureExceptionSpy = jest.spyOn(Sentry, 'captureException');

    const posthogCtorMock = PostHog as unknown as jest.Mock;
    const posthogCaptureSpy = jest.spyOn(PostHog.prototype, 'capture');
    const posthogIdentifySpy = jest.spyOn(PostHog.prototype, 'identify');
    const posthogResetSpy = jest.spyOn(PostHog.prototype, 'reset');

    const obs = createObservabilityController({
      env: {
        sentryDsn: 'https://public@o0.ingest.sentry.io/123',
        posthogApiKey: 'phc_live_key_abc',
        posthogHost: 'https://eu.i.posthog.com',
        nodeEnv: 'production',
        isDev: false,
        allowInTests: true,
      },
    });

    expect(obs.isSentryEnabled).toBe(true);
    expect(obs.isPostHogEnabled).toBe(true);
    expect(POSTHOG_AUTOCAPTURE_DISABLED).toBe(false);

    // Verify Sentry init privacy options
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(capturedSentryOptions).toBeDefined();
    expect(capturedSentryOptions?.sendDefaultPii).toBe(false);
    expect(capturedSentryOptions?.replaysSessionSampleRate).toBe(0);
    expect(capturedSentryOptions?.replaysOnErrorSampleRate).toBe(0);
    expect(capturedSentryOptions?.attachScreenshot).toBe(false);
    expect(capturedSentryOptions?.attachViewHierarchy).toBe(false);
    expect(capturedSentryOptions?.enableCaptureFailedRequests).toBe(false);
    expect(capturedSentryOptions?.enableAutoConsoleLogs).toBe(false);

    // Verify PostHog init privacy options (autocapture, session replay, lifecycle/screen capture off)
    expect(posthogCtorMock).toHaveBeenCalledTimes(1);
    expect(posthogCtorMock.mock.calls[0]).toEqual([
      'phc_live_key_abc',
      {
        host: 'https://eu.i.posthog.com',
        enableSessionReplay: false,
        captureAppLifecycleEvents: false,
        capturePushNotificationSubscriptions: false,
        capturePushNotificationOpened: false,
        setDefaultPersonProperties: false,
        errorTracking: {
          autocapture: false,
        },
      } satisfies PostHogOptions,
    ]);

    // Verify beforeBreadcrumb drops console breadcrumbs and scrubs URLs/messages
    const beforeBreadcrumb = capturedSentryOptions?.beforeBreadcrumb;
    expect(typeof beforeBreadcrumb).toBe('function');
    const droppedConsole = beforeBreadcrumb!(
      {
        category: 'console',
        message: 'console log with caregiver@example.com',
      },
      {},
    );
    expect(droppedConsole).toBeNull();

    const httpCrumb = beforeBreadcrumb!(
      {
        category: 'http',
        message:
          'Redirect to carecircle://auth/callback?code=pkce_secret_999 for nadia@example.com',
        data: {
          url: 'https://x.supabase.co/auth/v1/verify?token_hash=magic_hash_123&apikey=sb_publishable_abc',
          authorization: 'Bearer secret_bearer_xyz',
        },
      },
      {},
    );
    expect(httpCrumb).not.toBeNull();
    expect(JSON.stringify(httpCrumb)).not.toContain('pkce_secret_999');
    expect(JSON.stringify(httpCrumb)).not.toContain('nadia@example.com');
    expect(JSON.stringify(httpCrumb)).not.toContain('magic_hash_123');
    expect(JSON.stringify(httpCrumb)).not.toContain('sb_publishable_abc');
    expect(JSON.stringify(httpCrumb)).not.toContain('secret_bearer_xyz');

    // Verify beforeSend scrubs message, exception values, stack frames, request URL, breadcrumbs, and strips user PII
    const beforeSend = capturedSentryOptions?.beforeSend;
    expect(typeof beforeSend).toBe('function');

    const rawCrashEvent: ErrorEvent = {
      type: undefined,
      message:
        'Crash for nadia.benali@example.com with Bearer top_secret_jwt and carecircle://auth/callback?code=one_time_pkce_code',
      user: {
        id: 'user-uuid-42',
        email: 'nadia.benali@example.com',
        username: 'Nadia Benali',
        ip_address: '203.0.113.9',
      },
      request: {
        url: 'https://project.supabase.co/auth/v1/verify?token_hash=secret_hash_777&type=magiclink',
        query_string: 'code=one_time_pkce_code&refresh_token=rt_secret_888',
        headers: {
          authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJl',
          apikey: 'sb_secret_super_private_key',
        },
      },
      exception: {
        values: [
          {
            type: 'AuthError',
            value:
              'Failed callback carecircle://auth/callback#access_token=at_secret_555&refresh_token=rt_secret_888 for nadia.benali@example.com (ExponentPushToken[push_tok_99])',
            stacktrace: {
              frames: [
                {
                  filename:
                    'app://carecircle/auth?code=one_time_pkce_code&email=nadia.benali@example.com',
                  abs_path:
                    '/Users/nadia.benali@example.com/auth?token_hash=secret_hash_777&access_token=at_secret_555',
                  function: 'handleCallback(Bearer top_secret_jwt)',
                  context_line:
                    'const link = "carecircle://auth/callback?code=one_time_pkce_code";',
                  vars: {
                    email: 'nadia.benali@example.com',
                    pushToken: 'ExponentPushToken[push_tok_99]',
                  },
                },
              ],
            },
          },
        ],
      },
      breadcrumbs: [
        {
          category: 'console',
          message: 'Console output with nadia.benali@example.com that must be dropped',
        } as Breadcrumb,
        {
          category: 'navigation',
          message:
            'Opened carecircle://auth/callback?code=one_time_pkce_code for nadia.benali@example.com',
          data: {
            to: 'carecircle://auth/callback?token_hash=secret_hash_777',
            token: 'Bearer top_secret_jwt',
          },
        } as Breadcrumb,
      ],
    };

    const scrubbedEvent = await beforeSend!(rawCrashEvent, {});
    expect(scrubbedEvent).not.toBeNull();
    const serialized = JSON.stringify(scrubbedEvent);

    // None of the sensitive values may survive anywhere in the event payload
    expect(serialized).not.toContain('nadia.benali@example.com');
    expect(serialized).not.toContain('Nadia Benali');
    expect(serialized).not.toContain('203.0.113.9');
    expect(serialized).not.toContain('top_secret_jwt');
    expect(serialized).not.toContain('one_time_pkce_code');
    expect(serialized).not.toContain('secret_hash_777');
    expect(serialized).not.toContain('at_secret_555');
    expect(serialized).not.toContain('rt_secret_888');
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(serialized).not.toContain('sb_secret_super_private_key');
    expect(serialized).not.toContain('ExponentPushToken[push_tok_99]');
    expect(serialized).not.toContain('Console output with');

    // User object keeps only id, and console breadcrumb was removed
    expect(scrubbedEvent?.user).toEqual({ id: 'user-uuid-42' });
    expect(scrubbedEvent?.breadcrumbs).toHaveLength(1);
    expect(scrubbedEvent?.breadcrumbs?.[0]?.category).toBe('navigation');

    // Sign-in state sync: Sentry.setUser and PostHog.identify receive ONLY the Supabase user.id
    obs.syncAuthState({
      status: 'authenticated',
      session: {
        access_token: 'jwt',
        refresh_token: 'refresh',
        user: {
          id: 'supabase-user-uuid-99',
          email: 'nadia.benali@example.com',
          name: 'Nadia Benali',
        },
      },
    });

    expect(setUserSpy).toHaveBeenCalledTimes(1);
    expect(setUserSpy).toHaveBeenCalledWith({ id: 'supabase-user-uuid-99' });
    expect(posthogIdentifySpy).toHaveBeenCalledTimes(1);
    expect(posthogIdentifySpy.mock.calls[0]).toEqual(['supabase-user-uuid-99']);

    // Valid analytics event goes through createAnalyticsClient to PostHog.capture
    await obs.analytics.track('cc_med_added', { source: 'photo', scheduleCount: 2 });
    expect(posthogCaptureSpy).toHaveBeenCalledWith('cc_med_added', {
      source: 'photo',
      scheduleCount: 2,
    });

    // Sign-out clears Sentry user and resets PostHog
    obs.syncAuthState({
      status: 'unauthenticated',
      session: null,
    });
    expect(setUserSpy).toHaveBeenLastCalledWith(null);
    expect(posthogResetSpy).toHaveBeenCalledTimes(1);

    // Production runtime invalid analytics event: dropped (not sent to PostHog) and reported ONCE to Sentry
    posthogCaptureSpy.mockClear();
    captureExceptionSpy.mockClear();

    await expect(
      (obs.analytics.track as (event: string, props?: unknown) => Promise<void>)('cc_med_added', {
        source: 'manual',
        medicationName: 'Metformin 500 mg',
      }),
    ).resolves.toBeUndefined();

    // Firing the same bad call again is still dropped and does not spam Sentry a second time
    await expect(
      (obs.analytics.track as (event: string, props?: unknown) => Promise<void>)('cc_med_added', {
        source: 'manual',
        medicationName: 'Lisinopril 10 mg',
      }),
    ).resolves.toBeUndefined();

    expect(posthogCaptureSpy).not.toHaveBeenCalled();
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);

    // Development mode (isDev: true): invalid event throws AnalyticsValidationError immediately
    const devObs = createObservabilityController({
      env: {
        sentryDsn: 'https://public@o0.ingest.sentry.io/123',
        posthogApiKey: 'phc_live_key_abc',
        nodeEnv: 'development',
        isDev: true,
        allowInTests: true,
      },
    });

    await expect(
      (devObs.analytics.track as (event: string, props?: unknown) => Promise<void>)(
        'cc_med_added',
        {
          source: 'manual',
          medicationName: 'Metformin 500 mg',
        },
      ),
    ).rejects.toThrow(AnalyticsValidationError);
  });
});
