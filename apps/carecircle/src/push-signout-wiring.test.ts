// The app's real sign-out (getAppAuthController in features/auth/api.ts) must delete this
// phone's push token row while the session is still valid, then sign out. If the delete ran
// after sign-out, the database would refuse it and the signed-out person's pushes would keep
// arriving on this phone.

import { getAppAuthController } from './features/auth/api';

// jest.mock calls below are hoisted above this import by babel-jest.
const mockOrder: string[] = [];

jest.mock('@supabase/supabase-js', () => {
  const actual = jest.requireActual('@supabase/supabase-js');
  return {
    ...actual,
    createClient: jest.fn(() => ({
      auth: {
        signOut: jest.fn(async () => {
          mockOrder.push('auth.signOut');
          return { error: null };
        }),
        onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
        startAutoRefresh: jest.fn(),
        stopAutoRefresh: jest.fn(),
      },
      rpc: jest.fn(async (fn: string, args: { p_token: string }) => {
        mockOrder.push(`rpc:${fn}:${args.p_token}`);
        return { data: null, error: null };
      }),
      from: jest.fn((table: string) => ({
        delete: () => ({
          eq: async (column: string, value: string) => {
            mockOrder.push(`delete:${table}:${column}=${value}`);
            return { error: null };
          },
        }),
      })),
    })),
  };
});

jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
  setNotificationChannelAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted', granted: true })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted', granted: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({
    type: 'expo',
    data: 'ExponentPushToken[wiring_phone_token]',
  })),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
});

describe('F-6b app sign-out wiring (features/auth/api.ts)', () => {
  const originalUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  beforeAll(() => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  });

  afterAll(() => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = originalUrl;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = originalKey;
  });

  it('deletes this phone token row before supabase.auth.signOut()', async () => {
    const controller = getAppAuthController();

    await controller.receiveSession({
      access_token: 'jwt-user-a',
      refresh_token: 'refresh-user-a',
      user: { id: 'user-a-uuid' },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(mockOrder).toEqual(['rpc:register_push_token:ExponentPushToken[wiring_phone_token]']);

    mockOrder.length = 0;
    await controller.signOut();
    expect(mockOrder).toEqual([
      'delete:push_tokens:token=ExponentPushToken[wiring_phone_token]',
      'auth.signOut',
    ]);
  });
});
