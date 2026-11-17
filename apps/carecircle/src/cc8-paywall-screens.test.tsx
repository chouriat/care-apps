import { ThemeProvider } from '@carecircle/ui';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Slot } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import OnboardingStartRoute from '../app/(onboarding)/start';
import CircleRoute from '../app/circle';
import HomeScreen from '../app/index';
import InviteTokenRoute from '../app/invite/[token]';
import CareLogRoute from '../app/log';
import VisitNewRoute from '../app/visit/new';
import en from '../i18n/en.json';
import { acceptInviteViaRpc, setPendingInviteToken } from './features/circle';
import {
  getAppPaywallController,
  getFamilyOffer,
  resetPaywallControllersForTests,
} from './features/paywall/api';

const mockPurchases = {
  configure: jest.fn(),
  getOfferings: jest.fn(),
  checkTrialOrIntroductoryPriceEligibility: jest.fn(),
  purchasePackage: jest.fn(),
  restorePurchases: jest.fn(),
};

jest.mock('react-native-purchases', () => ({
  __esModule: true,
  get default() {
    return mockPurchases;
  },
}));

const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockFunctionsInvoke = jest.fn();
const mockGetSession = jest.fn();
const mockGetUser = jest.fn();
const mockTrack = jest.fn();
const mockAuthState = {
  status: 'authenticated' as 'authenticated' | 'unauthenticated' | 'loading',
};

jest.mock('./features/auth/api', () => ({
  ...jest.requireActual('./features/auth/api'),
  getAppAuthController: () => ({
    getState: () => mockAuthState,
  }),
  getSupabaseClient: () => ({
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
    functions: {
      invoke: (...args: unknown[]) => mockFunctionsInvoke(...args),
    },
  }),
}));

jest.mock('./features/observability/api', () => ({
  ...jest.requireActual('./features/observability/api'),
  getAppObservability: () => ({
    analytics: {
      track: (...args: unknown[]) => mockTrack(...args),
    },
  }),
}));

jest.mock('./features/mocks', () => ({
  loadCareCircleMocks: () => null,
}));

const CIRCLE_ID = 'c8000001-0000-4000-8000-000000000001';
const OWNER_ID = 'c8100001-0000-4000-8000-000000000001';
const HELPER_ID = 'c8100002-0000-4000-8000-000000000002';
const VALID_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function ThemeRootLayout() {
  return (
    <ThemeProvider>
      <Slot />
    </ThemeProvider>
  );
}

async function pressByTestId(testId: string) {
  const node = screen.getByTestId(testId);
  const target =
    typeof node.props?.onPress === 'function' ? node : within(node).getByRole('button');
  await fireEvent.press(target);
}

