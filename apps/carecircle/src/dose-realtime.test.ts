// CC-2b [safety 1/2]: Realtime `dose_events` subscription and `cc_dose_given` / `cc_dose_missed`
// analytics tests.
//
// Proposed app module for CC-2b [safety 2/2]:
// - `apps/carecircle/src/features/today/realtime.ts`:
//   exports `subscribeToCircleDoseEvents(options: SubscribeToCircleDoseEventsOptions): () => void`
//   and `applyRealtimeDoseUpdateToSnapshot(snapshot: TodaySnapshot, rawRow: unknown): { snapshot: TodaySnapshot; newlyMissed: boolean; updatedDose: DoseEvent | null }`.

import { waitFor } from '@testing-library/react-native';
import {
  CARECIRCLE_MOCKS,
  validateAnalyticsEvent,
  type DoseEvent,
  type DoseEventRow,
} from '@carecircle/core';
import {
  buildSnapshotFromMocks,
  checkOffDose,
  loadCachedTodaySnapshot,
  memoryTodayStorage,
  resetTodayState,
  saveCachedTodaySnapshot,
  type TodayStorageAdapter,
} from './features/today/api';

const mockTrack = jest.fn();

jest.mock('./features/observability/api', () => ({
  ...jest.requireActual('./features/observability/api'),
  getAppObservability: () => ({
    analytics: { track: (...args: unknown[]) => mockTrack(...args) },
  }),
}));

interface PostgresChangesFilter {
  event: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
  schema: string;
  table: string;
  filter?: string;
}

interface PostgresChangesPayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old?: Record<string, unknown>;
}

interface RealtimeChannelLike {
  on: (
    type: 'postgres_changes',
    filter: PostgresChangesFilter,
    callback: (payload: PostgresChangesPayload) => void,
  ) => RealtimeChannelLike;
  subscribe: () => RealtimeChannelLike;
  unsubscribe?: () => Promise<unknown> | unknown;
}

interface RealtimeSupabaseClientLike {
  channel: (name: string) => RealtimeChannelLike;
  removeChannel?: (channel: RealtimeChannelLike) => Promise<unknown> | unknown;
}

interface SubscribeToCircleDoseEventsOptions {
  circleId: string;
  getClient?: () => RealtimeSupabaseClientLike;
  storage?: TodayStorageAdapter;
  userId?: string | null;
  onDoseEventChange?: (dose: DoseEvent, meta: { newlyMissed: boolean }) => void;
  trackDoseMissed?: (missedCount: number) => void;
}

interface DoseRealtimeModule {
  subscribeToCircleDoseEvents: (options: SubscribeToCircleDoseEventsOptions) => () => void;
}

function loadDoseRealtimeModule(): DoseRealtimeModule {
  // Loaded at runtime so the [safety 1/2] tests-only PR typechecks before features/today/realtime.ts exists.
  return jest.requireActual<DoseRealtimeModule>('./features/today/realtime');
}

function createFakeRealtimeClient() {
  const subscriptions: Array<{
    channelName: string;
    filter: PostgresChangesFilter;
    callback: (payload: PostgresChangesPayload) => void;
  }> = [];
  let subscribedCount = 0;
  let unsubscribedCount = 0;
  let removedChannelCount = 0;

  const client: RealtimeSupabaseClientLike = {
    channel(channelName: string) {
      const ch: RealtimeChannelLike = {
        on(_type, filter, callback) {
          subscriptions.push({ channelName, filter, callback });
          return ch;
        },
        subscribe() {
          subscribedCount += 1;
          return ch;
        },
        unsubscribe() {
          unsubscribedCount += 1;
          return Promise.resolve('ok');
        },
      };
      return ch;
    },
    removeChannel() {
      removedChannelCount += 1;
      return Promise.resolve('ok');
    },
  };

  return {
    client,
    subscriptions,
    getCounts: () => ({
      subscribedCount,
      unsubscribedCount,
      removedChannelCount,
    }),
    emitUpdate: (newRow: Record<string, unknown>, oldRow?: Record<string, unknown>) => {
      for (const sub of subscriptions) {
        sub.callback({
          eventType: 'UPDATE',
          new: newRow,
          old: oldRow,
        });
      }
    },
  };
}

const CIRCLE_ID = CARECIRCLE_MOCKS.circle.id;
const OTHER_CIRCLE_ID = 'c1c00002-0000-4000-8000-000000000002';
const PENDING_DOSE_ID = 'c1300001-0000-4000-8000-000000000014';
const MED_ID = CARECIRCLE_MOCKS.medications[0]!.id;
const HELPER_ID = CARECIRCLE_MOCKS.members[1]!.userId;

