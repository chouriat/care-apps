import {
  createAnalyticsClient,
  createCrashReporter,
  scrubSensitiveText,
  type AnalyticsClient,
  type AuthState,
  type CrashReporter,
  type PostHogAdapter,
  type SentryAdapter,
  type SentryScopeContext,
} from '@carecircle/core';
import * as Sentry from '@sentry/react-native';
import type { Breadcrumb, ErrorEvent, Event } from '@sentry/react-native';
import PostHog, { type PostHogOptions } from 'posthog-react-native';

// Checked 2026-11-15 against official provider SDK documentation:
// - Sentry React Native SDK options & data scrubbing (sendDefaultPii, beforeSend, beforeBreadcrumb,
//   setUser, replaysSessionSampleRate, replaysOnErrorSampleRate):
//   https://docs.sentry.io/platforms/react-native/configuration/options/
//   https://docs.sentry.io/platforms/react-native/configuration/filtering/
//   https://docs.sentry.io/platforms/react-native/data-management/sensitive-data/
// - PostHog React Native SDK configuration (autocapture, enableSessionReplay,
//   captureAppLifecycleEvents, setDefaultPersonProperties, identify):
//   https://posthog.com/docs/libraries/react-native#configuration-options

export const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com';

export interface SentryModuleLike {
  init(options: Sentry.ReactNativeOptions): void;
  captureException(exception: unknown, hintOrContext?: unknown): string;
  setUser(user: { id: string } | null): void;
}

export interface PostHogClientLike {
  capture(event: string, properties?: Record<string, string | number>): void | Promise<void>;
  identify(distinctId: string): void;
  reset(): void;
}

export type PostHogConstructorLike = new (
  apiKey: string,
  options?: PostHogOptions,
) => PostHogClientLike;

export interface ObservabilityEnvConfig {
  sentryDsn?: string;
  posthogApiKey?: string;
  posthogHost?: string;
  nodeEnv?: string;
  isDev?: boolean;
  allowInTests?: boolean;
}

function scrubNestedValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return scrubSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubNestedValue(item));
  }
  if (value && typeof value === 'object') {
    const scrubbedObj: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      scrubbedObj[key] = scrubNestedValue(entry);
    }
    return scrubbedObj;
  }
  return value;
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === 'console' || breadcrumb.type === 'console') {
    return null;
  }

  const next: Breadcrumb = { ...breadcrumb };
  if (
    (next.category === 'fetch' || next.category === 'xhr' || next.type === 'http') &&
    next.data &&
    typeof next.data === 'object'
  ) {
    // Network breadcrumbs carry the full URL. Supabase puts filters in the query string
    // (`push_tokens?token=eq.<token>`, `medications?name=eq.<name>`), so keep only the path.
    const data = { ...(next.data as Record<string, unknown>) };
    if (typeof data.url === 'string') {
      data.url = data.url.split(/[?#]/)[0];
    }
    delete data['http.query'];
    delete data['http.fragment'];
    next.data = data;
  }
  if (typeof next.message === 'string') {
    next.message = scrubSensitiveText(next.message);
  }
  if (next.data && typeof next.data === 'object') {
    next.data = scrubNestedValue(next.data) as Record<string, unknown>;
  }
  return next;
}

export function scrubSentryEvent<T extends Event>(event: T): T {
  const next: T = { ...event };

  if (typeof next.message === 'string') {
    next.message = scrubSensitiveText(next.message);
  }

  const withLogEntry = next as T & {
    logentry?: { message?: string; formatted?: string };
  };
  if (withLogEntry.logentry && typeof withLogEntry.logentry === 'object') {
    withLogEntry.logentry = {
      ...withLogEntry.logentry,
      ...(typeof withLogEntry.logentry.message === 'string'
        ? { message: scrubSensitiveText(withLogEntry.logentry.message) }
        : {}),
      ...(typeof withLogEntry.logentry.formatted === 'string'
        ? { formatted: scrubSensitiveText(withLogEntry.logentry.formatted) }
        : {}),
    };
  }

  if (next.exception?.values && Array.isArray(next.exception.values)) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map((ex) => {
        const nextEx = { ...ex };
        if (typeof nextEx.value === 'string') {
          nextEx.value = scrubSensitiveText(nextEx.value);
        }
        if (nextEx.stacktrace?.frames && Array.isArray(nextEx.stacktrace.frames)) {
          nextEx.stacktrace = {
            ...nextEx.stacktrace,
            frames: nextEx.stacktrace.frames.map((frame) => {
              const nextFrame = { ...frame };
              if (typeof nextFrame.filename === 'string') {
                nextFrame.filename = scrubSensitiveText(nextFrame.filename);
              }
              if (typeof nextFrame.abs_path === 'string') {
                nextFrame.abs_path = scrubSensitiveText(nextFrame.abs_path);
              }
              if (typeof nextFrame.function === 'string') {
                nextFrame.function = scrubSensitiveText(nextFrame.function);
              }
              if (typeof nextFrame.module === 'string') {
                nextFrame.module = scrubSensitiveText(nextFrame.module);
              }
              if (typeof nextFrame.context_line === 'string') {
                nextFrame.context_line = scrubSensitiveText(nextFrame.context_line);
              }
              if (Array.isArray(nextFrame.pre_context)) {
                nextFrame.pre_context = nextFrame.pre_context.map((line) =>
                  scrubSensitiveText(line),
                );
              }
              if (Array.isArray(nextFrame.post_context)) {
                nextFrame.post_context = nextFrame.post_context.map((line) =>
                  scrubSensitiveText(line),
                );
              }
              if (nextFrame.vars && typeof nextFrame.vars === 'object') {
                nextFrame.vars = scrubNestedValue(nextFrame.vars) as Record<string, unknown>;
              }
              return nextFrame;
            }),
          };
        }
        return nextEx;
      }),
    };
  }

  if (next.request && typeof next.request === 'object') {
    next.request = {
      ...next.request,
      ...(typeof next.request.url === 'string'
        ? { url: scrubSensitiveText(next.request.url) }
        : {}),
      ...(typeof next.request.query_string === 'string'
        ? { query_string: scrubSensitiveText(next.request.query_string) }
        : {}),
      ...(next.request.headers && typeof next.request.headers === 'object'
        ? {
            headers: scrubNestedValue(next.request.headers) as Record<string, string>,
          }
        : {}),
      ...(next.request.data !== undefined ? { data: scrubNestedValue(next.request.data) } : {}),
    };
  }

  if (Array.isArray(next.breadcrumbs)) {
    const scrubbedBreadcrumbs: Breadcrumb[] = [];
    for (const crumb of next.breadcrumbs) {
      const cleaned = scrubSentryBreadcrumb(crumb);
      if (cleaned !== null) {
        scrubbedBreadcrumbs.push(cleaned);
      }
    }
    next.breadcrumbs = scrubbedBreadcrumbs;
  }

  if (next.extra && typeof next.extra === 'object') {
    next.extra = scrubNestedValue(next.extra) as Record<string, unknown>;
  }

  if (next.user) {
    const id = typeof next.user.id === 'string' ? next.user.id.trim() : '';
    next.user = id ? { id } : undefined;
  }

  return next;
}

export function buildSentryInitOptions(dsn: string): Sentry.ReactNativeOptions {
  return {
    dsn,
    enabled: true,
    sendDefaultPii: false,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    attachScreenshot: false,
    attachViewHierarchy: false,
    enableCaptureFailedRequests: false,
    enableAutoConsoleLogs: false,
    beforeSend(event: ErrorEvent): ErrorEvent | null {
      return scrubSentryEvent(event);
    },
    beforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
      return scrubSentryBreadcrumb(breadcrumb);
    },
  };
}

export function buildPostHogOptions(host: string = DEFAULT_POSTHOG_HOST): PostHogOptions {
  return {
    host,
    enableSessionReplay: false,
    captureAppLifecycleEvents: false,
    capturePushNotificationSubscriptions: false,
    capturePushNotificationOpened: false,
    setDefaultPersonProperties: false,
    // Crashes go to Sentry only, through the scrubber. PostHog's own exception capture would
    // send unscrubbed messages and stacks.
    errorTracking: {
      autocapture: false,
    },
    // No city or country looked up from the phone's IP address
    // (https://posthog.com/docs/libraries/react-native, checked 2026-11-15; default false).
    disableGeoip: true,
  };
}

