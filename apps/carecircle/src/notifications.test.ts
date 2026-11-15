import { createAuthController, type SecureStoreAdapter } from '@carecircle/core';
import * as Notifications from 'expo-notifications';
import appConfig from '../app.json';
import en from '../i18n/en.json';
import {
  DEFAULT_REMINDER_CHANNEL_ID,
  createExpoLocalNotificationAdapter,
  createPushNotificationsController,
  createSupabasePushTokenStore,
  deletePushTokenRow,
  scheduleNeutralDoseReminder,
  type ExpoNotificationsModuleLike,
  type SupabasePushRpcClientLike,
} from './features/notifications/api';

function createMockNotificationsModule(overrides?: Partial<ExpoNotificationsModuleLike>): {
  module: ExpoNotificationsModuleLike;
  calls: string[];
  emitTokenRotation: (token: { type: string; data: unknown }) => void;
  getActiveListenerCount: () => number;
} {
  const calls: string[] = [];
  const listeners = new Set<(token: { type: string; data: unknown }) => void>();

  const base: ExpoNotificationsModuleLike = {
    async getPermissionsAsync() {
      calls.push('getPermissionsAsync');
      return { status: 'undetermined', granted: false };
    },
    async requestPermissionsAsync() {
      calls.push('requestPermissionsAsync');
      return { status: 'granted', granted: true };
    },
    async getExpoPushTokenAsync(options) {
      calls.push(
        `getExpoPushTokenAsync:${options?.projectId ?? 'none'}:${
          options?.devicePushToken ? String(options.devicePushToken.data) : 'initial'
        }`,
      );
      if (options?.devicePushToken) {
        return {
          type: 'expo',
          data: `ExponentPushToken[rotated_${String(options.devicePushToken.data)}]`,
        };
      }
      return {
        type: 'expo',
        data: 'ExponentPushToken[initial_phone_token_123]',
      };
    },
    addPushTokenListener(listener) {
      calls.push('addPushTokenListener');
      listeners.add(listener);
      return {
        remove() {
          calls.push('removePushTokenListener');
          listeners.delete(listener);
        },
      };
    },
    async setNotificationChannelAsync(channelId, channel) {
      calls.push(`setNotificationChannelAsync:${channelId}:${channel.name}:${channel.importance}`);
      return null;
    },
    async scheduleNotificationAsync(request) {
      calls.push(
        `scheduleNotificationAsync:${request.trigger.type}:${
          request.trigger.channelId ?? 'no-channel'
        }:${request.content.title}`,
      );
      return request.identifier ?? 'scheduled-notif-id';
    },
    async cancelScheduledNotificationAsync(identifier) {
      calls.push(`cancelScheduledNotificationAsync:${identifier}`);
    },
    ...overrides,
  };

  return {
    module: base,
    calls,
    emitTokenRotation(token) {
      for (const listener of listeners) {
        listener(token);
      }
    },
    getActiveListenerCount() {
      return listeners.size;
    },
  };
}

