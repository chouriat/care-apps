import { validateAnalyticsEvent, type MemberRole } from '@carecircle/core';
import { ThemeProvider } from '@carecircle/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ComponentType } from 'react';

// The default dependencies (no getClient / tracker passed) must use the app's real Supabase client
// and the typed analytics client. Both are replaced here so the tests can see what they receive.
const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockTrack = jest.fn();

jest.mock('./features/auth/api', () => ({
  ...jest.requireActual('./features/auth/api'),
  getSupabaseClient: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  }),
}));

jest.mock('./features/observability/api', () => ({
  ...jest.requireActual('./features/observability/api'),
  getAppObservability: () => ({
    analytics: { track: (...args: unknown[]) => mockTrack(...args) },
  }),
}));

beforeEach(() => {
  mockRpc.mockReset();
  mockFrom.mockReset();
  mockTrack.mockReset();
  mockTrack.mockResolvedValue(undefined);
});

async function pressByTestId(testId: string) {
  const node = screen.getByTestId(testId);
  const target =
    typeof node.props?.onPress === 'function' ? node : within(node).getByRole('button');
  await fireEvent.press(target);
}

type InviteAssignableRole = Exclude<MemberRole, 'owner'>;

type CreateInviteErrorCode =
  | 'VALIDATION_ERROR'
  | 'PERMISSION_DENIED'
  | 'CIRCLE_FULL'
  | 'NETWORK_ERROR'
  | 'CREATE_INVITE_FAILED';

type AcceptInviteErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVITE_INVALID'
  | 'INVITE_EXPIRED'
  | 'INVITE_USED'
  | 'CIRCLE_FULL'
  | 'CIRCLE_LIMIT_REACHED'
  | 'NETWORK_ERROR'
  | 'ACCEPT_INVITE_FAILED';

type MemberActionErrorCode =
  | 'VALIDATION_ERROR'
  | 'PERMISSION_DENIED'
  | 'NETWORK_ERROR'
  | 'MEMBER_ACTION_FAILED';

interface CircleMemberItem {
  circleId: string;
  userId: string;
  displayName: string;
  role: MemberRole;
  joinedAt: string;
}

interface CircleSettingsScreenProps {
  circleId: string;
  circleName: string;
  currentUserId: string;
  currentUserRole: MemberRole;
  planName?: 'free' | 'family';
  members: CircleMemberItem[];
  isLoading?: boolean;
  isOffline?: boolean;
  hasError?: boolean;
  inviteUrl?: string | null;
  inviteExpiresAt?: string | null;
  errorCode?: CreateInviteErrorCode | MemberActionErrorCode | null;
  onCreateInvite?: (role: InviteAssignableRole) => void | Promise<void>;
  onChangeMemberRole?: (userId: string, nextRole: InviteAssignableRole) => void | Promise<void>;
  onRemoveMember?: (userId: string) => void | Promise<void>;
  onShowPaywall?: () => void;
  onRetry?: () => void;
}

