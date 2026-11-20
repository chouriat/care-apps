import { ThemeProvider } from '@carecircle/ui';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Slot } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { Share } from 'react-native';
import OnboardingStartRoute from '../app/(onboarding)/start';
import CircleRoute from '../app/circle';
import en from '../i18n/en.json';
import { openStoreSubscriptionSettings, STORE_SUBSCRIPTION_URLS } from './features/circle';

const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockFunctionsInvoke = jest.fn();
const mockGetSession = jest.fn();
const mockSignOut = jest.fn();

jest.mock('./features/auth/api', () => ({
  ...jest.requireActual('./features/auth/api'),
  getAppAuthController: () => ({
    getState: () => ({ status: 'authenticated' }),
    signOut: (...args: unknown[]) => mockSignOut(...args),
  }),
  getSupabaseClient: () => ({
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
    functions: {
      invoke: (...args: unknown[]) => mockFunctionsInvoke(...args),
    },
  }),
}));

jest.mock('./features/mocks', () => ({
  loadCareCircleMocks: () => null,
}));

const CIRCLE_ID = 'c1000001-0000-4000-8000-000000000001';
const OWNER_ID = 'c1010001-0000-4000-8000-000000000001';
const HELPER_ID = 'c1010002-0000-4000-8000-000000000002';

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

function setupCircleMock(role: 'owner' | 'helper' | 'viewer' = 'owner') {
  const currentUserId = role === 'owner' ? OWNER_ID : HELPER_ID;
  mockGetSession.mockResolvedValue({
    data: {
      session: {
        user: { id: currentUserId, email: 'user@example.com' },
      },
    },
    error: null,
  });

  mockFrom.mockImplementation((table: string) => {
    const filters: Array<{ col: string; val: unknown }> = [];
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
            role: role === 'owner' ? 'helper' : role,
            joined_at: '2026-11-02T08:00:00.000Z',
          },
        ];
        return allMembers.filter((row) =>
          filters.every((f) => (row as Record<string, unknown>)[f.col] === f.val),
        );
      }
      if (table === 'users_profile') {
        return [
          { user_id: OWNER_ID, display_name: 'Nadia (Owner)' },
          { user_id: HELPER_ID, display_name: 'Karim (Helper)' },
        ];
      }
      return [];
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push({ col, val });
        return builder;
      },
      order: () => builder,
      limit: (n: number) => Promise.resolve({ data: executeSelect().slice(0, n), error: null }),
      maybeSingle: () => Promise.resolve({ data: executeSelect()[0] ?? null, error: null }),
      then: (resolve: (val: unknown) => unknown) =>
        Promise.resolve({ data: executeSelect(), error: null }).then(resolve),
    };
    return builder;
  });
}

