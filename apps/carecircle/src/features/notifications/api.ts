import {
  assertSafeNotificationPayload,
  registerPushToken,
  scheduleLocalReminder,
  type AuthStatus,
  type LocalNotificationAdapter,
  type LocalNotificationRequest,
  type PushPlatform,
  type PushTokenRegistration,
  type PushTokenStoreAdapter,
  type ScheduledLocalReminder,
} from '@carecircle/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import en from '../../../i18n/en.json';
import { getSupabaseClient } from '../auth/api';

// Checked 2026-11-15 against Expo SDK 58 Notifications documentation:
// - API reference (setNotificationChannelAsync, getPermissionsAsync, requestPermissionsAsync,
//   getExpoPushTokenAsync, addPushTokenListener, SchedulableTriggerInputTypes.DATE):
//   https://docs.expo.dev/versions/latest/sdk/notifications/
// - Push notifications setup (Android channel before permission prompt on Android 13+,
//   EAS projectId requirement for getExpoPushTokenAsync):
//   https://docs.expo.dev/push-notifications/push-notifications-setup/

export const DEFAULT_REMINDER_CHANNEL_ID = 'carecircle-reminders';

// Sign-out waits for the push token row to be deleted. On a slow network that request can
// hang for a long time, so give up after this long and sign out anyway.
export const SIGN_OUT_TOKEN_CLEANUP_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const EXPO_PUSH_TOKEN_FORMAT = /^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;

export interface ExpoNotificationsModuleLike {
  getPermissionsAsync(): Promise<{ status: string; granted?: boolean }>;
  requestPermissionsAsync(): Promise<{ status: string; granted?: boolean }>;
  getExpoPushTokenAsync(options?: {
    projectId?: string;
    devicePushToken?: { type: string; data: unknown };
  }): Promise<{ type: 'expo'; data: string }>;
  addPushTokenListener(listener: (token: { type: string; data: unknown }) => void): {
    remove(): void;
  };
  setNotificationChannelAsync(
    channelId: string,
    channel: { name: string; importance: number },
  ): Promise<unknown>;
  scheduleNotificationAsync(request: {
    identifier?: string;
    content: {
      title: string;
      body: string;
      sound?: 'default';
      data?: Record<string, string>;
    };
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE;
      date: Date;
      channelId?: string;
    };
  }): Promise<string>;
  cancelScheduledNotificationAsync(identifier: string): Promise<void>;
}

export type SupabasePushRpcClientLike = Pick<SupabaseClient, 'rpc' | 'from'>;

export function resolveEasProjectId(
  explicitProjectId?: string,
  constantsLike: {
    easConfig?: { projectId?: string } | null;
    expoConfig?: { extra?: { eas?: { projectId?: string } } } | null;
  } = Constants,
): string | undefined {
  if (explicitProjectId && explicitProjectId.trim()) {
    return explicitProjectId.trim();
  }
  const fromEasConfig = constantsLike.easConfig?.projectId?.trim();
  if (fromEasConfig) {
    return fromEasConfig;
  }
  const fromExpoExtra = constantsLike.expoConfig?.extra?.eas?.projectId?.trim();
  if (fromExpoExtra) {
    return fromExpoExtra;
  }
  // Written out in full on purpose: Expo copies an EXPO_PUBLIC_ variable into a release build
  // only where the code says `process.env.EXPO_PUBLIC_NAME` literally (see PR #16).
  const fromEnv = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();
  return fromEnv || undefined;
}

export function createSupabasePushTokenStore(
  supabase: SupabasePushRpcClientLike = getSupabaseClient(),
): PushTokenStoreAdapter {
  return {
    async registerPushToken(registration: PushTokenRegistration) {
      const { error } = await supabase.rpc('register_push_token', {
        p_token: registration.token,
        p_platform: registration.platform,
      });
      return {
        error: error ? { message: error.message, code: error.code } : null,
      };
    },
  };
}

export async function deletePushTokenRow(
  token: string,
  supabase: SupabasePushRpcClientLike = getSupabaseClient(),
): Promise<{ error: { message: string; code?: string } | null }> {
  const trimmed = token.trim();
  if (!trimmed) {
    return { error: null };
  }
  const { error } = await supabase.from('push_tokens').delete().eq('token', trimmed);
  return {
    error: error ? { message: error.message, code: error.code } : null,
  };
}

