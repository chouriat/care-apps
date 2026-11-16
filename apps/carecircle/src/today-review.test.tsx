// Added in the PR #30 review. Each test here failed on Gemini's commit 53e90ed.
import * as UI from '@carecircle/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import TodayScreen, { TODAY_RETRY_INTERVAL_MS } from '../app/(tabs)/today';
import en from '../i18n/en.json';
import { createFakeTodayClient } from './__fixtures__/today-fake-client';
import {
  TODAY_CHECKOFF_QUEUE_KEY,
  checkOffDose,
  flushQueuedDoseCheckOffs,
  loadCachedTodaySnapshot,
  loadQueuedDoseCheckOffs,
  loadTodaySnapshot,
  memoryTodayStorage,
  resetTodayState,
  type TodayDeps,
} from './features/today/api';

const circleId = 'c1c00001-0000-4000-8000-000000000001';
const medId = 'c1200001-0000-4000-8000-000000000001';
const ownerId = 'c1000001-0000-4000-8000-00000000000a';
const viewerId = 'c1000001-0000-4000-8000-00000000000b';
const helperId = 'c1000001-0000-4000-8000-00000000000c';
const dose1 = 'c1300001-0000-4000-8000-000000000031';
const dose2 = 'c1300001-0000-4000-8000-000000000032';
const dose3 = 'c1300001-0000-4000-8000-000000000033';
const oldDose = 'c1300001-0000-4000-8000-000000000039';
const NOW = new Date('2026-11-15T12:00:00.000Z');

function pendingDose(id: string, dueAt: string) {
  return {
    id,
    medication_id: medId,
    circle_id: circleId,
    due_at: dueAt,
    status: 'pending',
    acted_by: null,
    acted_at: null,
  };
}

function tables() {
  return {
    circles: [
      {
        id: circleId,
        name: 'Review Circle',
        care_recipient_name: 'Evelyn',
        care_recipient_dob: null,
        timezone: 'Europe/London',
        created_by: ownerId,
        created_at: '2026-11-01T12:00:00.000Z',
      },
    ],
    // The owner's row comes first, as it would for a viewer reading the members list.
    circle_members: [
      { circle_id: circleId, user_id: ownerId, role: 'owner', joined_at: '2026-11-01T12:00:00Z' },
      { circle_id: circleId, user_id: viewerId, role: 'viewer', joined_at: '2026-11-02T12:00:00Z' },
      { circle_id: circleId, user_id: helperId, role: 'helper', joined_at: '2026-11-03T12:00:00Z' },
    ],
    medications: [
      {
        id: medId,
        circle_id: circleId,
        name: 'Metformin',
        strength: '500 mg',
        dose_text: '1 tablet',
        schedule: { kind: 'daily', times: ['14:00', '16:00', '18:00'] },
        instructions: null,
        start_date: '2026-10-01',
        end_date: null,
        active: true,
        source: 'manual',
      },
    ],
    dose_events: [
      pendingDose(dose1, '2026-11-15T14:00:00.000Z'),
      pendingDose(dose2, '2026-11-15T16:00:00.000Z'),
      pendingDose(dose3, '2026-11-15T18:00:00.000Z'),
      pendingDose(oldDose, '2026-10-01T14:00:00.000Z'),
    ],
  };
}