interface CircleFeatureModule {
  parseInviteToken: (rawInput: string) => string | null;
  createInviteViaRpc: (
    input: { circleId: string; role: MemberRole },
    deps?: {
      getClient?: () => {
        rpc: (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
      };
      trackInviteSent?: (role: InviteAssignableRole) => void;
    },
  ) => Promise<
    | { ok: true; url: string; expiresAt: string }
    | { ok: false; errorCode: CreateInviteErrorCode; isOffline: boolean }
  >;
  acceptInviteViaRpc: (
    input: { tokenOrUrl: string },
    deps?: {
      getClient?: () => {
        rpc: (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
      };
      trackInviteAccepted?: (role?: InviteAssignableRole) => void;
    },
  ) => Promise<
    | { ok: true; circleId: string; role?: InviteAssignableRole }
    | { ok: false; errorCode: AcceptInviteErrorCode; isOffline: boolean }
  >;
  updateMemberRole: (
    input: { circleId: string; targetUserId: string; role: MemberRole },
    deps?: {
      getClient?: () => {
        from: (table: string) => {
          update: (values: Record<string, unknown>) => {
            eq: (
              col1: string,
              val1: string,
            ) => {
              eq: (
                col2: string,
                val2: string,
              ) => Promise<{ error: { message: string; code?: string } | null }>;
            };
          };
        };
      };
    },
  ) => Promise<{ ok: true } | { ok: false; errorCode: MemberActionErrorCode; isOffline: boolean }>;
  removeCircleMember: (
    input: { circleId: string; targetUserId: string },
    deps?: {
      getClient?: () => {
        from: (table: string) => {
          delete: () => {
            eq: (
              col1: string,
              val1: string,
            ) => {
              eq: (
                col2: string,
                val2: string,
              ) => Promise<{ error: { message: string; code?: string } | null }>;
            };
          };
        };
      };
    },
  ) => Promise<{ ok: true } | { ok: false; errorCode: MemberActionErrorCode; isOffline: boolean }>;
  CircleSettingsScreen: ComponentType<CircleSettingsScreenProps>;
}

function loadCircleFeatureModule(): CircleFeatureModule {
  // Loaded at runtime so the [safety 1/2] tests-only PR typechecks before features/circle exists.
  return jest.requireActual<CircleFeatureModule>('./features/circle');
}

const CIRCLE_ID = 'c1000001-0000-4000-8000-000000000001';
const OWNER_ID = 'c1100001-0000-4000-8000-000000000001';
const HELPER_ID = 'c1100002-0000-4000-8000-000000000002';
const VIEWER_ID = 'c1100003-0000-4000-8000-000000000003';
const VALID_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const VALID_INVITE_URL = `carecircle://invite/${VALID_TOKEN}`;

const SAMPLE_MEMBERS: CircleMemberItem[] = [
  {
    circleId: CIRCLE_ID,
    userId: OWNER_ID,
    displayName: 'Nadia (Owner)',
    role: 'owner',
    joinedAt: '2026-11-01T08:00:00.000Z',
  },
  {
    circleId: CIRCLE_ID,
    userId: HELPER_ID,
    displayName: 'Karim (Helper)',
    role: 'helper',
    joinedAt: '2026-11-02T09:30:00.000Z',
  },
  {
    circleId: CIRCLE_ID,
    userId: VIEWER_ID,
    displayName: 'Samira (Viewer)',
    role: 'viewer',
    joinedAt: '2026-11-03T11:15:00.000Z',
  },
];

describe('CC-1b Invites and roles (create_invite, accept_invite, and /circle screen)', () => {
  it('parses deep-link and raw invite tokens and rejects malformed or short tokens', () => {
    const { parseInviteToken } = loadCircleFeatureModule();

    expect(parseInviteToken(VALID_INVITE_URL)).toBe(VALID_TOKEN);
    expect(parseInviteToken(`  ${VALID_INVITE_URL}  `)).toBe(VALID_TOKEN);
    expect(parseInviteToken(VALID_TOKEN)).toBe(VALID_TOKEN);
    expect(parseInviteToken('')).toBeNull();
    expect(parseInviteToken('   ')).toBeNull();
    expect(parseInviteToken('carecircle://invite/short')).toBeNull();
  });

  it('createInviteViaRpc refuses role=owner client-side and fires cc_invite_sent with only { role } (never a name, email, or token)', async () => {
    const { createInviteViaRpc } = loadCircleFeatureModule();
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const trackedPayloads: Array<Record<string, unknown>> = [];

    const getClient = () => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return {
          data: {
            url: VALID_INVITE_URL,
            expiresAt: '2026-11-22T12:00:00.000Z',
          },
          error: null,
        };
      },
    });

    // Attempting to create an owner invite is refused before any RPC call
    const ownerAttempt = await createInviteViaRpc(
      { circleId: CIRCLE_ID, role: 'owner' },
      {
        getClient,
        trackInviteSent: (role) => trackedPayloads.push({ role }),
      },
    );
    expect(ownerAttempt).toEqual({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      isOffline: false,
    });
    expect(rpcCalls).toHaveLength(0);
    expect(trackedPayloads).toHaveLength(0);

    // Valid helper invite calls create_invite and tracks cc_invite_sent with only { role }
    const helperRes = await createInviteViaRpc(
      { circleId: CIRCLE_ID, role: 'helper' },
      {
        getClient,
        trackInviteSent: (role) => {
          const validated = validateAnalyticsEvent('cc_invite_sent', { role });
          trackedPayloads.push(validated);
        },
      },
    );

    expect(helperRes).toEqual({
      ok: true,
      url: VALID_INVITE_URL,
      expiresAt: '2026-11-22T12:00:00.000Z',
    });
    expect(rpcCalls).toEqual([
      {
        fn: 'create_invite',
        args: { circleId: CIRCLE_ID, role: 'helper' },
      },
    ]);
    expect(trackedPayloads).toEqual([{ role: 'helper' }]);
    const serialized = JSON.stringify(trackedPayloads);
    expect(serialized).not.toContain(VALID_TOKEN);
    expect(serialized).not.toContain('Nadia');
    expect(serialized).not.toContain('@');
  });