// Each EXPO_PUBLIC_ variable is written out in full on purpose. Expo copies it into a release
// build only where the code says `process.env.EXPO_PUBLIC_NAME` literally; through an alias
// (`const env = process.env`) both SDKs would silently stay off in every release build.
// https://docs.expo.dev/guides/environment-variables/ (checked 2026-11-15)
function readDefaultEnv(): ObservabilityEnvConfig {
  const globalDev = (globalThis as { __DEV__?: unknown }).__DEV__;
  return {
    sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN?.trim() || undefined,
    posthogApiKey: process.env.EXPO_PUBLIC_POSTHOG_API_KEY?.trim() || undefined,
    posthogHost: process.env.EXPO_PUBLIC_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST,
    nodeEnv: process.env.NODE_ENV?.trim() || undefined,
    isDev: typeof globalDev === 'boolean' ? globalDev : process.env.NODE_ENV !== 'production',
  };
}

export interface ObservabilityController {
  readonly analytics: AnalyticsClient;
  readonly crashReporter: CrashReporter;
  readonly isSentryEnabled: boolean;
  readonly isPostHogEnabled: boolean;
  setUser(userId: string | null): void;
  syncAuthState(state: Pick<AuthState, 'status' | 'session'>): void;
}

export function createObservabilityController(options?: {
  env?: ObservabilityEnvConfig;
  sentryModule?: SentryModuleLike;
  posthogConstructor?: PostHogConstructorLike;
}): ObservabilityController {
  const resolvedEnv = {
    ...readDefaultEnv(),
    ...options?.env,
  };
  const sentryModule: SentryModuleLike =
    options?.sentryModule ?? (Sentry as unknown as SentryModuleLike);
  const PostHogCtor: PostHogConstructorLike =
    options?.posthogConstructor ?? (PostHog as unknown as PostHogConstructorLike);

  const inTestEnv = resolvedEnv.nodeEnv === 'test' && !resolvedEnv.allowInTests;
  const sentryDsn = resolvedEnv.sentryDsn?.trim() ?? '';
  const posthogApiKey = resolvedEnv.posthogApiKey?.trim() ?? '';
  const posthogHost = resolvedEnv.posthogHost?.trim() || DEFAULT_POSTHOG_HOST;

  const isSentryEnabled = Boolean(sentryDsn) && !inTestEnv;
  const isPostHogEnabled = Boolean(posthogApiKey) && !inTestEnv;

  if (isSentryEnabled) {
    sentryModule.init(buildSentryInitOptions(sentryDsn));
  }

  const posthogClient: PostHogClientLike | null = isPostHogEnabled
    ? new PostHogCtor(posthogApiKey, buildPostHogOptions(posthogHost))
    : null;

  const sentryAdapter: SentryAdapter = {
    captureException(error: Error, context?: SentryScopeContext): string | void {
      if (!isSentryEnabled) {
        return;
      }
      return sentryModule.captureException(error, context);
    },
  };

  const posthogAdapter: PostHogAdapter = {
    async capture(event: string, properties?: Record<string, string | number>): Promise<void> {
      if (!posthogClient) {
        return;
      }
      await posthogClient.capture(event, properties);
    },
  };

  const crashReporter = createCrashReporter(sentryAdapter);
  const analytics = createAnalyticsClient(posthogAdapter, {
    isDev: resolvedEnv.isDev ?? true,
    onValidationError(err) {
      crashReporter.captureError(err, {
        feature: 'circle',
        errorCode: 'ANALYTICS_EVENT_INVALID',
      });
    },
  });

  let currentUserId: string | null = null;

  const setUser = (userId: string | null): void => {
    const normalized = typeof userId === 'string' && userId.trim() ? userId.trim() : null;
    if (normalized === currentUserId) {
      return;
    }
    currentUserId = normalized;

    if (isSentryEnabled) {
      // Never pass email or name — only the Supabase user.id when signed in.
      sentryModule.setUser(normalized ? { id: normalized } : null);
    }

    if (posthogClient) {
      if (normalized) {
        // Identify only with the Supabase user.id and no person properties.
        posthogClient.identify(normalized);
      } else {
        posthogClient.reset();
      }
    }
  };

  return {
    analytics,
    crashReporter,
    isSentryEnabled,
    isPostHogEnabled,
    setUser,
    syncAuthState(state: Pick<AuthState, 'status' | 'session'>): void {
      if (state.status === 'authenticated' && state.session?.user?.id) {
        setUser(state.session.user.id);
      } else if (state.status === 'unauthenticated') {
        setUser(null);
      }
    },
  };
}

let cachedObservability: ObservabilityController | null = null;

export function getAppObservability(): ObservabilityController {
  if (!cachedObservability) {
    cachedObservability = createObservabilityController();
  }
  return cachedObservability;
}
