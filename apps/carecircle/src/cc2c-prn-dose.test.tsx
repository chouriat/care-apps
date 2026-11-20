// CC-2c [safety 1/2]: Real-router Jest tests for "Gave a dose now" on as-needed (`as_needed`) medicines.
// Spec: `docs/spec/carecircle.md` > Dose engine rule 2 ("an `as_needed` medicine has no scheduled
// doses; the person taps 'Gave a dose now', which records a given dose at the current time").
//
// Proposed UI & RPC contract for CC-2c [safety 2/2]:
// - RPC: `client.rpc('log_prn_dose', { medicationId })` returning the inserted `public.dose_events`
//   row (`status = 'given'`, `due_at = now()`, `acted_at = now()`, `acted_by = auth.uid()`).
// - On Today (`/(tabs)/today`), active `as_needed` medicines appear in their own section
//   (`testID="today-prn-section"`) with a row per medicine (`testID="today-prn-row-${medication.id}"`).
// - Owners and helpers see a "Gave a dose now" button (`testID="today-prn-give-${medication.id}"`);
//   viewers see the as-needed section and any given doses for today, but no "Gave a dose now" button.
// - Tapping "Gave a dose now" once calls `rpc('log_prn_dose', { medicationId })` once and displays
//   the returned dose as "Given" with its local time in the circle's time zone.
// - Why offline PRN taps must NOT be queued for later replay:
//   Scheduled doses already have a `dose_events.id` and a fixed `due_at` on the server before the
//   carer taps Given/Skip. By contrast, `public.log_prn_dose("medicationId" uuid)` takes only
//   `medicationId` and stamps both `due_at` and `acted_at` from the server's `now()`. If an offline
//   tap were queued and replayed hours later when the phone came back online, the server would record
//   `due_at = now()` at replay time instead of when the medicine was actually given, misrepresenting
//   the spacing between as-needed doses to other family members and in the doctor's care log.
//   Therefore, when offline or when the RPC fails over the network, tapping "Gave a dose now" must
//   not queue a timeless `medicationId` call or leave an unconfirmed "Given" dose on screen; it
//   leaves the check-off queue empty and shows `today-notice-checkOffFailed`.

import * as UI from '@carecircle/ui';
import { Stack } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import TabsLayout from '../app/(tabs)/_layout';
import CalendarScreen from '../app/(tabs)/calendar';
import MedsScreen from '../app/(tabs)/meds';
import TasksScreen from '../app/(tabs)/tasks';
import TodayScreen from '../app/(tabs)/today';
import { createFakeTodayClient } from './__fixtures__/today-fake-client';
import { getAppObservability } from './features/observability/api';
import {
  loadQueuedDoseCheckOffs,
  memoryTodayStorage,
  resetTodayState,
  type TodayDeps,
} from './features/today/api';

const CIRCLE_ID = 'c1c00001-0000-4000-8000-000000000001';
const OWNER_ID = 'c1000001-0000-4000-8000-00000000000a';
const VIEWER_ID = 'c1000001-0000-4000-8000-00000000000b';
const HELPER_ID = 'c1000001-0000-4000-8000-00000000000c';

const PRN_MED_ID = 'c2c20001-0000-4000-8000-000000000001';
const INACTIVE_PRN_MED_ID = 'c2c20002-0000-4000-8000-000000000002';
const DAILY_MED_ID = 'c2c20003-0000-4000-8000-000000000003';
const PRN_DOSE_ID = 'c2cd0001-0000-4000-8000-000000000001';

// 2026-11-18T14:15:00.000Z is 09:15 in America/New_York (EST, UTC-5)
const NOW_ISO = '2026-11-18T14:15:00.000Z';
const NOW = new Date(NOW_ISO);

type Row = Record<string, unknown>;