  it('acceptInviteViaRpc sends only { token } (no userId or client entitlement) and maps INVITE_EXPIRED, INVITE_USED, and CIRCLE_FULL', async () => {
    const { acceptInviteViaRpc } = loadCircleFeatureModule();
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const trackedAccepted: Array<Record<string, unknown>> = [];

    const okRes = await acceptInviteViaRpc(
      { tokenOrUrl: VALID_INVITE_URL },
      {
        getClient: () => ({
          rpc: async (fn, args) => {
            rpcCalls.push({ fn, args });
            return {
              data: { circleId: CIRCLE_ID, role: 'helper' },
              error: null,
            };
          },
        }),
        trackInviteAccepted: (role) => {
          const validated = validateAnalyticsEvent('cc_invite_accepted', role ? { role } : {});
          trackedAccepted.push(validated);
        },
      },
    );

    expect(okRes).toEqual({ ok: true, circleId: CIRCLE_ID, role: 'helper' });
    expect(rpcCalls).toEqual([
      {
        fn: 'accept_invite',
        args: { token: VALID_TOKEN },
      },
    ]);
    expect(Object.keys(rpcCalls[0]!.args)).toEqual(['token']);
    expect(trackedAccepted).toEqual([{ role: 'helper' }]);

    for (const [serverMsg, expectedCode] of [
      ['INVITE_EXPIRED', 'INVITE_EXPIRED'],
      ['INVITE_USED', 'INVITE_USED'],
      ['CIRCLE_FULL', 'CIRCLE_FULL'],
    ] as const) {
      const errRes = await acceptInviteViaRpc(
        { tokenOrUrl: VALID_TOKEN },
        {
          getClient: () => ({
            rpc: async () => ({
              data: null,
              error: { message: serverMsg, code: 'P0001' },
            }),
          }),
        },
      );
      expect(errRes).toEqual({
        ok: false,
        errorCode: expectedCode,
        isOffline: false,
      });
    }
  });

  it('viewer sees no edit controls on CircleSettingsScreen, and direct API writes as a viewer fail', async () => {
    const { CircleSettingsScreen, updateMemberRole, removeCircleMember } =
      loadCircleFeatureModule();

    await render(
      <ThemeProvider>
        <CircleSettingsScreen
          circleId={CIRCLE_ID}
          circleName="Family Care"
          currentUserId={VIEWER_ID}
          currentUserRole="viewer"
          members={SAMPLE_MEMBERS}
        />
      </ThemeProvider>,
    );

    // Viewer can read all members
    expect(screen.getByText('Nadia (Owner)')).toBeTruthy();
    expect(screen.getByText('Karim (Helper)')).toBeTruthy();
    expect(screen.getByText('Samira (Viewer)')).toBeTruthy();

    // Viewer sees NO invite creation, role change, or member removal controls
    expect(screen.queryByTestId('circle-create-invite-button')).toBeNull();
    expect(screen.queryByTestId(`circle-member-role-toggle-${HELPER_ID}`)).toBeNull();
    expect(screen.queryByTestId(`circle-member-remove-${HELPER_ID}`)).toBeNull();

    // Direct API writes as a viewer (or attempting to set role='owner') fail
    const promoteToOwner = await updateMemberRole({
      circleId: CIRCLE_ID,
      targetUserId: HELPER_ID,
      role: 'owner',
    });
    expect(promoteToOwner).toEqual({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      isOffline: false,
    });

    const viewerRoleWrite = await updateMemberRole(
      {
        circleId: CIRCLE_ID,
        targetUserId: HELPER_ID,
        role: 'viewer',
      },
      {
        getClient: () => ({
          from: () => ({
            update: () => ({
              eq: () => ({
                eq: async () => ({
                  error: {
                    message: 'new row violates row-level security policy',
                    code: '42501',
                  },
                }),
              }),
            }),
          }),
        }),
      },
    );
    expect(viewerRoleWrite).toEqual({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      isOffline: false,
    });

    const viewerRemoveWrite = await removeCircleMember(
      {
        circleId: CIRCLE_ID,
        targetUserId: HELPER_ID,
      },
      {
        getClient: () => ({
          from: () => ({
            delete: () => ({
              eq: () => ({
                eq: async () => ({
                  error: {
                    message: 'new row violates row-level security policy',
                    code: '42501',
                  },
                }),
              }),
            }),
          }),
        }),
      },
    );
    expect(viewerRemoveWrite).toEqual({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      isOffline: false,
    });
  });

