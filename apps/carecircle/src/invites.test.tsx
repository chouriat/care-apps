import { validateAnalyticsEvent, type MemberRole } from '@carecircle/core';
import { ThemeProvider } from '@carecircle/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ComponentType } from 'react';

async function pressByTestId(testId: string) {
  const node = screen.getByTestId(testId);
  const target =
    typeof node.props?.onPress === 'function' ? node : within(node).getByRole('button');
  await fireEvent.press(target);
}

export type InviteAssignableRole = Exclude<MemberRole, 'owner'>;

export type CreateInviteErrorCode =
  | 'VALIDATION_ERROR'
  | 'PERMISSION_DENIED'
  | 'CIRCLE_FULL'
  | 'NETWORK_ERROR'
  | 'CREATE_INVITE_FAILED';

export type AcceptInviteErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVITE_INVALID'
  | 'INVITE_EXPIRED'
  | 'INVITE_USED'
  | 'CIRCLE_FULL'
  | 'CIRCLE_LIMIT_REACHED'
  | 'NETWORK_ERROR'
  | 'ACCEPT_INVITE_FAILED';

export type MemberActionErrorCode =
  | 'VALIDATION_ERROR'
  | 'PERMISSION_DENIED'
  | 'NETWORK_ERROR'
  | 'MEMBER_ACTION_FAILED';

export interface CircleMemberItem {
  circleId: string;
  userId: string;
  displayName: string;
  role: MemberRole;
  joinedAt: string;
}

export interface CircleSettingsScreenProps {
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