function seedTables(): Record<string, Row[]> {
  return {
    circles: [
      {
        id: CIRCLE_ID,
        name: 'Family Care',
        care_recipient_name: 'Evelyn',
        care_recipient_dob: null,
        timezone: 'America/New_York',
        created_by: OWNER_ID,
        created_at: '2026-11-01T12:00:00.000Z',
      },
    ],
    circle_members: [
      {
        circle_id: CIRCLE_ID,
        user_id: OWNER_ID,
        role: 'owner',
        joined_at: '2026-11-01T12:00:00.000Z',
      },
      {
        circle_id: CIRCLE_ID,
        user_id: VIEWER_ID,
        role: 'viewer',
        joined_at: '2026-11-02T12:00:00.000Z',
      },
      {
        circle_id: CIRCLE_ID,
        user_id: HELPER_ID,
        role: 'helper',
        joined_at: '2026-11-03T12:00:00.000Z',
      },
    ],
    medications: [
      {
        id: PRN_MED_ID,
        circle_id: CIRCLE_ID,
        name: 'Paracetamol',
        strength: '500 mg',
        dose_text: '1 tablet as needed',
        schedule: { kind: 'as_needed' },
        instructions: 'Max 4 tablets in 24h',
        start_date: '2026-11-01',
        end_date: null,
        active: true,
        source: 'manual',
      },
      {
        id: INACTIVE_PRN_MED_ID,
        circle_id: CIRCLE_ID,
        name: 'Paused Ibuprofen',
        strength: '200 mg',
        dose_text: '1 tablet as needed',
        schedule: { kind: 'as_needed' },
        instructions: null,
        start_date: '2026-11-01',
        end_date: null,
        active: false,
        source: 'manual',
      },
      {
        id: DAILY_MED_ID,
        circle_id: CIRCLE_ID,
        name: 'Metformin',
        strength: '500 mg',
        dose_text: '1 tablet',
        schedule: { kind: 'daily', times: ['08:00'] },
        instructions: 'With breakfast',
        start_date: '2026-11-01',
        end_date: null,
        active: true,
        source: 'manual',
      },
    ],
    dose_events: [],
    appointments: [],
    tasks: [],
  };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <UI.ThemeProvider>{children}</UI.ThemeProvider>
);

function setupTodayRouter(opts: { userId: string; rpcOnline?: () => boolean }) {
  const tables = seedTables();
  let online = true;
  const isRpcOnline = opts.rpcOnline ?? (() => online);

  const { client, rpcCalls } = createFakeTodayClient({
    tables,
    isOnline: () => true,
    rpc: (fn, args) => {
      if (!isRpcOnline()) {
        return {
          data: null,
          error: { message: 'TypeError: Network request failed', code: 'NETWORK_ERROR' },
        };
      }
      if (fn === 'log_prn_dose') {
        const createdRow: Row = {
          id: PRN_DOSE_ID,
          medication_id: args.medicationId,
          circle_id: CIRCLE_ID,
          due_at: NOW_ISO,
          status: 'given',
          acted_by: opts.userId,
          acted_at: NOW_ISO,
        };
        tables.dose_events = [...(tables.dose_events ?? []), createdRow];
        return { data: createdRow, error: null };
      }
      return { data: null, error: { message: `Unexpected RPC ${fn}` } };
    },
  });

  const deps: TodayDeps = {
    getClient: () => client,
    getUserId: async () => opts.userId,
    storage: memoryTodayStorage,
    now: () => NOW,
  };

  const routes = {
    _layout: () => <Stack screenOptions={{ headerShown: false }} />,
    '(tabs)/_layout': TabsLayout,
    '(tabs)/today': () => <TodayScreen deps={deps} referenceNow={NOW} />,
    '(tabs)/meds': () => <MedsScreen />,
    '(tabs)/calendar': () => <CalendarScreen referenceNow={NOW} />,
    '(tabs)/tasks': () => <TasksScreen />,
  };

  return {
    tables,
    rpcCalls,
    routes,
    setOnline: (next: boolean) => {
      online = next;
    },
  };
}

beforeEach(() => {
  resetTodayState();
  delete process.env.MOCKS;
  delete process.env.EXPO_PUBLIC_MOCKS;
  jest.restoreAllMocks();
});