describe('CC-2b Realtime dose_events subscription and cc_dose_given / cc_dose_missed analytics', () => {
  beforeEach(() => {
    resetTodayState();
    mockTrack.mockReset();
    mockTrack.mockResolvedValue(undefined);
  });

  it('subscribes to public.dose_events filtered by circle_id=eq.<id>, applies an UPDATE to the cached dose, and unsubscribes on unmount', async () => {
    const { subscribeToCircleDoseEvents } = loadDoseRealtimeModule();
    const fakeRealtime = createFakeRealtimeClient();
    const initialSnapshot = {
      ...buildSnapshotFromMocks(CARECIRCLE_MOCKS, 'owner'),
      userId: HELPER_ID,
    };
    await saveCachedTodaySnapshot(initialSnapshot, memoryTodayStorage);

    const receivedUpdates: Array<{ dose: DoseEvent; newlyMissed: boolean }> = [];
    const unsubscribe = subscribeToCircleDoseEvents({
      circleId: CIRCLE_ID,
      getClient: () => fakeRealtime.client,
      storage: memoryTodayStorage,
      userId: HELPER_ID,
      onDoseEventChange: (dose, meta) => {
        receivedUpdates.push({ dose, newlyMissed: meta.newlyMissed });
      },
    });

    expect(fakeRealtime.subscriptions).toHaveLength(1);
    expect(fakeRealtime.subscriptions[0]!.filter).toEqual({
      event: '*',
      schema: 'public',
      table: 'dose_events',
      filter: `circle_id=eq.${CIRCLE_ID}`,
    });
    expect(fakeRealtime.getCounts().subscribedCount).toBe(1);

    // An UPDATE for another circle is ignored
    const otherCircleRow: DoseEventRow = {
      id: PENDING_DOSE_ID,
      medication_id: MED_ID,
      circle_id: OTHER_CIRCLE_ID,
      due_at: '2026-11-15T20:00:00.000Z',
      status: 'given',
      acted_by: HELPER_ID,
      acted_at: '2026-11-15T20:01:00.000Z',
    };
    fakeRealtime.emitUpdate(otherCircleRow);
    expect(receivedUpdates).toHaveLength(0);

    // A valid UPDATE on CIRCLE_ID updates the cached dose from 'pending' to 'given'
    const updatedRow: DoseEventRow = {
      id: PENDING_DOSE_ID,
      medication_id: MED_ID,
      circle_id: CIRCLE_ID,
      due_at: '2026-11-15T20:00:00.000Z',
      status: 'given',
      acted_by: HELPER_ID,
      acted_at: '2026-11-15T20:02:00.000Z',
    };
    fakeRealtime.emitUpdate(updatedRow);

    await waitFor(() => expect(receivedUpdates).toHaveLength(1));
    expect(receivedUpdates[0]).toEqual({
      dose: {
        id: PENDING_DOSE_ID,
        medicationId: MED_ID,
        circleId: CIRCLE_ID,
        dueAt: '2026-11-15T20:00:00.000Z',
        status: 'given',
        actedBy: HELPER_ID,
        actedAt: '2026-11-15T20:02:00.000Z',
      },
      newlyMissed: false,
    });

    const cached = await loadCachedTodaySnapshot(memoryTodayStorage, HELPER_ID);
    const cachedDose = cached?.doseEvents.find((d) => d.id === PENDING_DOSE_ID);
    expect(cachedDose?.status).toBe('given');
    expect(cachedDose?.actedBy).toBe(HELPER_ID);

    // Unsubscribing cleans up the channel
    unsubscribe();
    const counts = fakeRealtime.getCounts();
    expect(counts.unsubscribedCount + counts.removedChannelCount).toBeGreaterThanOrEqual(1);
  });

  it('fires cc_dose_given on check-off and cc_dose_missed when a pending dose becomes missed, with no medication name, dose, or free text', async () => {
    const { subscribeToCircleDoseEvents } = loadDoseRealtimeModule();
    const trackedEvents: Array<{ event: string; props: Record<string, unknown> }> = [];

    // 1. Checking off a dose fires cc_dose_given with only { status }
    await checkOffDose(
      {
        doseEventId: PENDING_DOSE_ID,
        status: 'given',
        memberRole: 'helper',
      },
      {
        getClient: () =>
          ({
            rpc: async () => ({
              data: { id: PENDING_DOSE_ID, status: 'given' },
              error: null,
            }),
          }) as never,
        getUserId: async () => HELPER_ID,
        storage: memoryTodayStorage,
        trackDoseAction: (status) => {
          const validated = validateAnalyticsEvent('cc_dose_given', { status });
          trackedEvents.push({ event: 'cc_dose_given', props: validated });
        },
      },
    );

    expect(trackedEvents).toEqual([{ event: 'cc_dose_given', props: { status: 'given' } }]);

    // 2. When a pending dose transitions to 'missed' via Realtime, cc_dose_missed fires once with { missedCount: 1 }
    const initialSnapshot = {
      ...buildSnapshotFromMocks(CARECIRCLE_MOCKS, 'owner'),
      userId: HELPER_ID,
    };
    await saveCachedTodaySnapshot(initialSnapshot, memoryTodayStorage);

    const fakeRealtime = createFakeRealtimeClient();
    const unsubscribe = subscribeToCircleDoseEvents({
      circleId: CIRCLE_ID,
      getClient: () => fakeRealtime.client,
      storage: memoryTodayStorage,
      userId: HELPER_ID,
      trackDoseMissed: (missedCount) => {
        const validated = validateAnalyticsEvent('cc_dose_missed', { missedCount });
        trackedEvents.push({ event: 'cc_dose_missed', props: validated });
      },
    });

    const missedRow: DoseEventRow = {
      id: PENDING_DOSE_ID,
      medication_id: MED_ID,
      circle_id: CIRCLE_ID,
      due_at: '2026-11-15T20:00:00.000Z',
      status: 'missed',
      acted_by: null,
      acted_at: null,
    };
    fakeRealtime.emitUpdate(missedRow, { status: 'pending' });

    // Wait for async cache read/write inside the listener if needed
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(trackedEvents).toEqual([
      { event: 'cc_dose_given', props: { status: 'given' } },
      { event: 'cc_dose_missed', props: { missedCount: 1 } },
    ]);

    // Emitting the same 'missed' row a second time does not fire cc_dose_missed again
    fakeRealtime.emitUpdate(missedRow, { status: 'missed' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(trackedEvents).toHaveLength(2);

    const serialized = JSON.stringify(trackedEvents);
    expect(serialized).not.toContain('Metformin');
    expect(serialized).not.toContain('500 mg');
    expect(serialized).not.toContain('1 tablet');

    unsubscribe();
  });
});
