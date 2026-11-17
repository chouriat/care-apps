import { ThemeProvider } from '@carecircle/ui';
import { Stack } from 'expo-router';
import { fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { Share } from 'react-native';
import CircleRoute from '../app/circle';
import CareLogRoute from '../app/log';
import en from '../i18n/en.json';
import * as ObservabilityApi from './features/observability/api';

const CIRCLE_ID = 'c1c00001-0000-4000-8000-000000000001';
const OWNER_ID = 'c1000001-0000-4000-8000-00000000000a';
const HELPER_ID = 'c1000001-0000-4000-8000-00000000000b';
const VIEWER_ID = 'c1000001-0000-4000-8000-00000000000c';

interface FakeLogEntryRow {
  id: string;
  circle_id: string;
  type: 'dose' | 'med_change' | 'appointment' | 'task' | 'visit_note' | 'member';
  ref_id: string | null;
  summary: string | null;
  created_by: string | null;
  created_at: string;
}

function makeFakeLogClient(opts?: {
  currentUserId?: string;
  familyActive?: boolean;
  logEntries?: FakeLogEntryRow[];
  exportResponse?: {
    data?: Record<string, unknown> | null;
    error?: { message: string } | null;
  };
}) {
  const currentUserId = opts?.currentUserId ?? VIEWER_ID;
  const familyActive = opts?.familyActive ?? true;
  const logEntries: FakeLogEntryRow[] = opts?.logEntries ?? [
    {
      id: 'c1900001-0000-4000-8000-000000000003',
      circle_id: CIRCLE_ID,
      type: 'visit_note',
      ref_id: null,
      summary: 'Cardiology visit summary saved',
      created_by: OWNER_ID,
      created_at: '2026-11-16T15:00:00.000Z',
    },
    {
      id: 'c1900001-0000-4000-8000-000000000002',
      circle_id: CIRCLE_ID,
      type: 'task',
      ref_id: null,
      summary: 'Picked up prescription',
      created_by: HELPER_ID,
      created_at: '2026-11-16T12:00:00.000Z',
    },
    {
      id: 'c1900001-0000-4000-8000-000000000001',
      circle_id: CIRCLE_ID,
      type: 'dose',
      ref_id: null,
      summary: 'Metformin 500mg marked given',
      created_by: OWNER_ID,
      created_at: '2026-11-16T08:00:00.000Z',
    },
  ];

  const invokeCalls: Array<{ fn: string; body: unknown }> = [];
  const rangeCalls: Array<{ from: number; to: number }> = [];

  const client = {
    auth: {
      getSession: jest.fn(async () => ({
        data: { session: { user: { id: currentUserId } } },
        error: null,
      })),
    },
    functions: {
      invoke: jest.fn(async (fn: string, invokeOpts?: { body?: unknown }) => {
        invokeCalls.push({ fn, body: invokeOpts?.body });
        if (opts?.exportResponse) {
          return {
            data: opts.exportResponse.data ?? null,
            error: opts.exportResponse.error ?? null,
          };
        }
        return {
          data: {
            ok: true,
            pdfUrl: `https://storage.example.test/log-exports/${CIRCLE_ID}/export-1.pdf?exp=3600`,
          },
          error: null,
        };
      }),
    },
    from: jest.fn((table: string) => {
      const filters: Array<{ col: string; val: unknown }> = [];
      let inFilter: { col: string; vals: unknown[] } | null = null;

      const executeSelect = () => {
        if (table === 'circles') {
          return [
            {
              id: CIRCLE_ID,
              name: 'Bensalem Family',
              care_recipient_name: 'Nadia Bensalem',
              care_recipient_dob: null,
              timezone: 'America/New_York',
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
              joined_at: '2026-11-01T00:00:00.000Z',
            },
            {
              circle_id: CIRCLE_ID,
              user_id: HELPER_ID,
              role: 'helper',
              joined_at: '2026-11-02T00:00:00.000Z',
            },
            {
              circle_id: CIRCLE_ID,
              user_id: VIEWER_ID,
              role: 'viewer',
              joined_at: '2026-11-03T00:00:00.000Z',
            },
          ];
          return allMembers.filter((row) =>
            filters.every((f) => (row as Record<string, unknown>)[f.col] === f.val),
          );
        }
        if (table === 'users_profile') {
          const profiles = [
            { user_id: OWNER_ID, display_name: 'Leila' },
            { user_id: HELPER_ID, display_name: 'Sami' },
            { user_id: VIEWER_ID, display_name: 'Karim' },
          ];
          if (inFilter) {
            return profiles.filter((p) => inFilter?.vals.includes(p.user_id));
          }
          return profiles;
        }
        if (table === 'entitlements') {
          if (!familyActive) return [];
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
          return logEntries
            .filter((row) =>
              filters.every((f) => (row as unknown as Record<string, unknown>)[f.col] === f.val),
            )
            .sort((a, b) => b.created_at.localeCompare(a.created_at));
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
        range: (fromIdx: number, toIdx: number) => {
          rangeCalls.push({ from: fromIdx, to: toIdx });
          return Promise.resolve({
            data: executeSelect().slice(fromIdx, toIdx + 1),
            error: null,
          });
        },
        maybeSingle: () => Promise.resolve({ data: executeSelect()[0] ?? null, error: null }),
        then: (resolve: (val: unknown) => unknown) =>
          Promise.resolve({ data: executeSelect(), error: null }).then(resolve),
      };
      return builder;
    }),
  };

  return { client, invokeCalls, rangeCalls, currentUserId };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <ThemeProvider>{children}</ThemeProvider>
);

describe('CC-7 Care log screen and PDF export', () => {
  beforeEach(() => {
    delete process.env.MOCKS;
    delete process.env.EXPO_PUBLIC_MOCKS;
    jest.restoreAllMocks();
  });

  it('opens /log from /circle Care log row, allows viewer access, and filters by type and person', async () => {
    const { client, currentUserId } = makeFakeLogClient({ currentUserId: VIEWER_ID });
    const sharedDeps = {
      getClient: () => client as never,
      getUserId: async () => currentUserId,
    };

    await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        circle: () => <CircleRoute deps={sharedDeps} />,
        log: () => <CareLogRoute deps={sharedDeps} />,
      },
      { initialUrl: '/circle', wrapper },
    );

    await waitFor(() => {
      expect(screen.getByTestId('circle-care-log-button')).toBeTruthy();
    });

    await fireEvent.press(within(screen.getByTestId('circle-care-log-button')).getByRole('button'));

    await waitFor(() => {
      expect(screen.getByTestId('care-log-screen')).toBeTruthy();
      expect(screen.getByText('Cardiology visit summary saved')).toBeTruthy();
      expect(screen.getByText('Picked up prescription')).toBeTruthy();
      expect(screen.getByText('Metformin 500mg marked given')).toBeTruthy();
    });

    // Filter by type: dose
    await fireEvent.press(
      within(screen.getByTestId('care-log-filter-type-dose')).getByRole('button'),
    );
    await waitFor(() => {
      expect(screen.getByText('Metformin 500mg marked given')).toBeTruthy();
      expect(screen.queryByText('Cardiology visit summary saved')).toBeNull();
      expect(screen.queryByText('Picked up prescription')).toBeNull();
    });

    // Reset type filter to All types, then filter by person: Sami (HELPER_ID)
    await fireEvent.press(
      within(screen.getByTestId('care-log-filter-type-all')).getByRole('button'),
    );
    await waitFor(() => {
      expect(screen.getByText('Picked up prescription')).toBeTruthy();
    });

    await fireEvent.press(
      within(screen.getByTestId(`care-log-filter-person-${HELPER_ID}`)).getByRole('button'),
    );
    await waitFor(() => {
      expect(screen.getByText('Picked up prescription')).toBeTruthy();
      expect(screen.queryByText('Metformin 500mg marked given')).toBeNull();
      expect(screen.queryByText('Cardiology visit summary saved')).toBeNull();
    });
  });

  it('pages timeline 50 entries at a time and loads next page on Load more', async () => {
    const sixtyEntries: FakeLogEntryRow[] = Array.from({ length: 60 }, (_, idx) => ({
      id: `c1900099-0000-4000-8000-${String(idx + 1).padStart(12, '0')}`,
      circle_id: CIRCLE_ID,
      type: 'dose',
      ref_id: null,
      summary: `Log item #${idx + 1}`,
      created_by: OWNER_ID,
      created_at: new Date(Date.UTC(2026, 10, 16, 12, 0, 0) - idx * 60_000).toISOString(),
    }));

    const { client, rangeCalls, currentUserId } = makeFakeLogClient({
      logEntries: sixtyEntries,
    });

    await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        log: () => (
          <CareLogRoute
            deps={{
              getClient: () => client as never,
              getUserId: async () => currentUserId,
            }}
          />
        ),
      },
      { initialUrl: '/log', wrapper },
    );

    await waitFor(() => {
      expect(screen.getByText('Log item #1')).toBeTruthy();
      expect(screen.getByText('Log item #50')).toBeTruthy();
      expect(screen.queryByText('Log item #51')).toBeNull();
      expect(screen.getByTestId('care-log-load-more-button')).toBeTruthy();
    });

    expect(rangeCalls[0]).toEqual({ from: 0, to: 49 });

    await fireEvent.press(
      within(screen.getByTestId('care-log-load-more-button')).getByRole('button'),
    );

    await waitFor(() => {
      expect(screen.getByText('Log item #51')).toBeTruthy();
      expect(screen.getByText('Log item #60')).toBeTruthy();
    });

    expect(rangeCalls[1]).toEqual({ from: 50, to: 99 });
  });

  it('opens PaywallSheet and fires cc_paywall_viewed when Export PDF is tapped on a free circle', async () => {
    const { client, invokeCalls, currentUserId } = makeFakeLogClient({
      currentUserId: OWNER_ID,
      familyActive: false,
    });

    const trackSpy = jest.fn(async () => undefined);
    jest.spyOn(ObservabilityApi, 'getAppObservability').mockReturnValue({
      analytics: { track: trackSpy },
    } as never);

    await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        log: () => (
          <CareLogRoute
            deps={{
              getClient: () => client as never,
              getUserId: async () => currentUserId,
            }}
          />
        ),
      },
      { initialUrl: '/log', wrapper },
    );

    await waitFor(() => {
      expect(screen.getByTestId('care-log-export-button')).toBeTruthy();
    });

    await fireEvent.press(within(screen.getByTestId('care-log-export-button')).getByRole('button'));

    await waitFor(() => {
      expect(screen.getByTestId('paywall-sheet')).toBeTruthy();
    });

    expect(invokeCalls).toHaveLength(0);
    expect(trackSpy).toHaveBeenCalledWith('cc_paywall_viewed', { trigger: 'pdf_export' });
  });

  it('shares the signed pdfUrl and fires cc_log_exported once with { days } only on Family plan', async () => {
    const { client, invokeCalls, currentUserId } = makeFakeLogClient({
      currentUserId: OWNER_ID,
      familyActive: true,
    });

    const shareSpy = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: Share.sharedAction } as never);

    const trackSpy = jest.fn(async () => undefined);
    jest.spyOn(ObservabilityApi, 'getAppObservability').mockReturnValue({
      analytics: { track: trackSpy },
    } as never);

    await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        log: () => (
          <CareLogRoute
            deps={{
              getClient: () => client as never,
              getUserId: async () => currentUserId,
              now: () => new Date('2026-11-30T14:00:00.000Z'),
            }}
          />
        ),
      },
      { initialUrl: '/log', wrapper },
    );

    await waitFor(() => {
      expect(screen.getByTestId('care-log-export-from-input').props.value).toBe('2026-11-01');
      expect(screen.getByTestId('care-log-export-to-input').props.value).toBe('2026-11-30');
    });

    await fireEvent.press(within(screen.getByTestId('care-log-export-button')).getByRole('button'));

    await waitFor(() => {
      expect(invokeCalls).toHaveLength(1);
      expect(shareSpy).toHaveBeenCalledTimes(1);
    });

    expect(invokeCalls[0]).toEqual({
      fn: 'export-log',
      body: {
        circleId: CIRCLE_ID,
        from: '2026-11-01',
        to: '2026-11-30',
      },
    });

    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith('cc_log_exported', { days: 30 });
    const trackedJson = JSON.stringify(trackSpy.mock.calls);
    expect(trackedJson).not.toContain('Nadia');
    expect(trackedJson).not.toContain('pdfUrl');
    expect(trackedJson).not.toContain('Cardiology');
  });
});
