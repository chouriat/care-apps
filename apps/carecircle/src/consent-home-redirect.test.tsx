import type { AuthState } from '@carecircle/core';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { Text, View } from 'react-native';
import RootLayout from '../app/_layout';
import SignInRoute from '../app/(auth)/sign-in';
import OnboardingStartRoute from '../app/(onboarding)/start';
import HomeScreen from '../app/index';
import InviteTokenRoute from '../app/invite/[token]';
import { fetchHealthConsentStatus } from './features/consent';

const USER_ID = 'cc110099-0000-4000-8000-000000000099';
const CONSENT_ISO = '2026-11-21T10:00:00.000Z';

const mockAuthState: AuthState = {
  status: 'authenticated',
  session: {
    access_token: 'jwt-cc11-home',
    refresh_token: 'refresh-cc11-home',
    user: { id: USER_ID, email: 'carer@example.com' },
  },
  errorCode: null,
  magicLinkSent: false,
  isSubmitting: false,
};

const mockRpc = jest.fn(async (fn: string) => {
  if (fn === 'give_health_consent') {
    return { data: CONSENT_ISO, error: null };
  }
  return { data: null, error: null };
});

const mockFrom = jest.fn((table: string) => {
  const rows =
    table === 'users_profile'
      ? [{ user_id: USER_ID, display_name: 'Nadia', health_consent_at: null }]
      : [];
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    limit: () => Promise.resolve({ data: rows, error: null }),
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
  };
  return builder;
});

jest.mock('./features/auth/api', () => ({
  ...jest.requireActual('./features/auth/api'),
  getAppAuthController: () => ({
    getState: () => mockAuthState,
    subscribe: () => () => undefined,
    initialize: jest.fn().mockResolvedValue(undefined),
    signOut: jest.fn().mockResolvedValue(undefined),
  }),
  getSupabaseClient: () => ({
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }),
      getSession: jest
        .fn()
        .mockResolvedValue({ data: { session: mockAuthState.session }, error: null }),
    },
    rpc: (...args: unknown[]) => mockRpc(...(args as [string])),
    from: (...args: unknown[]) => mockFrom(...(args as [string])),
  }),
}));

jest.mock('./features/notifications/api', () => ({
  ...jest.requireActual('./features/notifications/api'),
  getAppPushNotificationsController: () => ({
    syncAuthStatus: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('./features/observability/api', () => ({
  ...jest.requireActual('./features/observability/api'),
  getAppObservability: () => ({
    syncAuthState: jest.fn(),
    analytics: { track: jest.fn().mockResolvedValue(undefined) },
  }),
}));

jest.mock('./features/mocks', () => ({
  loadCareCircleMocks: () => null,
}));

describe('RootLayout consent gate when HomeScreen redirects / -> /(onboarding)/start', () => {
  const originalAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  afterAll(() => {
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = originalAnonKey;
  });

  it('keeps health-consent-screen mounted when Stack unmounts and resumes /(onboarding)/start after consent', async () => {
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
    const view = await renderRouter(
      {
        _layout: RootLayout,
        index: HomeScreen,
        '(auth)/sign-in': SignInRoute,
        '(onboarding)/start': OnboardingStartRoute,
        'invite/[token]': InviteTokenRoute,
        '(tabs)/today': () => (
          <View testID="today">
            <Text>Today</Text>
          </View>
        ),
      },
      { initialUrl: '/' },
    );

    await waitFor(() => {
      expect(screen.getByTestId('health-consent-screen')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('health-consent-checkbox'));
    await fireEvent.press(
      within(screen.getByTestId('health-consent-continue-button')).getByRole('button'),
    );

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-start-screen')).toBeTruthy();
    });

    await act(async () => {
      view.unmount();
    });
  });

  it('fetchHealthConsentStatus returns { ok: true, healthConsentAt: null } without querying when userId is missing or __authenticated__', async () => {
    mockFrom.mockClear();

    await expect(fetchHealthConsentStatus('__authenticated__')).resolves.toEqual({
      ok: true,
      healthConsentAt: null,
    });
    await expect(fetchHealthConsentStatus(null)).resolves.toEqual({
      ok: true,
      healthConsentAt: null,
    });
    await expect(fetchHealthConsentStatus('   ')).resolves.toEqual({
      ok: true,
      healthConsentAt: null,
    });

    expect(mockFrom).not.toHaveBeenCalled();
  });
});
