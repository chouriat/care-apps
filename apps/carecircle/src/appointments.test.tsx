import {
  computeUtcTriggerForLocalTime,
  type LocalNotificationAdapter,
  type LocalNotificationRequest,
} from '@carecircle/core';
import * as UI from '@carecircle/ui';
import { Stack } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import TabsLayout from '../app/(tabs)/_layout';
import CalendarScreen from '../app/(tabs)/calendar';
import MedsScreen from '../app/(tabs)/meds';
import TodayScreen from '../app/(tabs)/today';
import en from '../i18n/en.json';
import { syncAppointmentReminders, type CalendarDeps } from './features/calendar';
import { memoryTodayStorage, resetTodayState } from './features/today/api';
import type {
  PostgresChangesFilter,
  PostgresChangesPayload,
  RealtimeChannelLike,
} from './features/today/realtime';

const CIRCLE_ID = 'c1c00001-0000-4000-8000-000000000001';
const OWNER_ID = 'c1000001-0000-4000-8000-00000000000a';
const HELPER_ID = 'c1000001-0000-4000-8000-00000000000c';
const VIEWER_ID = 'c1000001-0000-4000-8000-00000000000b';
const NOW = new Date('2026-11-15T12:00:00.000Z');

type Row = Record<string, unknown>;

function seedTables(timezone = 'Europe/Paris'): Record<string, Row[]> {
  return {
    circles: [
      {
        id: CIRCLE_ID,
        name: 'Family Care',
        care_recipient_name: 'Evelyn',
        care_recipient_dob: null,
        timezone,
        created_by: OWNER_ID,
        created_at: '2026-11-01T12:00:00.000Z',
      },
    ],
    circle_members: [
      { circle_id: CIRCLE_ID, user_id: OWNER_ID, role: 'owner', joined_at: '2026-11-01T12:00:00Z' },
      {
        circle_id: CIRCLE_ID,
        user_id: HELPER_ID,
        role: 'helper',
        joined_at: '2026-11-02T12:00:00Z',
      },
      {
        circle_id: CIRCLE_ID,
        user_id: VIEWER_ID,
        role: 'viewer',
        joined_at: '2026-11-03T12:00:00Z',
      },
    ],
    medications: [],
    dose_events: [],
    appointments: [],
    tasks: [],
  };
}

function createFakeNotificationRecorder() {
  const scheduled: LocalNotificationRequest[] = [];
  const cancelled: string[] = [];
  const activeById = new Map<string, LocalNotificationRequest>();

  const adapter: LocalNotificationAdapter = {
    async scheduleNotificationAsync(req) {
      scheduled.push(req);
      const id = req.identifier ?? `notif-${scheduled.length}`;
      activeById.set(id, req);
      return id;
    },
    async cancelScheduledNotificationAsync(identifier) {
      cancelled.push(identifier);
      activeById.delete(identifier);
    },
  };

  return { adapter, scheduled, cancelled, activeById };
}