function setupSupabaseTableMock(options: {
  role: 'owner' | 'helper' | 'viewer';
  planName: 'free' | 'family';
}) {
  const currentUserId = options.role === 'owner' ? OWNER_ID : HELPER_ID;
  mockGetSession.mockResolvedValue({
    data: {
      session: {
        user: {
          id: currentUserId,
          email: 'member@example.com',
        },
      },
    },
    error: null,
  });

  mockFrom.mockImplementation((table: string) => {
    const filters: Array<{ col: string; val: unknown }> = [];
    let inFilter: { col: string; vals: unknown[] } | null = null;

    const executeSelect = () => {
      if (table === 'circles') {
        return [
          {
            id: CIRCLE_ID,
            name: 'Family Care',
            care_recipient_name: 'Nadia',
            care_recipient_dob: null,
            timezone: 'Europe/Paris',
            created_by: OWNER_ID,
            created_at: '2026-11-01T00:00:00.000Z',
          },
        ];
      }
      if (table === 'circle_members') {
        const allMembers = [
          {
            circle_id: CIRCLE_ID,
            user_id: OWNER_ID,
            role: 'owner',
            joined_at: '2026-11-01T08:00:00.000Z',
          },
          {
            circle_id: CIRCLE_ID,
            user_id: HELPER_ID,
            role: options.role === 'owner' ? 'helper' : options.role,
            joined_at: '2026-11-02T08:00:00.000Z',
          },
        ];
        return allMembers.filter((row) =>
          filters.every((f) => (row as Record<string, unknown>)[f.col] === f.val),
        );
      }
      if (table === 'users_profile') {
        const profiles = [
          { user_id: OWNER_ID, display_name: 'Nadia (Owner)' },
          { user_id: HELPER_ID, display_name: 'Karim (Helper)' },
        ];
        if (inFilter) {
          return profiles.filter((p) => inFilter?.vals.includes(p.user_id));
        }
        return profiles;
      }
      if (table === 'entitlements') {
        if (options.planName !== 'family') return [];
        return [
          {
            user_id: OWNER_ID,
            entitlement: 'carecircle_family',
            active: true,
            expires_at: '2027-01-01T00:00:00.000Z',
          },
        ];
      }
      if (table === 'log_entries') {
        return [
          {
            id: 'c8900001-0000-4000-8000-000000000001',
            circle_id: CIRCLE_ID,
            type: 'dose',
            ref_id: null,
            summary: 'Aspirin marked given',
            created_by: OWNER_ID,
            created_at: '2026-11-16T08:00:00.000Z',
          },
        ];
      }
      if (table === 'medications') {
        return [];
      }
      return [];
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push({ col, val });
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        inFilter = { col, vals };
        return Promise.resolve({ data: executeSelect(), error: null });
      },
      order: () => builder,
      limit: (n: number) => Promise.resolve({ data: executeSelect().slice(0, n), error: null }),
      range: (fromIdx: number, toIdx: number) =>
        Promise.resolve({ data: executeSelect().slice(fromIdx, toIdx + 1), error: null }),
      maybeSingle: () => Promise.resolve({ data: executeSelect()[0] ?? null, error: null }),
      then: (resolve: (val: unknown) => unknown) =>
        Promise.resolve({ data: executeSelect(), error: null }).then(resolve),
    };
    return builder;
  });
}