describe('CC-10 Delete account, transfer ownership, data export, and onboarding disclaimer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignOut.mockResolvedValue(undefined);
  });

  it('1. renders medical disclaimer (common.notMedicalAdvice) on /(onboarding)/start', async () => {
    const view = await renderRouter(
      {
        _layout: ThemeRootLayout,
        '(onboarding)/start': OnboardingStartRoute,
      },
      { initialUrl: '/(onboarding)/start' },
    );

    expect(screen.getByTestId('onboarding-disclaimer')).toHaveTextContent(
      en.common.notMedicalAdvice,
    );

    await act(async () => {
      view.unmount();
    });
  });

  it('2. exports the signed-in user data as JSON via export_user_data RPC and opens Share sheet', async () => {
    setupCircleMock('helper');
    const shareSpy = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: Share.sharedAction } as never);

    const exportedPayload = {
      userId: HELPER_ID,
      profile: { user_id: HELPER_ID, display_name: 'Karim (Helper)' },
      memberships: [{ circle_id: CIRCLE_ID, user_id: HELPER_ID, role: 'helper' }],
    };
    mockRpc.mockResolvedValue({
      data: exportedPayload,
      error: null,
    });

    const view = await renderRouter(
      {
        _layout: ThemeRootLayout,
        circle: () => <CircleRoute />,
      },
      { initialUrl: '/circle' },
    );

    await waitFor(() => {
      expect(screen.getByTestId('circle-export-data-button')).toBeTruthy();
    });
    // Helper sees no transfer ownership button
    expect(screen.queryByTestId(`circle-member-transfer-${OWNER_ID}`)).toBeNull();

    await pressByTestId('circle-export-data-button');

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('export_user_data');
      expect(shareSpy).toHaveBeenCalledWith({
        message: JSON.stringify(exportedPayload, null, 2),
      });
    });

    shareSpy.mockRestore();
    await act(async () => {
      view.unmount();
    });
  });

  it('3. owner can transfer ownership to another circle member via transfer_ownership RPC', async () => {
    setupCircleMock('owner');
    mockRpc.mockResolvedValue({
      data: { circleId: CIRCLE_ID, newOwnerId: HELPER_ID },
      error: null,
    });

    const view = await renderRouter(
      {
        _layout: ThemeRootLayout,
        circle: () => <CircleRoute />,
      },
      { initialUrl: '/circle' },
    );

    await waitFor(() => {
      expect(screen.getByTestId(`circle-member-transfer-${HELPER_ID}`)).toBeTruthy();
    });

    await pressByTestId(`circle-member-transfer-${HELPER_ID}`);

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('transfer_ownership', {
        circleId: CIRCLE_ID,
        newOwnerId: HELPER_ID,
      });
    });

    await act(async () => {
      view.unmount();
    });
  });

  it('4. Delete account shows OWNER_MUST_TRANSFER message when owner has other members, and signs out + redirects when allowed', async () => {
    setupCircleMock('owner');
    mockFunctionsInvoke.mockResolvedValueOnce({
      data: {
        ok: false,
        code: 'OWNER_MUST_TRANSFER',
        error: { code: 'OWNER_MUST_TRANSFER', message: 'Transfer ownership first' },
      },
      error: null,
    });

    const view = await renderRouter(
      {
        _layout: ThemeRootLayout,
        circle: () => <CircleRoute />,
        '(auth)/sign-in': () => null,
      },
      { initialUrl: '/circle' },
    );

    await waitFor(() => {
      expect(screen.getByTestId('circle-delete-account-button')).toBeTruthy();
    });

    await pressByTestId('circle-delete-account-button');
    await waitFor(() => {
      expect(screen.getByTestId('circle-confirm-delete-account-button')).toBeTruthy();
    });
    await pressByTestId('circle-confirm-delete-account-button');

    await waitFor(() => {
      expect(screen.getByTestId('circle-delete-owner-must-transfer')).toHaveTextContent(
        en.circle.deleteAccountOwnerMustTransfer,
      );
    });
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(view).toHavePathname('/circle');

    // Now simulate successful account deletion (after transferring ownership or as solo owner)
    mockFunctionsInvoke.mockResolvedValueOnce({
      data: { ok: true },
      error: null,
    });

    await pressByTestId('circle-delete-account-button');
    await pressByTestId('circle-confirm-delete-account-button');

    await waitFor(() => {
      expect(mockFunctionsInvoke).toHaveBeenCalledWith('delete-account', { method: 'POST' });
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(view).toHavePathname('/sign-in');
    });

    await act(async () => {
      view.unmount();
    });
  });

  it('5. openStoreSubscriptionSettings opens the iOS or Android store subscription URL', async () => {
    const opened: string[] = [];
    const iosUrl = await openStoreSubscriptionSettings('ios', async (url) => {
      opened.push(url);
    });
    const androidUrl = await openStoreSubscriptionSettings('android', async (url) => {
      opened.push(url);
    });

    expect(iosUrl).toBe(STORE_SUBSCRIPTION_URLS.ios);
    expect(androidUrl).toBe(STORE_SUBSCRIPTION_URLS.android);
    expect(opened).toEqual([STORE_SUBSCRIPTION_URLS.ios, STORE_SUBSCRIPTION_URLS.android]);
  });
});