describe('CC-2c "Gave a dose now" for as-needed medicines on Today', () => {
  it('renders active as-needed medicines in their own Today section with a "Gave a dose now" button for owners and helpers, and none for viewers', async () => {
    // 1. Owner sees the as-needed section and the "Gave a dose now" button
    const ownerSetup = setupTodayRouter({ userId: OWNER_ID });
    const ownerView = await renderRouter(ownerSetup.routes, { initialUrl: '/today', wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('today-prn-section')).toBeTruthy();
    });
    const ownerPrnSection = screen.getByTestId('today-prn-section');
    expect(within(ownerPrnSection).getByTestId(`today-prn-row-${PRN_MED_ID}`)).toBeTruthy();
    expect(within(ownerPrnSection).getByText(/Paracetamol/)).toBeTruthy();
    expect(within(ownerPrnSection).queryByText(/Paused Ibuprofen/)).toBeNull();
    expect(within(ownerPrnSection).queryByText(/Metformin/)).toBeNull();
    expect(within(ownerPrnSection).getByTestId(`today-prn-give-${PRN_MED_ID}`)).toBeTruthy();

    await act(async () => {
      ownerView.unmount();
    });
    resetTodayState();

    // 2. Helper also sees the "Gave a dose now" button
    const helperSetup = setupTodayRouter({ userId: HELPER_ID });
    const helperView = await renderRouter(helperSetup.routes, { initialUrl: '/today', wrapper });

    await waitFor(() => {
      expect(screen.getByTestId(`today-prn-give-${PRN_MED_ID}`)).toBeTruthy();
    });

    await act(async () => {
      helperView.unmount();
    });
    resetTodayState();

    // 3. Viewer sees the as-needed medicine row, but no "Gave a dose now" button
    const viewerSetup = setupTodayRouter({ userId: VIEWER_ID });
    const viewerView = await renderRouter(viewerSetup.routes, { initialUrl: '/today', wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('today-prn-section')).toBeTruthy();
      expect(screen.getByTestId(`today-prn-row-${PRN_MED_ID}`)).toBeTruthy();
    });
    expect(screen.queryByTestId(`today-prn-give-${PRN_MED_ID}`)).toBeNull();

    await act(async () => {
      viewerView.unmount();
    });
  });

  it('one tap on "Gave a dose now" calls log_prn_dose once and shows the dose as Given with its time in the circle timezone', async () => {
    const { routes, rpcCalls } = setupTodayRouter({ userId: HELPER_ID });
    const view = await renderRouter(routes, { initialUrl: '/today', wrapper });

    await waitFor(() => {
      expect(screen.getByTestId(`today-prn-give-${PRN_MED_ID}`)).toBeTruthy();
    });

    const giveButton = within(screen.getByTestId(`today-prn-give-${PRN_MED_ID}`)).getByRole(
      'button',
    );
    await fireEvent.press(giveButton);

    await waitFor(() => {
      expect(rpcCalls).toEqual([
        {
          fn: 'log_prn_dose',
          args: { medicationId: PRN_MED_ID },
        },
      ]);
    });

    // 2026-11-18T14:15:00.000Z in America/New_York is 09:15, shown as Given
    await waitFor(() => {
      expect(screen.getByText(/09:15/)).toBeTruthy();
      expect(screen.getByText('Given')).toBeTruthy();
    });

    await act(async () => {
      view.unmount();
    });
  });

  it('does not queue an as-needed dose offline (because log_prn_dose stamps due_at/acted_at with server now()) and instead shows the not-saved notice', async () => {
    const { routes, rpcCalls } = setupTodayRouter({
      userId: OWNER_ID,
      rpcOnline: () => false,
    });
    const view = await renderRouter(routes, { initialUrl: '/today', wrapper });

    await waitFor(() => {
      expect(screen.getByTestId(`today-prn-give-${PRN_MED_ID}`)).toBeTruthy();
    });

    const giveButton = within(screen.getByTestId(`today-prn-give-${PRN_MED_ID}`)).getByRole(
      'button',
    );
    await fireEvent.press(giveButton);

    await waitFor(() => {
      expect(screen.getByTestId('today-notice-checkOffFailed')).toBeTruthy();
    });

    expect(rpcCalls).toEqual([
      {
        fn: 'log_prn_dose',
        args: { medicationId: PRN_MED_ID },
      },
    ]);
    // Never queued into the scheduled-dose check-off queue, and never left on screen as Given
    const queued = await loadQueuedDoseCheckOffs(memoryTodayStorage, OWNER_ID);
    expect(queued).toEqual([]);
    expect(screen.queryByTestId(`today-dose-row-${PRN_DOSE_ID}`)).toBeNull();

    await act(async () => {
      view.unmount();
    });
  });

  it('double tap before the RPC resolves sends exactly one log_prn_dose call', async () => {
    const tables = seedTables();
    const { client: baseClient } = createFakeTodayClient({ tables });
    const deferredRpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    let resolveRpc!: (res: { data: unknown; error: null }) => void;
    const pendingRpc = new Promise<{ data: unknown; error: null }>((resolve) => {
      resolveRpc = resolve;
    });

    const deps: TodayDeps = {
      getClient: () =>
        ({
          from: (baseClient as unknown as { from: unknown }).from,
          rpc: (fn: string, args: Record<string, unknown>) => {
            deferredRpcCalls.push({ fn, args });
            return pendingRpc;
          },
        }) as unknown as ReturnType<NonNullable<TodayDeps['getClient']>>,
      getUserId: async () => OWNER_ID,
      storage: memoryTodayStorage,
      now: () => NOW,
    };

    const routes = {
      _layout: () => <Stack screenOptions={{ headerShown: false }} />,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/today': () => <TodayScreen deps={deps} referenceNow={NOW} />,
      '(tabs)/meds': () => <MedsScreen />,
      '(tabs)/calendar': () => <CalendarScreen referenceNow={NOW} />,
      '(tabs)/tasks': () => <TasksScreen />,
    };

    const view = await renderRouter(routes, { initialUrl: '/today', wrapper });

    await waitFor(() => {
      expect(screen.getByTestId(`today-prn-give-${PRN_MED_ID}`)).toBeTruthy();
    });

    const giveButton = within(screen.getByTestId(`today-prn-give-${PRN_MED_ID}`)).getByRole(
      'button',
    );
    await fireEvent.press(giveButton);
    await fireEvent.press(giveButton);

    expect(deferredRpcCalls).toEqual([
      {
        fn: 'log_prn_dose',
        args: { medicationId: PRN_MED_ID },
      },
    ]);

    await act(async () => {
      resolveRpc({
        data: {
          id: PRN_DOSE_ID,
          medication_id: PRN_MED_ID,
          circle_id: CIRCLE_ID,
          due_at: NOW_ISO,
          status: 'given',
          acted_by: OWNER_ID,
          acted_at: NOW_ISO,
        },
        error: null,
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/09:15/)).toBeTruthy();
      expect(screen.getByText('Given')).toBeTruthy();
    });
    expect(deferredRpcCalls).toHaveLength(1);

    await act(async () => {
      view.unmount();
    });
  });

  it('shows a notice, displays no Given row, and queues nothing when log_prn_dose returns P0001 DUPLICATE_PRN_DOSE or NOT_AS_NEEDED', async () => {
    for (const refusalCode of ['DUPLICATE_PRN_DOSE', 'NOT_AS_NEEDED'] as const) {
      const tables = seedTables();
      const { client, rpcCalls } = createFakeTodayClient({
        tables,
        rpc: () => ({
          data: null,
          error: { code: 'P0001', message: refusalCode },
        }),
      });

      const deps: TodayDeps = {
        getClient: () => client,
        getUserId: async () => OWNER_ID,
        storage: memoryTodayStorage,
        now: () => NOW,
      };

      const routes = {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        '(tabs)/_layout': TabsLayout,
        '(tabs)/today': () => <TodayScreen deps={deps} referenceNow={NOW} />,
        '(tabs)/meds': () => <MedsScreen />,
        '(tabs)/calendar': () => <CalendarScreen referenceNow={NOW} />,
        '(tabs)/tasks': () => <TasksScreen />,
      };

      const view = await renderRouter(routes, { initialUrl: '/today', wrapper });

      await waitFor(() => {
        expect(screen.getByTestId(`today-prn-give-${PRN_MED_ID}`)).toBeTruthy();
      });

      const giveButton = within(screen.getByTestId(`today-prn-give-${PRN_MED_ID}`)).getByRole(
        'button',
      );
      await fireEvent.press(giveButton);

      await waitFor(() => {
        expect(screen.getByTestId('today-notice-checkOffFailed')).toBeTruthy();
      });

      expect(rpcCalls).toEqual([{ fn: 'log_prn_dose', args: { medicationId: PRN_MED_ID } }]);
      expect(screen.queryByText('Given')).toBeNull();
      expect(screen.queryByTestId(`today-dose-row-${PRN_DOSE_ID}`)).toBeNull();
      const queued = await loadQueuedDoseCheckOffs(memoryTodayStorage, OWNER_ID);
      expect(queued).toEqual([]);

      await act(async () => {
        view.unmount();
      });
      resetTodayState();
    }
  });

  it('shows an earlier given as-needed dose today at 07:30 circle time in today-prn-section for owner, helper, and viewer, and shows its time exactly once on Today', async () => {
    // 2026-11-18T12:30:00.000Z is 07:30 in America/New_York (EST, UTC-5)
    const EARLIER_PRN_ISO = '2026-11-18T12:30:00.000Z';
    const DAILY_DOSE_ISO = '2026-11-18T13:00:00.000Z';

    for (const userId of [OWNER_ID, HELPER_ID, VIEWER_ID]) {
      const setup = setupTodayRouter({ userId });
      setup.tables.dose_events = [
        {
          id: PRN_DOSE_ID,
          medication_id: PRN_MED_ID,
          circle_id: CIRCLE_ID,
          due_at: EARLIER_PRN_ISO,
          status: 'given',
          acted_by: OWNER_ID,
          acted_at: EARLIER_PRN_ISO,
        },
        {
          id: 'c2cd0002-0000-4000-8000-000000000002',
          medication_id: DAILY_MED_ID,
          circle_id: CIRCLE_ID,
          due_at: DAILY_DOSE_ISO,
          status: 'pending',
          acted_by: null,
          acted_at: null,
        },
      ];

      const view = await renderRouter(setup.routes, { initialUrl: '/today', wrapper });

      await waitFor(() => {
        expect(screen.getByTestId('today-prn-section')).toBeTruthy();
      });

      const prnSection = screen.getByTestId('today-prn-section');
      expect(within(prnSection).getByText(/07:30/)).toBeTruthy();
      // Appears once in today-prn-section and nowhere else (not duplicated among scheduled doses)
      expect(screen.getAllByText(/07:30/)).toHaveLength(1);
      expect(screen.queryByTestId('today-dose-time-07:30')).toBeNull();

      await act(async () => {
        view.unmount();
      });
      resetTodayState();
    }
  });

  it('sends cc_dose_given once with { status: "given" } and nothing else on a successful tap, and sends nothing on a failed tap', async () => {
    const trackSpy = jest
      .spyOn(getAppObservability().analytics, 'track')
      .mockResolvedValue(undefined);

    // 1. Successful tap sends cc_dose_given once with { status: 'given' } only
    const okSetup = setupTodayRouter({ userId: OWNER_ID });
    const okView = await renderRouter(okSetup.routes, { initialUrl: '/today', wrapper });

    await waitFor(() => {
      expect(screen.getByTestId(`today-prn-give-${PRN_MED_ID}`)).toBeTruthy();
    });
    await fireEvent.press(
      within(screen.getByTestId(`today-prn-give-${PRN_MED_ID}`)).getByRole('button'),
    );

    await waitFor(() => {
      expect(screen.getByText('Given')).toBeTruthy();
    });
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy.mock.calls).toEqual([['cc_dose_given', { status: 'given' }]]);

    await act(async () => {
      okView.unmount();
    });
    resetTodayState();

    // 2. Failed tap sends nothing
    trackSpy.mockClear();
    const failTables = seedTables();
    const { client: failClient } = createFakeTodayClient({
      tables: failTables,
      rpc: () => ({
        data: null,
        error: { code: 'P0001', message: 'DUPLICATE_PRN_DOSE' },
      }),
    });
    const failDeps: TodayDeps = {
      getClient: () => failClient,
      getUserId: async () => OWNER_ID,
      storage: memoryTodayStorage,
      now: () => NOW,
    };
    const failRoutes = {
      _layout: () => <Stack screenOptions={{ headerShown: false }} />,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/today': () => <TodayScreen deps={failDeps} referenceNow={NOW} />,
      '(tabs)/meds': () => <MedsScreen />,
      '(tabs)/calendar': () => <CalendarScreen referenceNow={NOW} />,
      '(tabs)/tasks': () => <TasksScreen />,
    };

    const failView = await renderRouter(failRoutes, { initialUrl: '/today', wrapper });
    await waitFor(() => {
      expect(screen.getByTestId(`today-prn-give-${PRN_MED_ID}`)).toBeTruthy();
    });
    await fireEvent.press(
      within(screen.getByTestId(`today-prn-give-${PRN_MED_ID}`)).getByRole('button'),
    );

    await waitFor(() => {
      expect(screen.getByTestId('today-notice-checkOffFailed')).toBeTruthy();
    });
    expect(trackSpy).not.toHaveBeenCalled();

    await act(async () => {
      failView.unmount();
    });
  });
});