export function createExpoLocalNotificationAdapter(options?: {
  notifications?: Pick<
    ExpoNotificationsModuleLike,
    'setNotificationChannelAsync' | 'scheduleNotificationAsync' | 'cancelScheduledNotificationAsync'
  >;
  platform?: string;
  channelId?: string;
  channelName?: string;
}): LocalNotificationAdapter {
  const notifications =
    options?.notifications ?? (Notifications as unknown as ExpoNotificationsModuleLike);
  const platform = options?.platform ?? Platform.OS;
  const channelId = options?.channelId ?? DEFAULT_REMINDER_CHANNEL_ID;
  const channelName = options?.channelName ?? en.notifications.channelName;

  return {
    async scheduleNotificationAsync(request: LocalNotificationRequest): Promise<string> {
      assertSafeNotificationPayload({
        title: request.title,
        body: request.body,
        data: request.data,
      });
      if (!(request.triggerDate instanceof Date) || Number.isNaN(request.triggerDate.getTime())) {
        throw new Error('Local notification triggerDate must be a valid Date');
      }

      if (platform === 'android') {
        await notifications.setNotificationChannelAsync(channelId, {
          name: channelName,
          importance: Notifications.AndroidImportance.HIGH,
        });
      }

      return notifications.scheduleNotificationAsync({
        ...(request.identifier ? { identifier: request.identifier } : {}),
        content: {
          title: request.title.trim(),
          body: request.body.trim(),
          sound: 'default',
          ...(request.data ? { data: request.data } : {}),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: request.triggerDate,
          ...(platform === 'android' ? { channelId } : {}),
        },
      });
    },

    async cancelScheduledNotificationAsync(identifier: string): Promise<void> {
      await notifications.cancelScheduledNotificationAsync(identifier);
    },
  };
}

export async function scheduleNeutralDoseReminder(
  input: {
    identifier?: string;
    date: string;
    time: string;
    timeZone: string;
    doseEventId: string;
    circleId?: string;
  },
  adapter: LocalNotificationAdapter = createExpoLocalNotificationAdapter(),
): Promise<ScheduledLocalReminder> {
  const data: Record<string, string> = {
    doseEventId: input.doseEventId,
    type: 'dose_reminder',
    ...(input.circleId ? { circleId: input.circleId } : {}),
  };
  return scheduleLocalReminder(adapter, {
    identifier: input.identifier ?? input.doseEventId,
    date: input.date,
    time: input.time,
    timeZone: input.timeZone,
    title: en.notifications.doseReminderTitle,
    body: en.notifications.doseReminderBody,
    data,
  });
}

export interface PushNotificationsController {
  syncAuthStatus(status: AuthStatus): Promise<void>;
  unregisterBeforeSignOut(): Promise<void>;
  getCurrentToken(): string | null;
}

