// CC-11 [safety 1/2]: Real-router Jest tests for explicit health-data consent (GDPR Art. 9(2)(a)).
//
// Proposed UI & RPC contract for CC-11 [safety 2/2]:
// - Database column: `public.users_profile.health_consent_at timestamptz` (`null` = consent not yet given).
// - RPC: `client.rpc('give_health_consent')` returning the recorded `timestamptz` (`now()` on first call,
//   preserving the original timestamp on repeat calls).
// - Router consent gate (`RootLayout` in `app/_layout.tsx` before `/(onboarding)/start`, `/invite/[token]`,
//   or `/` when creating/joining a circle):
//   - After sign-in, a user with `users_profile.health_consent_at === null` who is about to create a circle
//     or accept an invite sees `testID="health-consent-screen"` BEFORE `OnboardingStartRoute` or
//     `InviteTokenRoute` can call `create_circle` or `accept_invite`.
//   - Plain-language statement on `health-consent-screen` explains that CareCircle stores health information
//     about the person they care for, and renders a pressable Privacy Policy link
//     (`testID="health-consent-privacy-link"`).
//   - Checkbox (`testID="health-consent-checkbox"`, `accessibilityRole="checkbox"`) starts unticked
//     (`accessibilityState.checked === false`), and the "Continue" button
//     (`testID="health-consent-continue-button"`) stays disabled (`accessibilityState.disabled === true`)
//     until the checkbox is ticked.
//   - Ticking the checkbox and tapping "Continue" once calls `rpc('give_health_consent')` once (ignoring
//     duplicate taps while in flight), then continues the normal create-circle or invite-accept flow.
//   - Tapping "Decline" (`testID="health-consent-decline-button"`) sends 0 RPC calls, shows a short
//     explanation (`testID="health-consent-declined-message"`), and offers a sign-out button
//     (`testID="health-consent-sign-out-button"`).
//   - A user whose `users_profile.health_consent_at` is already non-null never sees `health-consent-screen`.
//   - Existing circle members (already in `circles` before CC-11, even with `health_consent_at === null`)
//     are not locked out of reading Today (`/(tabs)/today`).
//   - Offline: when `give_health_consent` fails over the network, `health-consent-screen` shows
//     `testID="health-consent-offline"` saying a connection is needed, and nothing pretends to be saved.
//   - Analytics: none (`analytics.track` is never called for consent, decline, or offline failure).

import type { AuthState } from '@carecircle/core';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { Linking, Text, View } from 'react-native';
import RootLayout from '../app/_layout';
import SignInRoute from '../app/(auth)/sign-in';
import OnboardingStartRoute from '../app/(onboarding)/start';
import HomeScreen from '../app/index';
import InviteTokenRoute from '../app/invite/[token]';
import { setPendingInviteToken } from './features/circle';

const USER_ID = 'cc110001-0000-4000-8000-000000000001';
const CIRCLE_ID = 'cc11c001-0000-4000-8000-000000000001';
const CONSENT_ISO = '2026-11-21T10:00:00.000Z';
const VALID_INVITE_TOKEN = 'cc110001111122223333444455556666777788889999aaaabbbbccccdddd0001';
const CONSENTED_INVITE_TOKEN = 'cc110002111122223333444455556666777788889999aaaabbbbccccdddd0002';

type RpcCall = { fn: string; args: unknown };

let mockAuthState: AuthState = {
  status: 'authenticated',
  session: {
    access_token: 'jwt-cc11',
    refresh_token: 'refresh-cc11',
    user: {
      id: USER_ID,
      email: 'carer@example.com',
    },
  },
  errorCode: null,
  magicLinkSent: false,
  isSubmitting: false,
};
const mockAuthListeners = new Set<(next: AuthState) => void>();

const mockSignOut = jest.fn(async () => {
  mockAuthState = {
    status: 'unauthenticated',
    session: null,
    errorCode: null,
    magicLinkSent: false,
    isSubmitting: false,
  };
  for (const listener of mockAuthListeners) {
    listener(mockAuthState);
  }
});

const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockTrack = jest.fn().mockResolvedValue(undefined);
const mockSyncAuthState = jest.fn();
const mockSyncPushStatus = jest.fn().mockResolvedValue(undefined);