function createFakeCalendarClient(opts: {
  tables: Record<string, Row[]>;
  isOnline?: () => boolean;
}) {
  let seq = 1;
  const isOnline = opts.isOnline ?? (() => true);
  const channelEvents: Array<{
    name: string;
    filter: PostgresChangesFilter | null;
    callback: ((payload: PostgresChangesPayload) => void) | null;
    subscribed: boolean;
    unsubscribed: boolean;
    removed: boolean;
  }> = [];

  function from(table: string) {
    const filters: Array<[op: 'eq' | 'gte' | 'lte', col: string, val: unknown]> = [];
    let pendingOp: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let pendingValues: Row | null = null;
    let limitN: number | null = null;

    const run = () => {
      if (!isOnline()) {
        return { data: null, error: { message: 'TypeError: Network request failed' } };
      }

      if (pendingOp === 'insert' && pendingValues) {
        const id = `c1400099-0000-4000-8000-${String(seq++).padStart(12, '0')}`;
        const created: Row = {
          id,
          circle_id: pendingValues.circle_id,
          title: pendingValues.title,
          starts_at: pendingValues.starts_at,
          ends_at: pendingValues.ends_at ?? null,
          location: pendingValues.location ?? null,
          driver_user_id: pendingValues.driver_user_id ?? null,
          notes: pendingValues.notes ?? null,
        };
        const rows = opts.tables[table] ?? [];
        rows.push(created);
        opts.tables[table] = rows;
        return { data: [created], error: null };
      }

      if (pendingOp === 'update' && pendingValues) {
        const updated: Row[] = [];
        opts.tables[table] = (opts.tables[table] ?? []).map((row) => {
          const match = filters.every(([op, col, val]) => (op === 'eq' ? row[col] === val : true));
          if (!match) return row;
          const next = { ...row, ...pendingValues };
          updated.push(next);
          return next;
        });
        return { data: updated, error: null };
      }

      if (pendingOp === 'delete') {
        opts.tables[table] = (opts.tables[table] ?? []).filter(
          (row) => !filters.every(([op, col, val]) => (op === 'eq' ? row[col] === val : true)),
        );
        return { data: [], error: null };
      }

      let rows = [...(opts.tables[table] ?? [])];
      for (const [op, col, val] of filters) {
        rows = rows.filter((r) => {
          if (op === 'eq') return r[col] === val;
          const a = new Date(String(r[col])).getTime();
          const b = new Date(String(val)).getTime();
          return op === 'gte' ? a >= b : a <= b;
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    };

    const builder = {
      select: () => builder,
      insert: (v: Row) => {
        pendingOp = 'insert';
        pendingValues = v;
        return builder;
      },
      update: (v: Row) => {
        pendingOp = 'update';
        pendingValues = v;
        return builder;
      },
      delete: () => {
        pendingOp = 'delete';
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push(['eq', col, val]);
        return builder;
      },
      gte: (col: string, val: unknown) => {
        filters.push(['gte', col, val]);
        return builder;
      },
      lte: (col: string, val: unknown) => {
        filters.push(['lte', col, val]);
        return builder;
      },
      order: () => builder,
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      then: <T,>(resolve: (val: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) => {
        try {
          return Promise.resolve(resolve(run()));
        } catch (e) {
          return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
        }
      },
    };
    return builder;
  }

  function channel(name: string): RealtimeChannelLike {
    const record = {
      name,
      filter: null as PostgresChangesFilter | null,
      callback: null as ((payload: PostgresChangesPayload) => void) | null,
      subscribed: false,
      unsubscribed: false,
      removed: false,
    };
    channelEvents.push(record);

    const ch: RealtimeChannelLike = {
      on: (_type, filter, cb) => {
        record.filter = filter;
        record.callback = cb;
        return ch;
      },
      subscribe: () => {
        record.subscribed = true;
        return ch;
      },
      unsubscribe: () => {
        record.unsubscribed = true;
      },
    };
    return ch;
  }

  return {
    client: {
      from,
      rpc: async () => ({ data: null, error: null }),
      channel,
      removeChannel: () => {
        const last = channelEvents[channelEvents.length - 1];
        if (last) last.removed = true;
      },
    } as never,
    channelEvents,
  };
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <UI.ThemeProvider>{children}</UI.ThemeProvider>
);

async function press(testID: string) {
  await fireEvent.press(within(screen.getByTestId(testID)).getByRole('button'));
}

beforeEach(() => {
  resetTodayState();
  delete process.env.MOCKS;
  delete process.env.EXPO_PUBLIC_MOCKS;
});

describe('CC-6a Appointments and calendar', () => {
  it('schedules local notifications at exactly 24h and 2h before starts_at across a DST change, never schedules in the past, and includes only the title', async () => {
    const rec = createFakeNotificationRecorder();

    // Europe/Paris springs forward on 2026-03-29 at 02:00 CET -> 03:00 CEST.
    // An appointment at 2026-03-29 03:30 local time (CEST, UTC+2) is 2026-03-29T01:30:00.000Z.
    const dstStart = computeUtcTriggerForLocalTime({
      date: '2026-03-29',
      time: '03:30',
      timeZone: 'Europe/Paris',
    });
    expect(dstStart.triggerAtIso).toBe('2026-03-29T01:30:00.000Z');

    const apptId = 'c1400001-0000-4000-8000-000000000001';
    const twoDaysBefore = new Date('2026-03-27T00:00:00.000Z');

    const scheduled = await syncAppointmentReminders(
      {
        id: apptId,
        circleId: CIRCLE_ID,
        title: 'Cardiology check-up',
        startsAt: dstStart.triggerAtIso,
      },
      { adapter: rec.adapter, now: twoDaysBefore },
    );

    expect(scheduled).toHaveLength(2);
    // 24 hours before 2026-03-29T01:30:00.000Z is 2026-03-28T01:30:00.000Z (exact 24 * 3600s)
    expect(scheduled[0]?.triggerAtIso).toBe('2026-03-28T01:30:00.000Z');
    expect(dstStart.triggerAtMs - scheduled[0]!.triggerAtMs).toBe(24 * 3_600_000);
    // 2 hours before 2026-03-29T01:30:00.000Z across the DST gap is 2026-03-28T23:30:00.000Z (exact 2 * 3600s)
    expect(scheduled[1]?.triggerAtIso).toBe('2026-03-28T23:30:00.000Z');
    expect(dstStart.triggerAtMs - scheduled[1]!.triggerAtMs).toBe(2 * 3_600_000);

    // Notification copy has only "Appointment tomorrow" / "Appointment in 2 hours" and the title
    expect(rec.activeById.get(`appointment-24h:${apptId}`)).toMatchObject({
      title: 'Appointment tomorrow',
      body: 'Cardiology check-up',
    });
    expect(rec.activeById.get(`appointment-2h:${apptId}`)).toMatchObject({
      title: 'Appointment in 2 hours',
      body: 'Cardiology check-up',
    });

    // When now is 10 hours before startsAt, the 24h reminder is in the past and only the 2h reminder is scheduled
    const tenHoursBefore = new Date(dstStart.triggerAtMs - 10 * 3_600_000);
    const onlyTwoHours = await syncAppointmentReminders(
      {
        id: apptId,
        circleId: CIRCLE_ID,
        title: 'Cardiology check-up',
        startsAt: dstStart.triggerAtIso,
      },
      { adapter: rec.adapter, now: tenHoursBefore },
    );
    expect(onlyTwoHours).toHaveLength(1);
    expect(onlyTwoHours[0]?.triggerAtIso).toBe('2026-03-28T23:30:00.000Z');
    expect(rec.activeById.has(`appointment-24h:${apptId}`)).toBe(false);
    expect(rec.activeById.has(`appointment-2h:${apptId}`)).toBe(true);

    // When now is 1 hour before startsAt, both 24h and 2h are in the past -> none scheduled
    const oneHourBefore = new Date(dstStart.triggerAtMs - 1 * 3_600_000);
    const noneScheduled = await syncAppointmentReminders(
      {
        id: apptId,
        circleId: CIRCLE_ID,
        title: 'Cardiology check-up',
        startsAt: dstStart.triggerAtIso,
      },
      { adapter: rec.adapter, now: oneHourBefore },
    );
    expect(noneScheduled).toHaveLength(0);
    expect(rec.activeById.size).toBe(0);
  });

  it('adds, edits, and deletes an appointment through the real router, validates end after start, updates Today next appointment, and reschedules/cancels reminders', async () => {
    const tables = seedTables('Europe/Paris');
    const fake = createFakeCalendarClient({ tables });
    const notif = createFakeNotificationRecorder();

    const deps: CalendarDeps = {
      getClient: () => fake.client,
      getUserId: async () => OWNER_ID,
      storage: memoryTodayStorage,
      now: () => NOW,
      notificationAdapter: notif.adapter,
    };

    const routes = {
      _layout: () => <Stack screenOptions={{ headerShown: false }} />,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/today': () => <TodayScreen deps={deps} referenceNow={NOW} />,
      '(tabs)/meds': () => <MedsScreen deps={deps} />,
      '(tabs)/calendar': () => <CalendarScreen deps={deps} referenceNow={NOW} />,
    };

    await renderRouter(routes, { initialUrl: '/calendar', wrapper });
    await waitFor(() => expect(screen.getByTestId('calendar-empty-state')).toBeTruthy());

    // Open Add form
    await press('calendar-add-button');
    await waitFor(() => expect(screen.getByTestId('calendar-form')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('calendar-title-input'), 'Cardiology check-up');
    await fireEvent.changeText(screen.getByTestId('calendar-start-date-input'), '2026-11-18');
    await fireEvent.changeText(screen.getByTestId('calendar-start-time-input'), '15:00');
    // End before start -> shows field error and writes nothing
    await fireEvent.changeText(screen.getByTestId('calendar-end-date-input'), '2026-11-18');
    await fireEvent.changeText(screen.getByTestId('calendar-end-time-input'), '14:00');
    await press('calendar-save-button');

    expect(screen.getByTestId('calendar-end-before-start-error')).toHaveTextContent(
      en.calendar.endBeforeStartError,
    );
    expect(tables.appointments).toHaveLength(0);

    // Fix end time to 16:00, pick helper as driver, and save
    await fireEvent.changeText(screen.getByTestId('calendar-end-time-input'), '16:00');
    await fireEvent.changeText(screen.getByTestId('calendar-location-input'), 'City Heart Clinic');
    await fireEvent.changeText(
      screen.getByTestId('calendar-notes-input'),
      'Bring blood pressure log',
    );
    await press(`calendar-driver-option-${HELPER_ID}`);
    await press('calendar-save-button');

    await waitFor(() => expect(screen.getByText('Cardiology check-up')).toBeTruthy());
    expect(tables.appointments).toHaveLength(1);
    const createdId = String(tables.appointments![0]!.id);

    // Dot appears on 2026-11-18 in the month grid, and local time in Europe/Paris (15:00 – 16:00) is shown
    expect(screen.getByTestId('calendar-dot-2026-11-18')).toBeTruthy();
    expect(screen.getByTestId(`calendar-item-time-${createdId}`)).toHaveTextContent(
      '2026-11-18 · 15:00 – 16:00',
    );
    expect(screen.getByTestId(`calendar-item-driver-${createdId}`)).toHaveTextContent(/Helper/);

    // 24h and 2h reminders scheduled for the new appointment
    expect(notif.activeById.has(`appointment-24h:${createdId}`)).toBe(true);
    expect(notif.activeById.has(`appointment-2h:${createdId}`)).toBe(true);

    // Edit appointment title and start time
    await press(`calendar-edit-${createdId}`);
    await waitFor(() => expect(screen.getByTestId('calendar-form')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('calendar-title-input'), 'Cardiology follow-up');
    await fireEvent.changeText(screen.getByTestId('calendar-start-time-input'), '15:30');
    await press('calendar-save-button');

    await waitFor(() => expect(screen.getByText('Cardiology follow-up')).toBeTruthy());
    expect(screen.getByTestId(`calendar-item-time-${createdId}`)).toHaveTextContent(
      '2026-11-18 · 15:30 – 16:00',
    );
    expect(notif.activeById.get(`appointment-2h:${createdId}`)?.body).toBe('Cardiology follow-up');

    // Switch to Today tab -> Today's "next appointment" card shows the real updated appointment
    await fireEvent.press(screen.getByTestId('tab-today'));
    await waitFor(() => expect(screen.getByTestId('today-next-appointment')).toBeTruthy());
    expect(
      within(screen.getByTestId('today-next-appointment')).getByText('Cardiology follow-up'),
    ).toBeTruthy();

    // Switch back to Calendar tab and delete with confirmation
    await fireEvent.press(screen.getByTestId('tab-calendar'));
    await waitFor(() => expect(screen.getByTestId(`calendar-delete-${createdId}`)).toBeTruthy());
    await press(`calendar-delete-${createdId}`);

    // Not deleted until confirmed
    expect(screen.getByTestId(`calendar-confirm-delete-${createdId}`)).toBeTruthy();
    expect(tables.appointments).toHaveLength(1);

    await press(`calendar-confirm-delete-${createdId}`);
    await waitFor(() => expect(screen.getByTestId('calendar-empty-state')).toBeTruthy());
    expect(tables.appointments).toHaveLength(0);
    expect(notif.activeById.size).toBe(0);
  });

  it('viewer sees no Add, Edit, or Delete buttons, and realtime channel is subscribed and removed on unmount', async () => {
    const tables = seedTables('Europe/Paris');
    tables.appointments!.push({
      id: 'c1400001-0000-4000-8000-000000000001',
      circle_id: CIRCLE_ID,
      title: 'Ophthalmology exam',
      starts_at: '2026-11-20T10:00:00.000Z',
      ends_at: null,
      location: 'Eye Clinic',
      driver_user_id: null,
      notes: null,
    });
    const fake = createFakeCalendarClient({ tables });
    const notif = createFakeNotificationRecorder();

    const deps: CalendarDeps = {
      getClient: () => fake.client,
      getUserId: async () => VIEWER_ID,
      storage: memoryTodayStorage,
      now: () => NOW,
      notificationAdapter: notif.adapter,
    };

    const routes = {
      _layout: () => <Stack screenOptions={{ headerShown: false }} />,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/today': () => <TodayScreen deps={deps} referenceNow={NOW} />,
      '(tabs)/meds': () => <MedsScreen deps={deps} />,
      '(tabs)/calendar': () => <CalendarScreen deps={deps} referenceNow={NOW} />,
    };

    const view = await renderRouter(routes, { initialUrl: '/calendar', wrapper });
    await waitFor(() => expect(screen.getByText('Ophthalmology exam')).toBeTruthy());

    // Viewer sees no Add, Edit, or Delete controls
    expect(screen.queryByTestId('calendar-add-button')).toBeNull();
    expect(screen.queryByTestId('calendar-edit-c1400001-0000-4000-8000-000000000001')).toBeNull();
    expect(screen.queryByTestId('calendar-delete-c1400001-0000-4000-8000-000000000001')).toBeNull();

    // Realtime channel subscribed with circle_id filter
    expect(fake.channelEvents).toHaveLength(1);
    expect(fake.channelEvents[0]?.filter).toEqual({
      event: '*',
      schema: 'public',
      table: 'appointments',
      filter: `circle_id=eq.${CIRCLE_ID}`,
    });

    // Simulate a realtime INSERT from another carer's phone
    const newApptId = 'c1400001-0000-4000-8000-000000000002';
    await act(async () => {
      fake.channelEvents[0]?.callback?.({
        eventType: 'INSERT',
        new: {
          id: newApptId,
          circle_id: CIRCLE_ID,
          title: 'Dental cleaning',
          starts_at: '2026-11-22T09:00:00.000Z',
          ends_at: null,
          location: null,
          driver_user_id: null,
          notes: null,
        },
      });
    });

    await waitFor(() => expect(screen.getByText('Dental cleaning')).toBeTruthy());
    expect(notif.activeById.has(`appointment-24h:${newApptId}`)).toBe(true);

    // Unmount removes the realtime channel
    await act(async () => {
      view.unmount();
    });
    expect(fake.channelEvents[0]?.unsubscribed).toBe(true);
    expect(fake.channelEvents[0]?.removed).toBe(true);
  });
});