  it('owner sees invite, role-change, and remove controls (never on the owner row itself) and triggers paywall on CIRCLE_FULL', async () => {
    const { CircleSettingsScreen } = loadCircleFeatureModule();
    const onCreateInvite = jest.fn();
    const onChangeMemberRole = jest.fn();
    const onRemoveMember = jest.fn();
    const onShowPaywall = jest.fn();

    await render(
      <ThemeProvider>
        <CircleSettingsScreen
          circleId={CIRCLE_ID}
          circleName="Family Care"
          currentUserId={OWNER_ID}
          currentUserRole="owner"
          members={SAMPLE_MEMBERS}
          inviteUrl={VALID_INVITE_URL}
          errorCode="CIRCLE_FULL"
          onCreateInvite={onCreateInvite}
          onChangeMemberRole={onChangeMemberRole}
          onRemoveMember={onRemoveMember}
          onShowPaywall={onShowPaywall}
        />
      </ThemeProvider>,
    );

    // Owner row itself has no role toggle or remove button (a circle has exactly one owner)
    expect(screen.queryByTestId(`circle-member-role-toggle-${OWNER_ID}`)).toBeNull();
    expect(screen.queryByTestId(`circle-member-remove-${OWNER_ID}`)).toBeNull();

    // Owner can invite a helper or viewer, toggle Karim's role, remove Samira, and open paywall on CIRCLE_FULL
    await pressByTestId('circle-invite-role-viewer');
    await pressByTestId('circle-create-invite-button');
    expect(onCreateInvite).toHaveBeenCalledWith('viewer');

    await pressByTestId(`circle-member-role-toggle-${HELPER_ID}`);
    expect(onChangeMemberRole).toHaveBeenCalledWith(HELPER_ID, 'viewer');

    await pressByTestId(`circle-member-remove-${VIEWER_ID}`);
    expect(onRemoveMember).toHaveBeenCalledWith(VIEWER_ID);

    expect(screen.getByTestId('circle-invite-link-value')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByTestId('circle-upgrade-paywall-button')).toBeTruthy();
    });
    await pressByTestId('circle-upgrade-paywall-button');
    expect(onShowPaywall).toHaveBeenCalledTimes(1);
  });

  it('[1-circle rule: joining a second circle] acceptInviteViaRpc allows a member of Circle A to join Circle B until Taha clarifies whether 1 circle caps memberships or owned circles', async () => {
    const { acceptInviteViaRpc } = loadCircleFeatureModule();
    const secondCircleId = 'c1000002-0000-4000-8000-000000000002';

    const res = await acceptInviteViaRpc(
      { tokenOrUrl: VALID_INVITE_URL },
      {
        getClient: () => ({
          rpc: async () => ({
            data: { circleId: secondCircleId, role: 'helper' },
            error: null,
          }),
        }),
      },
    );

    expect(res).toEqual({
      ok: true,
      circleId: secondCircleId,
      role: 'helper',
    });
  });
});