jest.mock('./features/auth/api', () => ({
  ...jest.requireActual('./features/auth/api'),
  getAppAuthController: () => ({
    getState: () => mockAuthState,
    subscribe: (listener: (next: AuthState) => void) => {
      mockAuthListeners.add(listener);
      return () => {
        mockAuthListeners.delete(listener);
      };
    },
    initialize: jest.fn().mockResolvedValue(undefined),
    signInWithEmail: jest.fn().mockResolvedValue(undefined),
    signInWithOAuth: jest.fn().mockResolvedValue(undefined),
    signOut: () => mockSignOut(),
  }),
  getSupabaseClient: () => ({
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: { user: mockAuthState.session ? { id: mockAuthState.session.user.id } : null },
        error: null,
      }),
      getSession: jest.fn().mockResolvedValue({
        data: {
          session: mockAuthState.session,
        },
        error: null,
      }),
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  }),
}));

jest.mock('./features/notifications/api', () => ({
  ...jest.requireActual('./features/notifications/api'),
  getAppPushNotificationsController: () => ({
    syncAuthStatus: (...args: unknown[]) => mockSyncPushStatus(...args),
  }),
}));

jest.mock('./features/observability/api', () => ({
  ...jest.requireActual('./features/observability/api'),
  getAppObservability: () => ({
    syncAuthState: (...args: unknown[]) => mockSyncAuthState(...args),
    analytics: {
      track: (...args: unknown[]) => mockTrack(...args),
    },
  }),
}));

jest.mock('./features/mocks', () => ({
  loadCareCircleMocks: () => null,
}));

function TodayStubScreen() {
  return (
    <View testID="cc11-today-destination">
      <Text>Today destination</Text>
    </View>
  );
}

interface ConsentTestRigOptions {
  healthConsentAt: string | null;
  circles?: Array<{ id: string }>;
  rpcOnline?: () => boolean;
}

function createConsentTestRig(opts: ConsentTestRigOptions) {
  let consentAt = opts.healthConsentAt;
  const circles = [...(opts.circles ?? [])];
  const rpcCalls: RpcCall[] = [];
  const isOnline = opts.rpcOnline ?? (() => true);

  mockFrom.mockImplementation((table: string) => {
    const getRows = (): Array<Record<string, unknown>> => {
      if (table === 'users_profile') {
        return [{ user_id: USER_ID, display_name: 'Nadia', health_consent_at: consentAt }];
      }
      if (table === 'circles') {
        return circles;
      }
      return [];
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      limit: () => Promise.resolve({ data: getRows(), error: null }),
      maybeSingle: () => Promise.resolve({ data: getRows()[0] ?? null, error: null }),
      single: () =>
        getRows()[0]
          ? Promise.resolve({ data: getRows()[0], error: null })
          : Promise.resolve({ data: null, error: { message: 'Row not found', code: 'PGRST116' } }),
      then: (
        onFulfilled?: (val: { data: unknown; error: null }) => unknown,
        onRejected?: (err: unknown) => unknown,
      ) => Promise.resolve({ data: getRows(), error: null }).then(onFulfilled, onRejected),
    };

    return builder;
  });

  mockRpc.mockImplementation(async (fn: string, args?: unknown) => {
    rpcCalls.push({ fn, args });
    if (!isOnline()) {
      return {
        data: null,
        error: { message: 'TypeError: Network request failed', code: 'NETWORK_ERROR' },
      };
    }
    if (fn === 'give_health_consent') {
      consentAt = consentAt ?? CONSENT_ISO;
      return { data: consentAt, error: null };
    }
    if (fn === 'create_circle') {
      if (!consentAt) {
        return { data: null, error: { code: 'P0001', message: 'CONSENT_REQUIRED' } };
      }
      const input = (args ?? {}) as Record<string, string>;
      const created = {
        id: CIRCLE_ID,
        name: input.name ?? 'Family Care',
        care_recipient_name: input.careRecipientName ?? 'Evelyn',
        care_recipient_dob: null,
        timezone: input.timezone ?? 'Europe/Paris',
        created_by: USER_ID,
        created_at: CONSENT_ISO,
      };
      circles.push({ id: CIRCLE_ID });
      return { data: created, error: null };
    }
    if (fn === 'accept_invite') {
      if (!consentAt) {
        return { data: null, error: { code: 'P0001', message: 'CONSENT_REQUIRED' } };
      }
      circles.push({ id: CIRCLE_ID });
      return { data: { circleId: CIRCLE_ID, role: 'helper' }, error: null };
    }
    return { data: null, error: { message: `Unexpected RPC: ${fn}` } };
  });

  const routes = {
    _layout: RootLayout,
    index: HomeScreen,
    '(auth)/sign-in': SignInRoute,
    '(onboarding)/start': OnboardingStartRoute,
    'invite/[token]': InviteTokenRoute,
    '(tabs)/today': TodayStubScreen,
  };

  return {
    routes,
    rpcCalls,
    getRecordedConsent: () => consentAt,
  };
}