describe('CC-8 paywall at each limit, plan row, trial wording, and invite follow-ups', () => {
  const originalAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const originalRcKey = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    resetPaywallControllersForTests();
    setPendingInviteToken(null);
    mockAuthState.status = 'authenticated';
    mockTrack.mockResolvedValue(undefined);
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
    process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = 'appl_test_public_key';
  });

  afterAll(() => {
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = originalAnonKey;
    process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = originalRcKey;
  });

  it('1a. owner refused with CIRCLE_FULL on /circle sees "Upgrade to add more people" and PaywallSheet with trigger="members"', async () => {
    setupSupabaseTableMock({ role: 'owner', planName: 'free' });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'CIRCLE_FULL', code: 'P0001' },
    });

    const view = await renderRouter(
      {
        _layout: ThemeRootLayout,
        circle: () => <CircleRoute />,
      },
      { initialUrl: '/circle' },
    );

    await waitFor(() => {
      expect(screen.getByTestId('circle-create-invite-button')).toBeTruthy();
    });
    mockTrack.mockClear();

    await pressByTestId('circle-create-invite-button');

    await waitFor(() => {
      expect(screen.getAllByText(/Upgrade to add more people/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByTestId('paywall-sheet')).toBeTruthy();
    });
    expect(screen.getByTestId('paywall-limit-message')).toHaveTextContent(en.paywall.limitMembers);
    expect(mockTrack).toHaveBeenCalledWith('cc_paywall_viewed', { trigger: 'members' });

    await act(async () => {
      view.unmount();
    });
  });

  it('1b. non-owner refused with CIRCLE_FULL when joining sees "This circle is full. Ask the owner." and no paywall', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'CIRCLE_FULL', code: 'P0001' },
    });

    const view = await renderRouter(
      {
        _layout: ThemeRootLayout,
        '(onboarding)/start': OnboardingStartRoute,
      },
      { initialUrl: '/(onboarding)/start' },
    );

    await pressByTestId('onboarding-choice-join');
    await fireEvent.changeText(
      screen.getByTestId('onboarding-join-input'),
      `carecircle://invite/${VALID_TOKEN}`,
    );
    await pressByTestId('onboarding-join-button');

    await waitFor(() => {
      expect(screen.getByText(en.onboarding.joinCircleFullMessage)).toBeTruthy();
    });
    expect(screen.queryByTestId('paywall-sheet')).toBeNull();
    expect(mockTrack).not.toHaveBeenCalledWith('cc_paywall_viewed', expect.anything());

    await act(async () => {
      view.unmount();
    });
  });

  it('2. visit note gateway QUOTA_EXCEEDED on /visit/new opens PaywallSheet with limit line and trigger="visit_note"', async () => {
    setupSupabaseTableMock({ role: 'owner', planName: 'free' });

    const view = await renderRouter(
      {
        _layout: ThemeRootLayout,
        'visit/new': () => (
          <VisitNewRoute
            circleId={CIRCLE_ID}
            circleTimezone="Europe/Paris"
            memberRole="owner"
            initialMedications={[]}
            deps={{
              callSummarizeVisit: async () => ({
                ok: false,
                error: {
                  code: 'QUOTA_EXCEEDED',
                  message: 'Monthly AI quota exceeded',
                  retryable: false,
                },
              }),
            }}
          />
        ),
      },
      { initialUrl: '/visit/new' },
    );

    await waitFor(() => {
      expect(screen.getByTestId('visit-notes-text-input')).toBeTruthy();
    });
    await fireEvent.changeText(
      screen.getByTestId('visit-notes-text-input'),
      'Doctor checked blood pressure.',
    );
    await pressByTestId('visit-summarise-button');

    await waitFor(() => {
      expect(screen.getByTestId('paywall-sheet')).toBeTruthy();
    });
    expect(screen.getByTestId('paywall-limit-message')).toHaveTextContent(
      en.paywall.limitVisitNote,
    );
    expect(mockTrack).toHaveBeenCalledWith('cc_paywall_viewed', { trigger: 'visit_note' });

    await act(async () => {
      view.unmount();
    });
  });

  it('3. PDF export refused on /log opens PaywallSheet with limit line and trigger="pdf_export"', async () => {
    setupSupabaseTableMock({ role: 'owner', planName: 'free' });

    const view = await renderRouter(
      {
        _layout: ThemeRootLayout,
        log: () => <CareLogRoute />,
      },
      { initialUrl: '/log' },
    );

    await waitFor(() => {
      expect(screen.getByTestId('care-log-export-button')).toBeTruthy();
    });
    await pressByTestId('care-log-export-button');

    await waitFor(() => {
      expect(screen.getByTestId('paywall-sheet')).toBeTruthy();
    });
    expect(screen.getByTestId('paywall-limit-message')).toHaveTextContent(
      en.paywall.limitPdfExport,
    );
    expect(mockTrack).toHaveBeenCalledWith('cc_paywall_viewed', { trigger: 'pdf_export' });

    await act(async () => {
      view.unmount();
    });
  });

  it('4. second circle refused with CIRCLE_LIMIT on /(onboarding)/start opens PaywallSheet with limit line and trigger="circles"', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'CIRCLE_LIMIT', code: 'P0001' },
    });

    const view = await renderRouter(
      {
        _layout: ThemeRootLayout,
        '(onboarding)/start': OnboardingStartRoute,
      },
      { initialUrl: '/(onboarding)/start' },
    );

    await fireEvent.changeText(
      screen.getByTestId('onboarding-circle-name-input'),
      'Second Family Circle',
    );
    await fireEvent.changeText(screen.getByTestId('onboarding-recipient-name-input'), 'Arthur');
    await fireEvent.changeText(screen.getByTestId('onboarding-timezone-input'), 'Europe/Paris');
    await pressByTestId('onboarding-submit-button');

    await waitFor(() => {
      expect(screen.getByTestId('paywall-sheet')).toBeTruthy();
    });
    expect(screen.getByTestId('paywall-limit-message')).toHaveTextContent(en.paywall.limitCircles);
    expect(mockTrack).toHaveBeenCalledWith('cc_paywall_viewed', { trigger: 'circles' });

    await act(async () => {
      view.unmount();
    });
  });

  it('5. /circle shows plan ("Free" or "Family") and "Upgrade" button for owner on Free plan (trigger="settings")', async () => {
    setupSupabaseTableMock({ role: 'owner', planName: 'free' });

    const view = await renderRouter(
      {
        _layout: ThemeRootLayout,
        circle: () => <CircleRoute />,
      },
      { initialUrl: '/circle' },
    );

    await waitFor(() => {
      expect(screen.getByTestId('circle-plan-card')).toBeTruthy();
    });
    expect(screen.getByTestId('circle-plan-value')).toHaveTextContent(en.circle.planFree);
    expect(screen.getByTestId('circle-plan-upgrade-button')).toBeTruthy();

    await pressByTestId('circle-plan-upgrade-button');

    await waitFor(() => {
      expect(screen.getByTestId('paywall-sheet')).toBeTruthy();
    });
    expect(mockTrack).toHaveBeenCalledWith('cc_paywall_viewed', { trigger: 'settings' });

    await act(async () => {
      view.unmount();
    });

    // Family plan hides Upgrade button even for owner
    setupSupabaseTableMock({ role: 'owner', planName: 'family' });
    const familyView = await renderRouter(
      {
        _layout: ThemeRootLayout,
        circle: () => <CircleRoute />,
      },
      { initialUrl: '/circle' },
    );

    await waitFor(() => {
      expect(screen.getByTestId('circle-plan-value')).toHaveTextContent(en.circle.planFamily);
    });
    expect(screen.queryByTestId('circle-plan-upgrade-button')).toBeNull();

    await act(async () => {
      familyView.unmount();
    });
  });

  it('6. trial wording both ways on iOS and Android via RevenueCat SDK and cc_trial_started on trial purchase', async () => {
    const mockGetOfferings = mockPurchases.getOfferings;
    const mockCheckEligibility = mockPurchases.checkTrialOrIntroductoryPriceEligibility;
    const mockPurchasePackage = mockPurchases.purchasePackage;

    const fakePackage = {
      identifier: '$rc_monthly',
      product: {
        identifier: 'cc_family_monthly',
        priceString: '€9.99',
        introPrice: { price: 0, priceString: '€0.00' },
        defaultOption: {
          freePhase: { billingPeriod: { value: 7, unit: 'DAY' } },
          introPhase: null,
        },
      },
    };

    mockGetOfferings.mockResolvedValue({
      current: {
        availablePackages: [fakePackage],
      },
    });

    // iOS eligible (status = 2) -> hasIntroOffer: true
    mockCheckEligibility.mockResolvedValueOnce({
      cc_family_monthly: { status: 2 },
    });
    const iosEligible = await getFamilyOffer('ios');
    expect(iosEligible).toEqual({
      priceText: '€9.99 / month',
      hasIntroOffer: true,
    });

    // iOS ineligible (status = 1) -> hasIntroOffer: false (even though product.introPrice is set!)
    mockCheckEligibility.mockResolvedValueOnce({
      cc_family_monthly: { status: 1 },
    });
    const iosIneligible = await getFamilyOffer('ios');
    expect(iosIneligible).toEqual({
      priceText: '€9.99 / month',
      hasIntroOffer: false,
    });

    // Android with defaultOption.freePhase -> hasIntroOffer: true
    const androidEligible = await getFamilyOffer('android');
    expect(androidEligible).toEqual({
      priceText: '€9.99 / month',
      hasIntroOffer: true,
    });

    // Android without freePhase or introPhase -> hasIntroOffer: false
    mockGetOfferings.mockResolvedValueOnce({
      current: {
        availablePackages: [
          {
            identifier: '$rc_monthly',
            product: {
              identifier: 'cc_family_monthly',
              priceString: '€9.99',
              introPrice: null,
              defaultOption: {
                freePhase: null,
                introPhase: null,
              },
            },
          },
        ],
      },
    });
    const androidIneligible = await getFamilyOffer('android');
    expect(androidIneligible).toEqual({
      priceText: '€9.99 / month',
      hasIntroOffer: false,
    });

    // Purchasing when periodType is TRIAL fires cc_trial_started
    setupSupabaseTableMock({ role: 'owner', planName: 'family' });
    mockGetOfferings.mockResolvedValueOnce({
      current: {
        availablePackages: [fakePackage],
      },
    });
    mockPurchasePackage.mockResolvedValueOnce({
      customerInfo: {
        entitlements: {
          active: {
            carecircle_family: { isActive: true, periodType: 'TRIAL' },
          },
        },
      },
    });

    const controller = getAppPaywallController(OWNER_ID);
    const purchaseOk = await controller.purchase();
    expect(purchaseOk).toBe(true);
    expect(mockTrack).toHaveBeenCalledWith('cc_trial_started', {
      entitlement: 'carecircle_family',
    });
  });

  it('7a. failed invite on /invite/[token] shows "Continue to CareCircle" button that navigates into the app', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'INVITE_EXPIRED', code: 'P0001' },
    });
    mockFrom.mockImplementation(() => ({
      select: () => ({
        limit: async () => ({ data: [{ id: CIRCLE_ID }], error: null }),
      }),
    }));

    const view = await renderRouter(
      {
        _layout: ThemeRootLayout,
        index: HomeScreen,
        'invite/[token]': InviteTokenRoute,
        '(tabs)/today': () => null,
      },
      { initialUrl: `/invite/${VALID_TOKEN}` },
    );

    await waitFor(() => {
      expect(screen.getByTestId('invite-accept-error')).toBeTruthy();
    });
    expect(screen.getByText(en.onboarding.joinExpiredMessage)).toBeTruthy();
    expect(screen.getByTestId('invite-accept-continue-button')).toBeTruthy();

    await pressByTestId('invite-accept-continue-button');

    await waitFor(() => {
      expect(view).toHavePathname('/today');
    });

    await act(async () => {
      view.unmount();
    });
  });

  it('7b. pending invite that fails after sign-in on / shows the error instead of dropping it, and Continue proceeds', async () => {
    setPendingInviteToken(VALID_TOKEN);
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'INVITE_USED', code: 'P0001' },
    });
    mockFrom.mockImplementation(() => ({
      select: () => ({
        limit: async () => ({ data: [{ id: CIRCLE_ID }], error: null }),
      }),
    }));

    const view = await renderRouter(
      {
        _layout: ThemeRootLayout,
        index: HomeScreen,
        '(tabs)/today': () => null,
      },
      { initialUrl: '/' },
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-pending-invite-error')).toBeTruthy();
    });
    expect(screen.getByText(en.onboarding.joinUsedMessage)).toBeTruthy();

    await pressByTestId('home-pending-invite-continue-button');

    await waitFor(() => {
      expect(view).toHavePathname('/today');
    });

    await act(async () => {
      view.unmount();
    });
  });

  it('7c. acceptInviteViaRpc does not fire cc_invite_accepted when the user was already in the circle', async () => {
    const tracked: unknown[] = [];

    // Case 1: User already has a circle_members row for CIRCLE_ID before accept_invite runs
    const resExistingRow = await acceptInviteViaRpc(
      { tokenOrUrl: VALID_TOKEN },
      {
        getClient: () =>
          ({
            from: () => ({
              select: () => ({
                limit: async () => ({
                  data: [{ circle_id: CIRCLE_ID }],
                  error: null,
                }),
              }),
            }),
            rpc: async () => ({
              data: { circleId: CIRCLE_ID, role: 'helper' },
              error: null,
            }),
          }) as never,
        trackInviteAccepted: (role) => tracked.push(role),
      },
    );
    expect(resExistingRow).toEqual({ ok: true, circleId: CIRCLE_ID, role: 'helper' });
    expect(tracked).toHaveLength(0);

    // Case 2: RPC returns role='owner' (already the circle owner)
    const resOwner = await acceptInviteViaRpc(
      { tokenOrUrl: VALID_TOKEN },
      {
        getClient: () => ({
          rpc: async () => ({
            data: { circleId: CIRCLE_ID, role: 'owner' },
            error: null,
          }),
        }),
        trackInviteAccepted: (role) => tracked.push(role),
      },
    );
    expect(resOwner).toEqual({ ok: true, circleId: CIRCLE_ID, role: undefined });
    expect(tracked).toHaveLength(0);
  });
});