export function createPushNotificationsController(options?: {
  notifications?: Pick<
    ExpoNotificationsModuleLike,
    | 'getPermissionsAsync'
    | 'requestPermissionsAsync'
    | 'getExpoPushTokenAsync'
    | 'addPushTokenListener'
    | 'setNotificationChannelAsync'
  >;
  store?: PushTokenStoreAdapter;
  deleteToken?: (token: string) => Promise<{ error: { message: string; code?: string } | null }>;
  platform?: string;
  projectId?: string;
  channelId?: string;
  channelName?: string;
  cleanupTimeoutMs?: number;
}): PushNotificationsController {
  const notifications =
    options?.notifications ?? (Notifications as unknown as ExpoNotificationsModuleLike);
  const getStore = (): PushTokenStoreAdapter => options?.store ?? createSupabasePushTokenStore();
  const deleteToken = options?.deleteToken ?? ((token: string) => deletePushTokenRow(token));
  const platform = options?.platform ?? Platform.OS;
  const channelId = options?.channelId ?? DEFAULT_REMINDER_CHANNEL_ID;
  const channelName = options?.channelName ?? en.notifications.channelName;
  const cleanupTimeoutMs = options?.cleanupTimeoutMs ?? SIGN_OUT_TOKEN_CLEANUP_TIMEOUT_MS;

  let sessionGeneration = 0;
  let isAuthenticatedSession = false;
  let promptedInSession = false;
  let currentToken: string | null = null;
  let tokenSubscription: { remove(): void } | null = null;

  const clearSubscription = (): void => {
    if (tokenSubscription) {
      tokenSubscription.remove();
      tokenSubscription = null;
    }
  };

  const resolveProjectId = (): string | undefined => resolveEasProjectId(options?.projectId);

  const registerExpoToken = async (
    rawExpoToken: string,
    expectedGeneration: number,
  ): Promise<void> => {
    if (!isAuthenticatedSession || sessionGeneration !== expectedGeneration) {
      return;
    }
    if (platform !== 'ios' && platform !== 'android') {
      return;
    }
    const trimmed = rawExpoToken.trim();
    // Remember this phone's token before registering: if registration fails (offline) a row from
    // an earlier launch may still exist, and sign-out must still delete it.
    currentToken = trimmed;
    const registered = await registerPushToken(getStore(), {
      token: trimmed,
      platform: platform as PushPlatform,
    });
    if (!isAuthenticatedSession || sessionGeneration !== expectedGeneration) {
      return;
    }
    currentToken = registered.token;
  };

  const handleTokenRotation = async (
    deviceToken: { type: string; data: unknown },
    expectedGeneration: number,
  ): Promise<void> => {
    if (!isAuthenticatedSession || sessionGeneration !== expectedGeneration) {
      return;
    }
    try {
      let rotatedExpoToken: string;
      if (
        typeof deviceToken?.data === 'string' &&
        EXPO_PUSH_TOKEN_FORMAT.test(deviceToken.data.trim())
      ) {
        rotatedExpoToken = deviceToken.data.trim();
      } else {
        const projectId = resolveProjectId();
        const result = await notifications.getExpoPushTokenAsync({
          ...(projectId ? { projectId } : {}),
          devicePushToken: deviceToken,
        });
        rotatedExpoToken = result.data.trim();
      }
      await registerExpoToken(rotatedExpoToken, expectedGeneration);
    } catch {
      // Offline or transient failure during background token rotation; next launch/rotation retries.
    }
  };

  const lookUpTokenWithoutPrompt = async (): Promise<string | null> => {
    if (platform !== 'ios' && platform !== 'android') {
      return null;
    }
    const perms = await notifications.getPermissionsAsync();
    if (!(perms.granted === true || perms.status === 'granted')) {
      return null;
    }
    const projectId = resolveProjectId();
    const result = await notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    const token = result.data.trim();
    return EXPO_PUSH_TOKEN_FORMAT.test(token) ? token : null;
  };

  return {
    getCurrentToken(): string | null {
      return currentToken;
    },

    async syncAuthStatus(status: AuthStatus): Promise<void> {
      if (status !== 'authenticated') {
        sessionGeneration += 1;
        isAuthenticatedSession = false;
        promptedInSession = false;
        clearSubscription();
        return;
      }

      if (platform !== 'ios' && platform !== 'android') {
        return;
      }

      if (promptedInSession && isAuthenticatedSession) {
        return;
      }

      const currentGeneration = ++sessionGeneration;
      isAuthenticatedSession = true;
      promptedInSession = true;

      try {
        // On Android 13+, create the notification channel before requesting permissions.
        if (platform === 'android') {
          await notifications.setNotificationChannelAsync(channelId, {
            name: channelName,
            importance: Notifications.AndroidImportance.HIGH,
          });
          if (!isAuthenticatedSession || sessionGeneration !== currentGeneration) {
            return;
          }
        }

        const existingPerms = await notifications.getPermissionsAsync();
        if (!isAuthenticatedSession || sessionGeneration !== currentGeneration) {
          return;
        }

        let granted = existingPerms.granted === true || existingPerms.status === 'granted';
        if (!granted) {
          const requestedPerms = await notifications.requestPermissionsAsync();
          if (!isAuthenticatedSession || sessionGeneration !== currentGeneration) {
            return;
          }
          granted = requestedPerms.granted === true || requestedPerms.status === 'granted';
        }

        if (!granted) {
          return;
        }

        const projectId = resolveProjectId();
        const expoToken = await notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined,
        );
        if (!isAuthenticatedSession || sessionGeneration !== currentGeneration) {
          return;
        }

        await registerExpoToken(expoToken.data, currentGeneration);
        if (!isAuthenticatedSession || sessionGeneration !== currentGeneration) {
          return;
        }

        clearSubscription();
        tokenSubscription = notifications.addPushTokenListener((deviceToken) => {
          void handleTokenRotation(deviceToken, currentGeneration);
        });
      } catch {
        // Permission check, Expo push service, or RPC failed (e.g. offline); do not crash the app.
      }
    },

    async unregisterBeforeSignOut(): Promise<void> {
      sessionGeneration += 1;
      isAuthenticatedSession = false;
      promptedInSession = false;
      clearSubscription();

      let tokenToDelete = currentToken;
      currentToken = null;

      try {
        if (!tokenToDelete) {
          // The token was not fetched this launch (for example the app started offline). A row
          // from an earlier launch may still exist, so look the token up without prompting.
          tokenToDelete = await withTimeout(lookUpTokenWithoutPrompt(), cleanupTimeoutMs);
        }
        if (tokenToDelete) {
          await withTimeout(deleteToken(tokenToDelete), cleanupTimeoutMs);
        }
      } catch {
        // Offline, slow network or timeout: sign out anyway; the next user's register_push_token
        // moves the token.
      }
    },
  };
}

let cachedPushController: PushNotificationsController | null = null;

export function getAppPushNotificationsController(): PushNotificationsController {
  if (!cachedPushController) {
    cachedPushController = createPushNotificationsController();
  }
  return cachedPushController;
}