describe('F-6b Notifications in the app (apps/carecircle)', () => {
  it('registers the expo-notifications config plugin in app.json', () => {
    expect(appConfig.expo.plugins).toContain('expo-notifications');
  });

  it('wires PushTokenStoreAdapter to supabase.rpc("register_push_token") and deletes by token', async () => {
    const rpcCalls: Array<{ fn: string; args: unknown }> = [];
    const deleteCalls: Array<{ table: string; column: string; value: string }> = [];

    const fakeSupabase = {
      rpc: async (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        return { data: null, error: null };
      },
      from: (table: string) => ({
        delete: () => ({
          eq: async (column: string, value: string) => {
            deleteCalls.push({ table, column, value });
            return { error: null };
          },
        }),
      }),
    } as unknown as SupabasePushRpcClientLike;

    const store = createSupabasePushTokenStore(fakeSupabase);
    const regResult = await store.registerPushToken({
      token: 'ExponentPushToken[device_abc]',
      platform: 'ios',
    });
    expect(regResult.error).toBeNull();
    expect(rpcCalls).toEqual([
      {
        fn: 'register_push_token',
        args: {
          p_token: 'ExponentPushToken[device_abc]',
          p_platform: 'ios',
        },
      },
    ]);

    const delResult = await deletePushTokenRow(' ExponentPushToken[device_abc] ', fakeSupabase);
    expect(delResult.error).toBeNull();
    expect(deleteCalls).toEqual([
      {
        table: 'push_tokens',
        column: 'token',
        value: 'ExponentPushToken[device_abc]',
      },
    ]);
  });

  it('never asks for permission before sign-in, asks once after sign-in with EAS projectId, and re-registers on token rotation', async () => {
    const mockNotif = createMockNotificationsModule();
    const registeredTokens: Array<{ token: string; platform: string }> = [];

    const pushController = createPushNotificationsController({
      notifications: mockNotif.module,
      platform: 'android',
      projectId: 'eas-project-uuid-1234',
      store: {
        async registerPushToken(reg) {
          mockNotif.calls.push(`rpc:register_push_token:${reg.token}:${reg.platform}`);
          registeredTokens.push(reg);
          return { error: null };
        },
      },
      deleteToken: async () => ({ error: null }),
    });

    // Before sign-in (loading / unauthenticated): must not touch permissions or token APIs.
    await pushController.syncAuthStatus('loading');
    await pushController.syncAuthStatus('unauthenticated');
    expect(mockNotif.calls).toEqual([]);
    expect(registeredTokens).toEqual([]);

    // Sign in: on Android, creates channel first, checks permission, requests once, gets Expo token with projectId, registers via RPC, and subscribes to rotation.
    await pushController.syncAuthStatus('authenticated');
    expect(mockNotif.calls).toEqual([
      `setNotificationChannelAsync:${DEFAULT_REMINDER_CHANNEL_ID}:${en.notifications.channelName}:${Notifications.AndroidImportance.HIGH}`,
      'getPermissionsAsync',
      'requestPermissionsAsync',
      'getExpoPushTokenAsync:eas-project-uuid-1234:initial',
      'rpc:register_push_token:ExponentPushToken[initial_phone_token_123]:android',
      'addPushTokenListener',
    ]);
    expect(pushController.getCurrentToken()).toBe('ExponentPushToken[initial_phone_token_123]');

    // Repeated syncAuthStatus('authenticated') during the same signed-in session must not prompt or register again.
    mockNotif.calls.length = 0;
    await pushController.syncAuthStatus('authenticated');
    expect(mockNotif.calls).toEqual([]);

    // Token rotation via addPushTokenListener (native device token -> exchanged with projectId -> registered via RPC).
    mockNotif.emitTokenRotation({ type: 'android', data: 'fcm_native_token_v2' });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(mockNotif.calls).toEqual([
      'getExpoPushTokenAsync:eas-project-uuid-1234:fcm_native_token_v2',
      'rpc:register_push_token:ExponentPushToken[rotated_fcm_native_token_v2]:android',
    ]);
    expect(pushController.getCurrentToken()).toBe('ExponentPushToken[rotated_fcm_native_token_v2]');
  });

  it('deletes this phone token BEFORE auth.signOut() while the session is valid, and still signs out if offline', async () => {
    const order: string[] = [];
    let sessionValid = true;
    let failDeleteOffline = false;

    const mockNotif = createMockNotificationsModule({
      async getPermissionsAsync() {
        return { status: 'granted', granted: true };
      },
    });

    const pushController = createPushNotificationsController({
      notifications: mockNotif.module,
      platform: 'ios',
      projectId: 'eas-project-uuid-1234',
      store: {
        async registerPushToken(reg) {
          order.push(`register:${reg.token}`);
          return { error: null };
        },
      },
      deleteToken: async (token) => {
        order.push(`delete:${token}:sessionValid=${sessionValid}`);
        if (failDeleteOffline) {
          throw new Error('Network request failed (offline)');
        }
        return { error: null };
      },
    });

    const memoryMap = new Map<string, string>();
    const secureStore: SecureStoreAdapter = {
      getItemAsync: async (k) => memoryMap.get(k) ?? null,
      setItemAsync: async (k, v) => {
        memoryMap.set(k, v);
      },
      deleteItemAsync: async (k) => {
        memoryMap.delete(k);
      },
    };

    const authController = createAuthController({
      secureStore,
      supabaseAuth: {
        signInWithOtp: async () => ({ error: null }),
        signInWithOAuth: async () => ({ data: { url: null }, error: null }),
        exchangeCodeForSession: async () => ({ data: { session: null }, error: null }),
        signOut: async () => {
          await pushController.unregisterBeforeSignOut();
          order.push('supabase.auth.signOut');
          sessionValid = false;
          return { error: null };
        },
      },
    });

    authController.subscribe((next) => {
      void pushController.syncAuthStatus(next.status);
    });

    // User A signs in
    sessionValid = true;
    await authController.receiveSession({
      access_token: 'jwt-user-a',
      refresh_token: 'refresh-user-a',
      user: { id: 'user-a-uuid' },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(order).toEqual(['register:ExponentPushToken[initial_phone_token_123]']);
    expect(mockNotif.getActiveListenerCount()).toBe(1);

    // User A signs out online: token delete happens BEFORE supabase.auth.signOut while sessionValid=true
    order.length = 0;
    await authController.signOut();

    expect(order).toEqual([
      'delete:ExponentPushToken[initial_phone_token_123]:sessionValid=true',
      'supabase.auth.signOut',
    ]);
    expect(pushController.getCurrentToken()).toBeNull();
    expect(mockNotif.getActiveListenerCount()).toBe(0);
    expect(authController.getState().status).toBe('unauthenticated');

    // User B signs in on the same phone, then signs out while offline (delete throws):
    // signOut must still complete and transition to unauthenticated.
    sessionValid = true;
    failDeleteOffline = true;
    order.length = 0;

    await authController.receiveSession({
      access_token: 'jwt-user-b',
      refresh_token: 'refresh-user-b',
      user: { id: 'user-b-uuid' },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['register:ExponentPushToken[initial_phone_token_123]']);

    order.length = 0;
    await authController.signOut();
    expect(order).toEqual([
      'delete:ExponentPushToken[initial_phone_token_123]:sessionValid=true',
      'supabase.auth.signOut',
    ]);
    expect(authController.getState().status).toBe('unauthenticated');
  });

  it('schedules local notifications with a DATE trigger, creates the Android channel first, and blocks health details', async () => {
    const androidMock = createMockNotificationsModule();
    const androidAdapter = createExpoLocalNotificationAdapter({
      notifications: androidMock.module,
      platform: 'android',
    });

    const reminder = await scheduleNeutralDoseReminder(
      {
        date: '2026-05-10',
        time: '08:00',
        timeZone: 'Europe/Paris',
        doseEventId: 'dose-uuid-999',
        circleId: 'circle-uuid-111',
      },
      androidAdapter,
    );

    expect(reminder.notificationId).toBe('dose-uuid-999');
    expect(reminder.triggerAtIso).toBe('2026-05-10T06:00:00.000Z');
    // Channel creation MUST happen before scheduleNotificationAsync on Android
    expect(androidMock.calls).toEqual([
      `setNotificationChannelAsync:${DEFAULT_REMINDER_CHANNEL_ID}:${en.notifications.channelName}:${Notifications.AndroidImportance.HIGH}`,
      `scheduleNotificationAsync:${Notifications.SchedulableTriggerInputTypes.DATE}:${DEFAULT_REMINDER_CHANNEL_ID}:${en.notifications.doseReminderTitle}`,
    ]);

    // On iOS, setNotificationChannelAsync is not called
    const iosMock = createMockNotificationsModule();
    const iosAdapter = createExpoLocalNotificationAdapter({
      notifications: iosMock.module,
      platform: 'ios',
    });
    await scheduleNeutralDoseReminder(
      {
        date: '2026-05-10',
        time: '08:00',
        timeZone: 'Europe/Paris',
        doseEventId: 'dose-uuid-999',
      },
      iosAdapter,
    );
    expect(iosMock.calls).toEqual([
      `scheduleNotificationAsync:${Notifications.SchedulableTriggerInputTypes.DATE}:no-channel:${en.notifications.doseReminderTitle}`,
    ]);

    // Medication names, dosages, or non-ID keys in title, body, or data are rejected
    await expect(
      iosAdapter.scheduleNotificationAsync({
        title: 'Take Metformin 500 mg',
        body: en.notifications.doseReminderBody,
        triggerDate: new Date('2026-05-10T06:00:00.000Z'),
        data: { doseEventId: 'dose-uuid-999' },
      }),
    ).rejects.toThrow(/neutral/i);

    await expect(
      iosAdapter.scheduleNotificationAsync({
        title: en.notifications.doseReminderTitle,
        body: 'Take 2 tablets with water',
        triggerDate: new Date('2026-05-10T06:00:00.000Z'),
        data: { doseEventId: 'dose-uuid-999' },
      }),
    ).rejects.toThrow(/neutral/i);

    await expect(
      iosAdapter.scheduleNotificationAsync({
        title: en.notifications.doseReminderTitle,
        body: en.notifications.doseReminderBody,
        triggerDate: new Date('2026-05-10T06:00:00.000Z'),
        data: { doseEventId: 'dose-uuid-999', medicationName: 'Metformin' },
      }),
    ).rejects.toThrow(/not allowed/i);
  });
  it('still deletes the token at sign-out when registration failed, or when the token was not fetched this launch', async () => {
    // Registration fails (offline): a row from an earlier launch may exist, so sign-out deletes anyway.
    const mockA = createMockNotificationsModule({
      async getPermissionsAsync() {
        return { status: 'granted', granted: true };
      },
    });
    const deletedA: string[] = [];
    const controllerA = createPushNotificationsController({
      notifications: mockA.module,
      platform: 'ios',
      projectId: 'eas-project-uuid-1234',
      store: {
        async registerPushToken() {
          return { error: { message: 'Network request failed' } };
        },
      },
      deleteToken: async (token) => {
        deletedA.push(token);
        return { error: null };
      },
    });
    await controllerA.syncAuthStatus('authenticated');
    await controllerA.unregisterBeforeSignOut();
    expect(deletedA).toEqual(['ExponentPushToken[initial_phone_token_123]']);

    // The app started offline, so the token was never fetched; sign-out looks it up (no prompt).
    let tokenFetchFails = true;
    const mockB = createMockNotificationsModule({
      async getPermissionsAsync() {
        return { status: 'granted', granted: true };
      },
      async requestPermissionsAsync() {
        throw new Error('must not prompt at sign-out');
      },
      async getExpoPushTokenAsync() {
        if (tokenFetchFails) throw new Error('Network request failed');
        return { type: 'expo', data: 'ExponentPushToken[phone_b]' };
      },
    });
    const deletedB: string[] = [];
    const controllerB = createPushNotificationsController({
      notifications: mockB.module,
      platform: 'android',
      projectId: 'eas-project-uuid-1234',
      store: {
        async registerPushToken() {
          return { error: null };
        },
      },
      deleteToken: async (token) => {
        deletedB.push(token);
        return { error: null };
      },
    });
    await controllerB.syncAuthStatus('authenticated');
    expect(controllerB.getCurrentToken()).toBeNull();
    tokenFetchFails = false;
    await controllerB.unregisterBeforeSignOut();
    expect(deletedB).toEqual(['ExponentPushToken[phone_b]']);
  });

  it('gives up on a hanging token delete so sign-out is never stuck', async () => {
    const mock = createMockNotificationsModule({
      async getPermissionsAsync() {
        return { status: 'granted', granted: true };
      },
    });
    const controller = createPushNotificationsController({
      notifications: mock.module,
      platform: 'ios',
      projectId: 'eas-project-uuid-1234',
      cleanupTimeoutMs: 50,
      store: {
        async registerPushToken() {
          return { error: null };
        },
      },
      deleteToken: () => new Promise(() => undefined),
    });
    await controller.syncAuthStatus('authenticated');
    const started = Date.now();
    await controller.unregisterBeforeSignOut();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