// Added in review: what the first tests above did not pin down.
describe('CC-1b invites and roles: defaults, failures and every screen state', () => {
  // A fake PostgREST builder that records the table, the values and every filter.
  function recordingClient(result: { error: { message: string; code?: string } | null }) {
    const calls: Array<[string, ...unknown[]]> = [];
    const filters = {
      eq: (col1: string, val1: string) => {
        calls.push(['eq', col1, val1]);
        return {
          eq: async (col2: string, val2: string) => {
            calls.push(['eq', col2, val2]);
            return result;
          },
        };
      },
    };
    const client = {
      from: (table: string) => {
        calls.push(['from', table]);
        return {
          update: (values: Record<string, unknown>) => {
            calls.push(['update', values]);
            return filters;
          },
          delete: () => {
            calls.push(['delete']);
            return filters;
          },
        };
      },
    };
    return { calls, getClient: () => client };
  }

  it('parses a pasted link with spaces, a web link and a query string, and refuses other shapes', () => {
    const { parseInviteToken } = loadCircleFeatureModule();

    expect(parseInviteToken(`https://carecircle.app/invite/${VALID_TOKEN}`)).toBe(VALID_TOKEN);
    expect(parseInviteToken(`${VALID_INVITE_URL}?utm_source=sms`)).toBe(VALID_TOKEN);
    expect(parseInviteToken(`\n${VALID_INVITE_URL}\n`)).toBe(VALID_TOKEN);
    expect(parseInviteToken(`carecircle://circle/${VALID_TOKEN}`)).toBeNull();
    expect(parseInviteToken(`https://example.com/invite/${VALID_TOKEN}`)).toBeNull();
    expect(parseInviteToken(`carecircle://invite/${VALID_TOKEN.slice(0, 31)}`)).toBeNull();
    expect(parseInviteToken(`carecircle://invite/${VALID_TOKEN}/extra`)).toBeNull();
  });

  it('createInviteViaRpc uses the app Supabase client and sends cc_invite_sent with only { role } by default', async () => {
    const { createInviteViaRpc } = loadCircleFeatureModule();
    mockRpc.mockResolvedValue({
      data: { url: VALID_INVITE_URL, expiresAt: '2026-11-22T12:00:00.000Z' },
      error: null,
    });

    const res = await createInviteViaRpc({ circleId: CIRCLE_ID, role: 'viewer' });

    expect(res).toEqual({ ok: true, url: VALID_INVITE_URL, expiresAt: '2026-11-22T12:00:00.000Z' });
    expect(mockRpc).toHaveBeenCalledWith('create_invite', { circleId: CIRCLE_ID, role: 'viewer' });
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('cc_invite_sent', { role: 'viewer' });
  });

  it('createInviteViaRpc sends no event when the server refuses, and maps refusals and network failures', async () => {
    const { createInviteViaRpc } = loadCircleFeatureModule();
    const tracked: unknown[] = [];

    const refused = await createInviteViaRpc(
      { circleId: CIRCLE_ID, role: 'helper' },
      {
        getClient: () => ({
          rpc: async () => ({
            data: null,
            error: { message: 'Only the circle owner can invite', code: '42501' },
          }),
        }),
        trackInviteSent: (role) => tracked.push(role),
      },
    );
    expect(refused).toEqual({ ok: false, errorCode: 'PERMISSION_DENIED', isOffline: false });

    const offline = await createInviteViaRpc(
      { circleId: CIRCLE_ID, role: 'helper' },
      {
        getClient: () => ({
          rpc: async () => {
            throw new TypeError('Network request failed');
          },
        }),
        trackInviteSent: (role) => tracked.push(role),
      },
    );
    expect(offline).toEqual({ ok: false, errorCode: 'NETWORK_ERROR', isOffline: true });
    expect(tracked).toEqual([]);
  });

  it('acceptInviteViaRpc uses the app Supabase client and sends cc_invite_accepted with only { role } by default', async () => {
    const { acceptInviteViaRpc } = loadCircleFeatureModule();
    mockRpc.mockResolvedValue({ data: { circleId: CIRCLE_ID, role: 'viewer' }, error: null });

    const res = await acceptInviteViaRpc({ tokenOrUrl: ` ${VALID_INVITE_URL} ` });

    expect(res).toEqual({ ok: true, circleId: CIRCLE_ID, role: 'viewer' });
    expect(mockRpc).toHaveBeenCalledWith('accept_invite', { token: VALID_TOKEN });
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('cc_invite_accepted', { role: 'viewer' });
  });

  it('acceptInviteViaRpc never calls the server for a malformed link, maps INVITE_INVALID and network failures, and sends no event on any failure', async () => {
    const { acceptInviteViaRpc } = loadCircleFeatureModule();
    const tracked: unknown[] = [];
    const trackInviteAccepted = (role?: InviteAssignableRole) => tracked.push(role ?? 'none');

    const malformed = await acceptInviteViaRpc(
      { tokenOrUrl: 'carecircle://invite/short' },
      { trackInviteAccepted },
    );
    expect(malformed).toEqual({ ok: false, errorCode: 'VALIDATION_ERROR', isOffline: false });
    expect(mockRpc).not.toHaveBeenCalled();

    for (const [serverMsg, expectedCode] of [
      ['INVITE_INVALID', 'INVITE_INVALID'],
      ['INVITE_EXPIRED', 'INVITE_EXPIRED'],
      ['INVITE_USED', 'INVITE_USED'],
      ['CIRCLE_FULL', 'CIRCLE_FULL'],
    ] as const) {
      const res = await acceptInviteViaRpc(
        { tokenOrUrl: VALID_TOKEN },
        {
          getClient: () => ({
            rpc: async () => ({ data: null, error: { message: serverMsg, code: 'P0001' } }),
          }),
          trackInviteAccepted,
        },
      );
      expect(res).toEqual({ ok: false, errorCode: expectedCode, isOffline: false });
    }

    // Any other database error (also code P0001) is not one of the invite codes
    const other = await acceptInviteViaRpc(
      { tokenOrUrl: VALID_TOKEN },
      {
        getClient: () => ({
          rpc: async () => ({
            data: null,
            error: { message: 'Something else went wrong in the database', code: 'P0001' },
          }),
        }),
        trackInviteAccepted,
      },
    );
    expect(other).toEqual({ ok: false, errorCode: 'ACCEPT_INVITE_FAILED', isOffline: false });

    const offline = await acceptInviteViaRpc(
      { tokenOrUrl: VALID_TOKEN },
      {
        getClient: () => ({
          rpc: async () => {
            throw new TypeError('Network request failed');
          },
        }),
        trackInviteAccepted,
      },
    );
    expect(offline).toEqual({ ok: false, errorCode: 'NETWORK_ERROR', isOffline: true });
    expect(tracked).toEqual([]);
  });

  it('updateMemberRole and removeCircleMember touch exactly one member row (circle_id AND user_id filters)', async () => {
    const { updateMemberRole, removeCircleMember } = loadCircleFeatureModule();

    const update = recordingClient({ error: null });
    expect(
      await updateMemberRole(
        { circleId: CIRCLE_ID, targetUserId: VIEWER_ID, role: 'helper' },
        { getClient: update.getClient as never },
      ),
    ).toEqual({ ok: true });
    expect(update.calls).toEqual([
      ['from', 'circle_members'],
      ['update', { role: 'helper' }],
      ['eq', 'circle_id', CIRCLE_ID],
      ['eq', 'user_id', VIEWER_ID],
    ]);

    const remove = recordingClient({ error: null });
    expect(
      await removeCircleMember(
        { circleId: CIRCLE_ID, targetUserId: HELPER_ID },
        { getClient: remove.getClient as never },
      ),
    ).toEqual({ ok: true });
    expect(remove.calls).toEqual([
      ['from', 'circle_members'],
      ['delete'],
      ['eq', 'circle_id', CIRCLE_ID],
      ['eq', 'user_id', HELPER_ID],
    ]);
  });

  it('a helper sees the member list but no invite, role-change or remove controls', async () => {
    const { CircleSettingsScreen } = loadCircleFeatureModule();

    await render(
      <ThemeProvider>
        <CircleSettingsScreen
          circleId={CIRCLE_ID}
          circleName="Family Care"
          currentUserId={HELPER_ID}
          currentUserRole="helper"
          members={SAMPLE_MEMBERS}
          inviteUrl={VALID_INVITE_URL}
          errorCode="CIRCLE_FULL"
        />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('circle-member-list')).toBeTruthy();
    expect(screen.getByText('Nadia (Owner)')).toBeTruthy();
    expect(screen.getByText('Samira (Viewer)')).toBeTruthy();
    expect(screen.queryByTestId('circle-create-invite-button')).toBeNull();
    expect(screen.queryByTestId('circle-invite-role-helper')).toBeNull();
    expect(screen.queryByTestId('circle-invite-role-viewer')).toBeNull();
    // Only the owner may see invite links (Taha's decision)
    expect(screen.queryByTestId('circle-invite-link-value')).toBeNull();
    expect(screen.queryByText(VALID_INVITE_URL)).toBeNull();
    expect(screen.queryByTestId('circle-upgrade-paywall-button')).toBeNull();
    for (const member of SAMPLE_MEMBERS) {
      expect(screen.queryByTestId(`circle-member-role-toggle-${member.userId}`)).toBeNull();
      expect(screen.queryByTestId(`circle-member-remove-${member.userId}`)).toBeNull();
    }
  });

  it('a viewer never sees the invite link either', async () => {
    const { CircleSettingsScreen } = loadCircleFeatureModule();

    await render(
      <ThemeProvider>
        <CircleSettingsScreen
          circleId={CIRCLE_ID}
          circleName="Family Care"
          currentUserId={VIEWER_ID}
          currentUserRole="viewer"
          members={SAMPLE_MEMBERS}
          inviteUrl={VALID_INVITE_URL}
        />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('circle-invite-link-value')).toBeNull();
    expect(screen.queryByText(VALID_INVITE_URL)).toBeNull();
    for (const member of SAMPLE_MEMBERS) {
      expect(screen.queryByTestId(`circle-member-role-toggle-${member.userId}`)).toBeNull();
      expect(screen.queryByTestId(`circle-member-remove-${member.userId}`)).toBeNull();
    }
  });

  it('the owner invites a helper by default, turns a viewer into a helper, and sees no upgrade button without CIRCLE_FULL', async () => {
    const { CircleSettingsScreen } = loadCircleFeatureModule();
    const onCreateInvite = jest.fn();
    const onChangeMemberRole = jest.fn();

    await render(
      <ThemeProvider>
        <CircleSettingsScreen
          circleId={CIRCLE_ID}
          circleName="Family Care"
          currentUserId={OWNER_ID}
          currentUserRole="owner"
          members={SAMPLE_MEMBERS}
          onCreateInvite={onCreateInvite}
          onChangeMemberRole={onChangeMemberRole}
        />
      </ThemeProvider>,
    );

    await pressByTestId('circle-create-invite-button');
    expect(onCreateInvite).toHaveBeenCalledWith('helper');

    await pressByTestId(`circle-member-role-toggle-${VIEWER_ID}`);
    expect(onChangeMemberRole).toHaveBeenCalledWith(VIEWER_ID, 'helper');

    expect(screen.queryByTestId('circle-upgrade-paywall-button')).toBeNull();
    expect(screen.queryByTestId('circle-invite-link-value')).toBeNull();
  });

  it.each([
    ['loading', { isLoading: true }, 'circle-settings-loading'],
    ['error', { hasError: true }, 'circle-settings-error'],
    ['offline', { isOffline: true }, 'circle-settings-offline'],
  ] as const)('shows the %s state and no invite controls', async (_name, stateProps, testId) => {
    const { CircleSettingsScreen } = loadCircleFeatureModule();

    await render(
      <ThemeProvider>
        <CircleSettingsScreen
          circleId={CIRCLE_ID}
          circleName="Family Care"
          currentUserId={OWNER_ID}
          currentUserRole="owner"
          members={[]}
          onRetry={jest.fn()}
          {...stateProps}
        />
      </ThemeProvider>,
    );

    expect(screen.getByTestId(testId)).toBeTruthy();
    expect(screen.queryByTestId('circle-create-invite-button')).toBeNull();
  });

  it('the error state has a retry button', async () => {
    const { CircleSettingsScreen } = loadCircleFeatureModule();
    const onRetry = jest.fn();

    await render(
      <ThemeProvider>
        <CircleSettingsScreen
          circleId={CIRCLE_ID}
          circleName="Family Care"
          currentUserId={OWNER_ID}
          currentUserRole="owner"
          members={[]}
          hasError
          onRetry={onRetry}
        />
      </ThemeProvider>,
    );

    await pressByTestId('circle-settings-retry-button');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