beforeEach(() => {
  resetTodayState();
  delete process.env.MOCKS;
  delete process.env.EXPO_PUBLIC_MOCKS;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('PR #30 review: Today screen', () => {
  it('uses the signed-in user’s own role, not the first member row, and shows no buttons to a viewer', async () => {
    const fake = createFakeTodayClient({ tables: tables() });
    const deps = (userId: string | null): TodayDeps => ({
      getClient: () => fake.client,
      getUserId: async () => userId,
      storage: memoryTodayStorage,
      now: () => NOW,
    });

    const asViewer = await loadTodaySnapshot(deps(viewerId));
    expect(asViewer.ok && asViewer.snapshot.memberRole).toBe('viewer');
    const asHelper = await loadTodaySnapshot(deps(helperId));
    expect(asHelper.ok && asHelper.snapshot.memberRole).toBe('helper');
    // No session or no row: no edit rights.
    const unknown = await loadTodaySnapshot(deps(null));
    expect(unknown.ok && unknown.snapshot.memberRole).toBe('viewer');

    await render(
      <UI.ThemeProvider>
        <TodayScreen deps={deps(viewerId)} referenceNow={NOW} />
      </UI.ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId(`today-dose-row-${dose1}`)).toBeTruthy());
    expect(screen.queryByTestId(`today-dose-given-${dose1}`)).toBeNull();
    expect(screen.queryByTestId(`today-dose-skip-${dose1}`)).toBeNull();
  });

  it('loads only doses near today, not the circle’s whole history', async () => {
    const fake = createFakeTodayClient({ tables: tables() });
    const res = await loadTodaySnapshot({
      getClient: () => fake.client,
      getUserId: async () => ownerId,
      storage: memoryTodayStorage,
      now: () => NOW,
    });
    expect(res.ok && res.snapshot.doseEvents.map((d) => d.id)).toEqual([dose1, dose2, dose3]);
    const doseQuery = fake.queries.find((q) => q.table === 'dose_events');
    expect(doseQuery?.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'circle_id', circleId],
        ['gte', 'due_at', expect.any(String)],
        ['lte', 'due_at', expect.any(String)],
      ]),
    );
  });

  it('puts a dose back to Pending and says so when the server refuses the check-off', async () => {
    const fake = createFakeTodayClient({
      tables: tables(),
      rpc: () => ({ data: null, error: { message: 'permission denied', code: '42501' } }),
    });
    const deps: TodayDeps = {
      getClient: () => fake.client,
      getUserId: async () => helperId,
      storage: memoryTodayStorage,
      now: () => NOW,
      trackDoseAction: jest.fn(),
    };

    await render(
      <UI.ThemeProvider>
        <TodayScreen deps={deps} referenceNow={NOW} />
      </UI.ThemeProvider>,
    );
    const given = await screen.findByTestId(`today-dose-given-${dose1}`);
    await fireEvent.press(within(given).getByRole('button'));

    await waitFor(() => expect(screen.getByTestId('today-notice-checkOffFailed')).toBeTruthy());
    expect(
      within(screen.getByTestId(`today-dose-status-${dose1}`)).getByText(en.today.statusPending),
    ).toBeTruthy();
    expect(screen.getByTestId(`today-dose-given-${dose1}`)).toBeTruthy();
    expect(deps.trackDoseAction).not.toHaveBeenCalled();
    expect(await loadQueuedDoseCheckOffs(memoryTodayStorage)).toEqual([]);
  });

  it('drops a queued check-off the server refuses and still sends the ones behind it', async () => {
    let online = false;
    const fake = createFakeTodayClient({
      tables: tables(),
      isOnline: () => online,
      rpc: (_fn, args) =>
        args.doseEventId === dose2
          ? { data: null, error: { message: 'dose is not pending', code: 'P0001' } }
          : { data: { id: args.doseEventId }, error: null },
    });
    const deps: TodayDeps = {
      getClient: () => fake.client,
      getUserId: async () => helperId,
      storage: memoryTodayStorage,
      now: () => NOW,
      trackDoseAction: () => undefined,
    };
    for (const id of [dose1, dose2, dose3]) {
      const res = await checkOffDose(
        { doseEventId: id, status: 'given', memberRole: 'helper' },
        deps,
      );
      expect(res).toMatchObject({ ok: true, queued: true });
    }

    online = true;
    const flushed = await flushQueuedDoseCheckOffs(deps);
    expect(flushed).toEqual({
      ok: true,
      isOffline: false,
      flushedCount: 2,
      remainingCount: 0,
      refusedCount: 1,
    });
    expect(fake.rpcCalls.map((c) => c.args.doseEventId)).toEqual([dose1, dose2, dose3]);
    expect(await loadQueuedDoseCheckOffs(memoryTodayStorage)).toEqual([]);

    // A second flush sends nothing again.
    await flushQueuedDoseCheckOffs(deps);
    expect(fake.rpcCalls).toHaveLength(3);
  });

  it('never sends or shows another account’s queued check-offs and cached family data', async () => {
    let online = true;
    const fake = createFakeTodayClient({ tables: tables(), isOnline: () => online });
    const as = (userId: string): TodayDeps => ({
      getClient: () => fake.client,
      getUserId: async () => userId,
      storage: memoryTodayStorage,
      now: () => NOW,
      trackDoseAction: () => undefined,
    });

    // The helper loads Today, goes offline and taps Given.
    expect((await loadTodaySnapshot(as(helperId))).ok).toBe(true);
    online = false;
    await checkOffDose({ doseEventId: dose1, status: 'given', memberRole: 'helper' }, as(helperId));

    // Someone else signs in on the same phone, still offline: no cached family data for them.
    expect(await loadCachedTodaySnapshot(memoryTodayStorage, ownerId)).toBeNull();
    const ownerOffline = await loadTodaySnapshot(as(ownerId));
    expect(ownerOffline).toMatchObject({ ok: false, isOffline: true });

    // Back online as the other account: the helper's check-off is not sent under their name...
    online = true;
    const ownerFlush = await flushQueuedDoseCheckOffs(as(ownerId));
    expect(ownerFlush).toMatchObject({ flushedCount: 0, remainingCount: 0 });
    expect(fake.rpcCalls).toEqual([]);

    // ...and is sent when the helper signs in again.
    const helperFlush = await flushQueuedDoseCheckOffs(as(helperId));
    expect(helperFlush).toMatchObject({ ok: true, flushedCount: 1 });
    expect(fake.rpcCalls.map((c) => c.args.doseEventId)).toEqual([dose1]);
    const raw = await memoryTodayStorage.getItem(TODAY_CHECKOFF_QUEUE_KEY);
    expect(JSON.parse(String(raw))).toEqual([]);
  });

  it('sends queued check-offs by itself when the network returns, without a tap', async () => {
    jest.useFakeTimers();
    let online = true;
    const fake = createFakeTodayClient({ tables: tables(), isOnline: () => online });
    const deps: TodayDeps = {
      getClient: () => fake.client,
      getUserId: async () => helperId,
      storage: memoryTodayStorage,
      now: () => NOW,
      trackDoseAction: () => undefined,
    };

    await render(
      <UI.ThemeProvider>
        <TodayScreen deps={deps} referenceNow={NOW} />
      </UI.ThemeProvider>,
    );
    const given = await screen.findByTestId(`today-dose-given-${dose1}`);

    online = false;
    await fireEvent.press(within(given).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('today-offline-banner')).toBeTruthy());
    expect(fake.rpcCalls).toEqual([]);

    online = true;
    await act(async () => {
      jest.advanceTimersByTime(TODAY_RETRY_INTERVAL_MS);
    });
    await waitFor(() =>
      expect(fake.rpcCalls).toEqual([
        { fn: 'set_dose_status', args: { doseEventId: dose1, status: 'given' } },
      ]),
    );
    await waitFor(() => expect(screen.queryByTestId('today-offline-banner')).toBeNull());
  });
});
