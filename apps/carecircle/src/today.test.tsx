import * as Core from '@carecircle/core';
import * as UI from '@carecircle/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import TodayScreen from '../app/(tabs)/today';
import en from '../i18n/en.json';
import {
  DEFAULT_MOCK_NOW_ISO,
  checkOffDose,
  flushQueuedDoseCheckOffs,
  loadCachedTodaySnapshot,
  loadQueuedDoseCheckOffs,
  loadTodaySnapshot,
  memoryTodayStorage,
  resetTodayState,
  selectTodayAgenda,
  type TodayDeps,
  type TodaySnapshot,
} from './features/today/api';
import { TodayScreenView } from './features/today/components';
import { createFakeTodayClient } from './__fixtures__/today-fake-client';

describe('CC-3a Today screen (doses grouped by time, Given/Skip, next appointment, tasks due today, offline cache & queue)', () => {
  const originalMocks = process.env.MOCKS;
  const originalExpoPublicMocks = process.env.EXPO_PUBLIC_MOCKS;

  beforeEach(() => {
    resetTodayState();
    delete process.env.MOCKS;
    delete process.env.EXPO_PUBLIC_MOCKS;
  });

  afterAll(() => {
    if (originalMocks === undefined) delete process.env.MOCKS;
    else process.env.MOCKS = originalMocks;
    if (originalExpoPublicMocks === undefined) delete process.env.EXPO_PUBLIC_MOCKS;
    else process.env.EXPO_PUBLIC_MOCKS = originalExpoPublicMocks;
  });

  it('renders loading, empty (with testID="today-empty-state"), error, and offline states', async () => {
    const onRetry = jest.fn();

    const { rerender } = await render(
      <UI.ThemeProvider>
        <TodayScreenView isLoading />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('today-loading')).toBeTruthy();
    expect(screen.getByText(en.today.loading)).toBeTruthy();

    await rerender(
      <UI.ThemeProvider>
        <TodayScreenView
          agenda={{
            localDate: '2026-11-15',
            timezone: 'Europe/Paris',
            memberRole: 'owner',
            doseGroups: [],
            nextAppointment: null,
            tasksDueToday: [],
            isEmpty: true,
          }}
        />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('today-empty-state')).toBeTruthy();
    expect(screen.getByText(en.today.emptyTitle)).toBeTruthy();
    expect(screen.getByText(en.today.emptyMessage)).toBeTruthy();

    await rerender(
      <UI.ThemeProvider>
        <TodayScreenView hasError onRetry={onRetry} />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('today-error')).toBeTruthy();
    expect(screen.getByText(en.today.errorTitle)).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('today-error')).getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);

    onRetry.mockClear();
    await rerender(
      <UI.ThemeProvider>
        <TodayScreenView isOffline onRetry={onRetry} />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('today-offline')).toBeTruthy();
    expect(screen.getByText(en.today.offlineTitle)).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('today-offline')).getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('groups doses due today by local time in circle.timezone, picks the earliest upcoming appointment, and filters open tasks due today', () => {
    const circleId = 'c1c00001-0000-4000-8000-000000000001';
    const medA = 'c1200001-0000-4000-8000-000000000001';
    const medB = 'c1200001-0000-4000-8000-000000000002';
    const medInactive = 'c1200001-0000-4000-8000-000000000003';

    // Circle in America/Los_Angeles (UTC-8 in Nov).
    // Local date on 2026-11-15T18:00:00Z is 2026-11-15 (10:00 PST).
    // A dose at 2026-11-16T04:00:00Z is 2026-11-15 20:00 PST (still today in LA!).
    // A dose at 2026-11-15T05:00:00Z is 2026-11-14 21:00 PST (yesterday in LA!).
    const snapshot: TodaySnapshot = {
      circle: {
        id: circleId,
        name: 'West Coast Circle',
        careRecipientName: 'Evelyn',
        careRecipientDob: null,
        timezone: 'America/Los_Angeles',
        createdBy: null,
        createdAt: '2026-11-01T00:00:00.000Z',
      },
      memberRole: 'owner',
      medications: [
        {
          id: medA,
          circleId,
          name: 'Metformin',
          strength: '500 mg',
          doseText: '1 tablet',
          schedule: { kind: 'daily', times: ['08:00', '20:00'] },
          instructions: 'Take with food',
          startDate: '2026-11-01',
          endDate: null,
          active: true,
          source: 'manual',
        },
        {
          id: medB,
          circleId,
          name: 'Aspirin',
          strength: '81 mg',
          doseText: '1 tablet',
          schedule: { kind: 'daily', times: ['08:00'] },
          instructions: null,
          startDate: '2026-11-01',
          endDate: null,
          active: true,
          source: 'manual',
        },
        {
          id: medInactive,
          circleId,
          name: 'Paused Med',
          strength: null,
          doseText: '1 capsule',
          schedule: { kind: 'daily', times: ['12:00'] },
          instructions: null,
          startDate: '2026-11-01',
          endDate: null,
          active: false,
          source: 'manual',
        },
      ],
      doseEvents: [
        // 20:00 PST today (listed first to verify chronological sorting puts 08:00 before 20:00)
        {
          id: 'c1300001-0000-4000-8000-000000000003',
          medicationId: medA,
          circleId,
          dueAt: '2026-11-16T04:00:00.000Z',
          status: 'pending',
          actedBy: null,
          actedAt: null,
        },
        // 08:00 PST today (Metformin)
        {
          id: 'c1300001-0000-4000-8000-000000000001',
          medicationId: medA,
          circleId,
          dueAt: '2026-11-15T16:00:00.000Z',
          status: 'given',
          actedBy: null,
          actedAt: '2026-11-15T16:05:00.000Z',
        },
        // 08:00 PST today (Aspirin - same time bucket as Metformin)
        {
          id: 'c1300001-0000-4000-8000-000000000002',
          medicationId: medB,
          circleId,
          dueAt: '2026-11-15T16:00:00.000Z',
          status: 'pending',
          actedBy: null,
          actedAt: null,
        },
        // Yesterday in LA (2026-11-14 21:00 PST) -> must be excluded
        {
          id: 'c1300001-0000-4000-8000-000000000004',
          medicationId: medA,
          circleId,
          dueAt: '2026-11-15T05:00:00.000Z',
          status: 'given',
          actedBy: null,
          actedAt: '2026-11-15T05:05:00.000Z',
        },
        // Inactive medication dose -> must be excluded
        {
          id: 'c1300001-0000-4000-8000-000000000005',
          medicationId: medInactive,
          circleId,
          dueAt: '2026-11-15T20:00:00.000Z',
          status: 'pending',
          actedBy: null,
          actedAt: null,
        },
      ],
      appointments: [
        // Past appointment (before now) -> excluded
        {
          id: 'c1400001-0000-4000-8000-000000000010',
          circleId,
          title: 'Past dental visit',
          startsAt: '2026-11-14T18:00:00.000Z',
          endsAt: null,
          location: null,
          driverUserId: null,
          notes: null,
        },
        // Later future appointment
        {
          id: 'c1400001-0000-4000-8000-000000000012',
          circleId,
          title: 'Later neurology visit',
          startsAt: '2026-11-20T18:00:00.000Z',
          endsAt: null,
          location: null,
          driverUserId: null,
          notes: null,
        },
        // Earliest upcoming appointment -> must be chosen as nextAppointment
        {
          id: 'c1400001-0000-4000-8000-000000000011',
          circleId,
          title: 'Cardiology check-up',
          startsAt: '2026-11-16T18:00:00.000Z',
          endsAt: null,
          location: 'City Heart Clinic',
          driverUserId: null,
          notes: null,
        },
      ],
      tasks: [
        // Open task due today in LA (2026-11-15 17:00 PST = 2026-11-16T01:00:00Z)
        {
          id: 'c1500001-0000-4000-8000-000000000011',
          circleId,
          title: 'Pick up evening prescription',
          dueAt: '2026-11-16T01:00:00.000Z',
          assignee: null,
          doneAt: null,
          doneBy: null,
          source: 'manual',
        },
        // Completed task due today -> excluded because doneAt is not null
        {
          id: 'c1500001-0000-4000-8000-000000000012',
          circleId,
          title: 'Completed morning task',
          dueAt: '2026-11-15T17:00:00.000Z',
          assignee: null,
          doneAt: '2026-11-15T17:10:00.000Z',
          doneBy: null,
          source: 'manual',
        },
        // Open task due tomorrow -> excluded
        {
          id: 'c1500001-0000-4000-8000-000000000013',
          circleId,
          title: 'Tomorrow task',
          dueAt: '2026-11-16T20:00:00.000Z',
          assignee: null,
          doneAt: null,
          doneBy: null,
          source: 'manual',
        },
      ],
      fetchedAt: '2026-11-15T18:00:00.000Z',
    };

    const agenda = selectTodayAgenda(snapshot, new Date('2026-11-15T18:00:00.000Z'));

    expect(agenda.localDate).toBe('2026-11-15');
    expect(agenda.doseGroups.map((g) => g.time)).toEqual(['08:00', '20:00']);
    expect(agenda.doseGroups[0]?.doses.map((d) => d.medicationName)).toEqual([
      'Aspirin',
      'Metformin',
    ]);
    expect(agenda.doseGroups[1]?.doses.map((d) => d.medicationName)).toEqual(['Metformin']);
    expect(agenda.nextAppointment?.title).toBe('Cardiology check-up');
    expect(agenda.tasksDueToday.map((t) => t.title)).toEqual(['Pick up evening prescription']);
  });

  it('checks off a pending dose (Given and Skip) on MOCKS=1 and fires cc_dose_given without sensitive text', async () => {
    process.env.MOCKS = '1';
    const trackedEvents: Array<{ event: string; props: Record<string, unknown> }> = [];
    const deps: TodayDeps = {
      env: { MOCKS: '1' },
      storage: memoryTodayStorage,
      now: () => new Date(DEFAULT_MOCK_NOW_ISO),
      trackDoseAction: (status) => {
        const props = Core.validateAnalyticsEvent('cc_dose_given', { status });
        trackedEvents.push({ event: 'cc_dose_given', props });
      },
    };

    await render(
      <UI.ThemeProvider>
        <TodayScreen deps={deps} referenceNow={new Date(DEFAULT_MOCK_NOW_ISO)} />
      </UI.ThemeProvider>,
    );

    expect(screen.getByTestId('today-screen')).toBeTruthy();
    expect(screen.getByTestId('today-dose-group-08:00')).toBeTruthy();
    expect(screen.getByTestId('today-dose-group-20:00')).toBeTruthy();
    expect(screen.getByTestId('today-next-appointment')).toBeTruthy();
    expect(screen.getByText('Cardiology check-up')).toBeTruthy();
    expect(screen.getByText('Pick up Metformin refill')).toBeTruthy();

    // 08:00 dose (id ...0013) is already 'given', so it has no Given/Skip buttons.
    const morningDoseId = 'c1300001-0000-4000-8000-000000000013';
    const eveningDoseId = 'c1300001-0000-4000-8000-000000000014';
    expect(screen.queryByTestId(`today-dose-given-${morningDoseId}`)).toBeNull();

    // 20:00 dose (id ...0014) is 'pending' and shows Given and Skip buttons.
    const givenBtnWrapper = screen.getByTestId(`today-dose-given-${eveningDoseId}`);
    expect(screen.getByTestId(`today-dose-skip-${eveningDoseId}`)).toBeTruthy();

    await fireEvent.press(within(givenBtnWrapper).getByRole('button'));

    await waitFor(() => {
      expect(screen.queryByTestId(`today-dose-given-${eveningDoseId}`)).toBeNull();
    });
    expect(
      within(screen.getByTestId(`today-dose-status-${eveningDoseId}`)).getByText(
        en.today.statusGiven,
      ),
    ).toBeTruthy();

    expect(trackedEvents).toEqual([{ event: 'cc_dose_given', props: { status: 'given' } }]);
    expect(JSON.stringify(trackedEvents)).not.toContain('Metformin');
  });

  it('hides Given and Skip buttons for a viewer and refuses viewer check-offs in checkOffDose', async () => {
    const pendingDoseId = 'c1300001-0000-4000-8000-000000000014';

    await render(
      <UI.ThemeProvider>
        <TodayScreenView
          agenda={{
            localDate: '2026-11-15',
            timezone: 'Europe/London',
            memberRole: 'viewer',
            doseGroups: [
              {
                time: '20:00',
                doses: [
                  {
                    id: pendingDoseId,
                    medicationId: 'c1200001-0000-4000-8000-000000000001',
                    medicationName: 'Metformin',
                    strength: '500 mg',
                    doseText: '1 tablet',
                    instructions: null,
                    dueAt: '2026-11-15T20:00:00.000Z',
                    localTime: '20:00',
                    status: 'pending',
                    actedBy: null,
                    actedAt: null,
                  },
                ],
              },
            ],
            nextAppointment: null,
            tasksDueToday: [],
            isEmpty: false,
          }}
        />
      </UI.ThemeProvider>,
    );

    expect(screen.getByTestId(`today-dose-row-${pendingDoseId}`)).toBeTruthy();
    expect(screen.queryByTestId(`today-dose-given-${pendingDoseId}`)).toBeNull();
    expect(screen.queryByTestId(`today-dose-skip-${pendingDoseId}`)).toBeNull();

    const res = await checkOffDose({
      doseEventId: pendingDoseId,
      status: 'given',
      memberRole: 'viewer',
    });
    expect(res).toEqual({ ok: false, errorCode: 'FORBIDDEN_ROLE' });
  });

  it('serves cached Today data when offline, queues Given/Skip check-offs while offline, and sends them in order when the network returns', async () => {
    const circleId = 'c1c00001-0000-4000-8000-000000000001';
    const medId = 'c1200001-0000-4000-8000-000000000001';
    const doseMorningId = 'c1300001-0000-4000-8000-000000000021';
    const doseEveningId = 'c1300001-0000-4000-8000-000000000022';

    let networkOnline = true;
    const trackedStatuses: string[] = [];
    const helperUserId = 'c1000001-1111-4111-8111-111111111111';

    const fake = createFakeTodayClient({
      isOnline: () => networkOnline,
      tables: {
        circles: [
          {
            id: circleId,
            name: 'Offline Test Circle',
            care_recipient_name: 'Evelyn',
            care_recipient_dob: null,
            timezone: 'Europe/London',
            created_by: null,
            created_at: '2026-11-01T12:00:00.000Z',
          },
        ],
        circle_members: [
          {
            circle_id: circleId,
            user_id: helperUserId,
            role: 'helper',
            joined_at: '2026-11-01T12:00:00.000Z',
          },
        ],
        medications: [
          {
            id: medId,
            circle_id: circleId,
            name: 'Metformin',
            strength: '500 mg',
            dose_text: '1 tablet',
            schedule: { kind: 'daily', times: ['08:00', '20:00'] },
            instructions: 'Take with food',
            start_date: '2026-11-01',
            end_date: null,
            active: true,
            source: 'manual',
          },
        ],
        dose_events: [
          {
            id: doseMorningId,
            medication_id: medId,
            circle_id: circleId,
            due_at: '2026-11-15T08:00:00.000Z',
            status: 'pending',
            acted_by: null,
            acted_at: null,
          },
          {
            id: doseEveningId,
            medication_id: medId,
            circle_id: circleId,
            due_at: '2026-11-15T20:00:00.000Z',
            status: 'pending',
            acted_by: null,
            acted_at: null,
          },
        ],
      },
    });
    const rpcCalls = fake.rpcCalls;
    const fakeClient = fake.client;

    const getDeps = (): TodayDeps => ({
      getClient: () => fakeClient,
      getUserId: async () => helperUserId,
      storage: memoryTodayStorage,
      now: () => new Date('2026-11-15T12:00:00.000Z'),
      trackDoseAction: (status) => {
        trackedStatuses.push(status);
      },
    });

    // 1. Initial online load caches the snapshot.
    const onlineLoad = await loadTodaySnapshot(getDeps());
    expect(onlineLoad).toMatchObject({ ok: true, fromCache: false, isOffline: false });

    // 2. Network drops. Loading Today falls back to the cached snapshot (`fromCache: true, isOffline: true`).
    networkOnline = false;
    const offlineLoad = await loadTodaySnapshot(getDeps());
    expect(offlineLoad).toMatchObject({ ok: true, fromCache: true, isOffline: true });
    expect(offlineLoad.ok && offlineLoad.snapshot.doseEvents).toHaveLength(2);

    // 3. While offline, caregiver marks morning dose Given and evening dose Skipped.
    const check1 = await checkOffDose(
      { doseEventId: doseMorningId, status: 'given', memberRole: 'helper' },
      getDeps(),
    );
    const check2 = await checkOffDose(
      { doseEventId: doseEveningId, status: 'skipped', memberRole: 'helper' },
      getDeps(),
    );

    expect(check1).toEqual({
      ok: true,
      doseEventId: doseMorningId,
      status: 'given',
      queued: true,
      queuedCount: 1,
    });
    expect(check2).toEqual({
      ok: true,
      doseEventId: doseEveningId,
      status: 'skipped',
      queued: true,
      queuedCount: 2,
    });

    // No server RPC succeeded while offline, and both actions are persisted in the queue and cache.
    expect(rpcCalls).toHaveLength(0);
    expect(await loadQueuedDoseCheckOffs(memoryTodayStorage)).toHaveLength(2);

    const cachedWhileOffline = await loadCachedTodaySnapshot(memoryTodayStorage);
    expect(cachedWhileOffline?.doseEvents.find((d) => d.id === doseMorningId)?.status).toBe(
      'given',
    );
    expect(cachedWhileOffline?.doseEvents.find((d) => d.id === doseEveningId)?.status).toBe(
      'skipped',
    );

    // Render TodayScreenView with the offline cached agenda to verify the offline banner and queued count.
    const offlineAgenda = selectTodayAgenda(
      cachedWhileOffline!,
      new Date('2026-11-15T12:00:00.000Z'),
    );
    await render(
      <UI.ThemeProvider>
        <TodayScreenView agenda={offlineAgenda} isOffline queuedCount={2} />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('today-offline-banner')).toBeTruthy();
    expect(screen.getByTestId('today-queued-count')).toBeTruthy();
    expect(
      within(screen.getByTestId(`today-dose-status-${doseMorningId}`)).getByText(
        en.today.statusGiven,
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId(`today-dose-status-${doseEveningId}`)).getByText(
        en.today.statusSkipped,
      ),
    ).toBeTruthy();

    // 4. Network returns: flushing sends both queued check-offs in FIFO order and clears the queue.
    networkOnline = true;
    const flushRes = await flushQueuedDoseCheckOffs(getDeps());
    expect(flushRes).toEqual({
      ok: true,
      isOffline: false,
      flushedCount: 2,
      remainingCount: 0,
      refusedCount: 0,
    });

    expect(rpcCalls).toEqual([
      { fn: 'set_dose_status', args: { doseEventId: doseMorningId, status: 'given' } },
      { fn: 'set_dose_status', args: { doseEventId: doseEveningId, status: 'skipped' } },
    ]);
    expect(trackedStatuses).toEqual(['given', 'skipped']);
    expect(await loadQueuedDoseCheckOffs(memoryTodayStorage)).toHaveLength(0);
  });
});