async function pressTarget(testId: string) {
  const node = screen.getByTestId(testId);
  const pressable =
    typeof node.props?.onPress === 'function' ? node : within(node).getByRole('button');
  await fireEvent.press(pressable);
}

describe('CC-11 Health-data consent gate through the real router', () => {
  const originalAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthListeners.clear();
    setPendingInviteToken(null);
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
    mockAuthState = {
      status: 'authenticated',
      session: {
        access_token: 'jwt-cc11',
        refresh_token: 'refresh-cc11',
        user: {
          id: USER_ID,
          email: 'carer@example.com',
        },
      },
      errorCode: null,
      magicLinkSent: false,
      isSubmitting: false,
    };
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = originalAnonKey;
  });

  it('1. shows health-consent-screen before create-circle with plain health-data copy, privacy link, unticked checkbox, disabled Continue, and continues after one give_health_consent call', async () => {
    const rig = createConsentTestRig({ healthConsentAt: null, circles: [] });
    const view = await renderRouter(rig.routes, { initialUrl: '/start' });

    await waitFor(() => {
      expect(screen.getByTestId('health-consent-screen')).toBeTruthy();
    });
    expect(screen.queryByTestId('onboarding-start-screen')).toBeNull();

    // Plain statement that CareCircle stores health information about the person cared for + privacy link
    expect(screen.getByText(/health information/i)).toBeTruthy();
    expect(screen.getByTestId('health-consent-privacy-link')).toBeTruthy();

    // Checkbox starts unticked and Continue stays disabled until ticked
    const checkbox = screen.getByTestId('health-consent-checkbox');
    expect(checkbox.props.accessibilityState?.checked).toBe(false);

    const continueNode = screen.getByTestId('health-consent-continue-button');
    const continueBtn =
      typeof continueNode.props?.onPress === 'function'
        ? continueNode
        : within(continueNode).getByRole('button');
    expect(continueBtn.props.accessibilityState?.disabled).toBe(true);

    await fireEvent.press(continueBtn);
    expect(rig.rpcCalls).toEqual([]);

    // Tick the checkbox -> Continue enables -> one tap calls give_health_consent once -> onboarding appears
    await fireEvent.press(checkbox);
    await pressTarget('health-consent-continue-button');

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-start-screen')).toBeTruthy();
    });
    expect(rig.rpcCalls.map((c) => c.fn)).toEqual(['give_health_consent']);

    // Normal create-circle flow continues to Today
    await fireEvent.changeText(screen.getByTestId('onboarding-circle-name-input'), 'Family Care');
    await fireEvent.changeText(screen.getByTestId('onboarding-recipient-name-input'), 'Evelyn');
    await pressTarget('onboarding-submit-button');

    await waitFor(() => {
      expect(screen.getByTestId('cc11-today-destination')).toBeTruthy();
    });
    expect(rig.rpcCalls.map((c) => c.fn)).toEqual(['give_health_consent', 'create_circle']);

    await act(async () => {
      view.unmount();
    });
  });

  it('2. shows health-consent-screen before invite-accept and only calls accept_invite after give_health_consent succeeds', async () => {
    const rig = createConsentTestRig({ healthConsentAt: null, circles: [] });
    const view = await renderRouter(rig.routes, {
      initialUrl: `/invite/${VALID_INVITE_TOKEN}`,
    });

    await waitFor(() => {
      expect(screen.getByTestId('health-consent-screen')).toBeTruthy();
    });
    // Must not call accept_invite before consent is recorded
    expect(rig.rpcCalls).toEqual([]);

    await fireEvent.press(screen.getByTestId('health-consent-checkbox'));
    await pressTarget('health-consent-continue-button');

    await waitFor(() => {
      expect(screen.getByTestId('cc11-today-destination')).toBeTruthy();
    });
    expect(rig.rpcCalls).toEqual([
      { fn: 'give_health_consent', args: undefined },
      { fn: 'accept_invite', args: { token: VALID_INVITE_TOKEN } },
    ]);

    await act(async () => {
      view.unmount();
    });
  });

  it('3. ignores a second tap on Continue while give_health_consent is still in flight', async () => {
    const rig = createConsentTestRig({ healthConsentAt: null, circles: [] });
    let resolveConsent!: (res: { data: string; error: null }) => void;
    const deferredCalls: string[] = [];

    mockRpc.mockImplementation((fn: string) => {
      deferredCalls.push(fn);
      return new Promise<{ data: string; error: null }>((resolve) => {
        resolveConsent = resolve;
      });
    });

    const view = await renderRouter(rig.routes, { initialUrl: '/start' });
    await waitFor(() => {
      expect(screen.getByTestId('health-consent-screen')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('health-consent-checkbox'));
    await pressTarget('health-consent-continue-button');
    await pressTarget('health-consent-continue-button');

    expect(deferredCalls).toEqual(['give_health_consent']);

    await act(async () => {
      resolveConsent({ data: CONSENT_ISO, error: null });
    });

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-start-screen')).toBeTruthy();
    });
    expect(deferredCalls).toHaveLength(1);

    await act(async () => {
      view.unmount();
    });
  });

  it('4. declining shows a short explanation and a sign-out option, makes no RPC call, and signs out cleanly', async () => {
    const rig = createConsentTestRig({ healthConsentAt: null, circles: [] });
    const view = await renderRouter(rig.routes, { initialUrl: '/start' });

    await waitFor(() => {
      expect(screen.getByTestId('health-consent-screen')).toBeTruthy();
    });

    await pressTarget('health-consent-decline-button');

    expect(rig.rpcCalls).toEqual([]);
    expect(screen.getByTestId('health-consent-declined-message')).toBeTruthy();
    expect(screen.getByTestId('health-consent-sign-out-button')).toBeTruthy();

    await pressTarget('health-consent-sign-out-button');

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('sign-in-screen')).toBeTruthy();
    });
    expect(rig.rpcCalls).toEqual([]);

    await act(async () => {
      view.unmount();
    });
  });

  it('5. someone who already gave consent never sees health-consent-screen on create-circle or invite-accept', async () => {
    const rigCreate = createConsentTestRig({ healthConsentAt: CONSENT_ISO, circles: [] });
    const createView = await renderRouter(rigCreate.routes, { initialUrl: '/start' });

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-start-screen')).toBeTruthy();
    });
    expect(screen.queryByTestId('health-consent-screen')).toBeNull();
    expect(rigCreate.rpcCalls).toEqual([]);

    await act(async () => {
      createView.unmount();
    });

    const rigInvite = createConsentTestRig({ healthConsentAt: CONSENT_ISO, circles: [] });
    const inviteView = await renderRouter(rigInvite.routes, {
      initialUrl: `/invite/${CONSENTED_INVITE_TOKEN}`,
    });

    await waitFor(() => {
      expect(screen.getByTestId('cc11-today-destination')).toBeTruthy();
    });
    expect(screen.queryByTestId('health-consent-screen')).toBeNull();
    expect(rigInvite.rpcCalls).toEqual([
      { fn: 'accept_invite', args: { token: CONSENTED_INVITE_TOKEN } },
    ]);

    await act(async () => {
      inviteView.unmount();
    });
  });

  it('6. an existing circle member with health_consent_at = null is not locked out of Today', async () => {
    const rig = createConsentTestRig({
      healthConsentAt: null,
      circles: [{ id: CIRCLE_ID }],
    });
    const view = await renderRouter(rig.routes, { initialUrl: '/' });

    await waitFor(() => {
      expect(screen.getByTestId('cc11-today-destination')).toBeTruthy();
    });
    expect(screen.queryByTestId('health-consent-screen')).toBeNull();
    expect(rig.rpcCalls).toEqual([]);

    await act(async () => {
      view.unmount();
    });
  });

  it('7. offline consent attempt says a connection is needed without pretending to save, and analytics sends nothing across consent, decline, or offline failure', async () => {
    // 1. Offline attempt
    const offlineRig = createConsentTestRig({
      healthConsentAt: null,
      circles: [],
      rpcOnline: () => false,
    });
    const offlineView = await renderRouter(offlineRig.routes, { initialUrl: '/start' });

    await waitFor(() => {
      expect(screen.getByTestId('health-consent-screen')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('health-consent-checkbox'));
    await pressTarget('health-consent-continue-button');

    await waitFor(() => {
      expect(screen.getByTestId('health-consent-offline')).toBeTruthy();
    });
    expect(screen.queryByTestId('onboarding-start-screen')).toBeNull();
    expect(offlineRig.getRecordedConsent()).toBeNull();
    expect(mockTrack).not.toHaveBeenCalled();

    await act(async () => {
      offlineView.unmount();
    });

    // 2. Online consent + decline also send 0 analytics events
    const onlineRig = createConsentTestRig({ healthConsentAt: null, circles: [] });
    const onlineView = await renderRouter(onlineRig.routes, { initialUrl: '/start' });

    await waitFor(() => {
      expect(screen.getByTestId('health-consent-screen')).toBeTruthy();
    });
    await pressTarget('health-consent-decline-button');
    expect(mockTrack).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('health-consent-checkbox'));
    await pressTarget('health-consent-continue-button');

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-start-screen')).toBeTruthy();
    });
    expect(mockTrack).not.toHaveBeenCalled();

    await act(async () => {
      onlineView.unmount();
    });
  });
});
