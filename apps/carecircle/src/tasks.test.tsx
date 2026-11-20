import * as UI from '@carecircle/ui';
import { Stack } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import TabsLayout from '../app/(tabs)/_layout';
import CalendarScreen from '../app/(tabs)/calendar';
import MedsScreen from '../app/(tabs)/meds';
import TasksScreen from '../app/(tabs)/tasks';
import TodayScreen from '../app/(tabs)/today';
import { memoryTodayStorage, resetTodayState } from './features/today/api';
import type { PostgresChangesPayload } from './features/today/realtime';
import type { TasksDeps } from './features/tasks';

const CIRCLE_ID = 'c1c00001-0000-4000-8000-000000000001';
const OWNER_ID = 'c1000001-0000-4000-8000-00000000000a';
const VIEWER_ID = 'c1000001-0000-4000-8000-00000000000b';
const HELPER_ID = 'c1000001-0000-4000-8000-00000000000c';
const NOW = new Date('2026-11-18T12:00:00.000Z');

type Row = Record<string, unknown>;

function seedTables(initialTasks: Row[] = []): Record<string, Row[]> {
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
    users_profile: [
      { user_id: OWNER_ID, display_name: 'Sarah Owner' },
      { user_id: VIEWER_ID, display_name: 'Victor Viewer' },
      { user_id: HELPER_ID, display_name: 'Hannah Helper' },
    ],
    medications: [],
    dose_events: [],
    appointments: [],
    tasks: initialTasks,
  };
}

function createFakeTasksClient(tables: Record<string, Row[]>) {
  let seq = 1;
  let tasksRealtimeCallback: ((payload: PostgresChangesPayload) => void) | null = null;
  const unsubscribeSpy = jest.fn(async () => 'ok');
  const removeChannelSpy = jest.fn(async () => 'ok');

  function from(table: string) {
    const filters: Array<[op: 'eq' | 'gte' | 'lte', col: string, val: unknown]> = [];
    let pendingOp: 'select' | 'insert' | 'update' = 'select';
    let pendingValues: Row | null = null;
    let limitN: number | null = null;

    const run = () => {
      if (pendingOp === 'insert' && pendingValues) {
        const id = `c1500099-0000-4000-8000-${String(seq++).padStart(12, '0')}`;
        const created: Row = {
          id,
          circle_id: pendingValues.circle_id,
          title: pendingValues.title,
          due_at: pendingValues.due_at ?? null,
          assignee: pendingValues.assignee ?? null,
          done_at: pendingValues.done_at ?? null,
          done_by: pendingValues.done_by ?? null,
          source: pendingValues.source ?? 'manual',
        };
        const rows = tables[table] ?? [];
        rows.push(created);
        tables[table] = rows;
        return { data: [created], error: null };
      }

      if (pendingOp === 'update' && pendingValues) {
        const updated: Row[] = [];
        tables[table] = (tables[table] ?? []).map((row) => {
          const match = filters.every(([op, col, val]) => (op === 'eq' ? row[col] === val : true));
          if (!match) return row;
          const next = { ...row, ...pendingValues };
          updated.push(next);
          return next;
        });
        return { data: updated, error: null };
      }

      let rows = [...(tables[table] ?? [])];
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

  const client = {
    from,
    rpc: async () => ({ data: null, error: null }),
    channel: jest.fn((topic: string) => {
      // Typed so TypeScript can follow `on` returning the channel itself (TS7022/TS7024 otherwise).
      type FakeChannel = {
        topic: string;
        on: (
          type: string,
          filter: { table?: string },
          cb: (payload: PostgresChangesPayload) => void,
        ) => FakeChannel;
        subscribe: () => FakeChannel;
        unsubscribe: typeof unsubscribeSpy;
      };
      const ch: FakeChannel = {
        topic,
        on: jest.fn(
          (
            _type: string,
            filter: { table?: string },
            cb: (payload: PostgresChangesPayload) => void,
          ): FakeChannel => {
            if (filter?.table === 'tasks') {
              tasksRealtimeCallback = cb;
            }
            return ch;
          },
        ),
        subscribe: jest.fn(() => ch),
        unsubscribe: unsubscribeSpy,
      };
      return ch;
    }),
    removeChannel: removeChannelSpy,
  };

  return {
    client,
    unsubscribeSpy,
    removeChannelSpy,
    emitTasksRealtime: (payload: PostgresChangesPayload) => {
      tasksRealtimeCallback?.(payload);
    },
  };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <UI.ThemeProvider>{children}</UI.ThemeProvider>
);

function setupRouter(userId: string, initialTasks: Row[] = []) {
  const tables = seedTables(initialTasks);
  const { client, unsubscribeSpy, removeChannelSpy, emitTasksRealtime } =
    createFakeTasksClient(tables);

  const deps: TasksDeps = {
    getClient: () => client as never,
    getUserId: async () => userId,
    storage: memoryTodayStorage,
    now: () => NOW,
  };

  const routes = {
    _layout: () => <Stack screenOptions={{ headerShown: false }} />,
    '(tabs)/_layout': TabsLayout,
    '(tabs)/today': () => <TodayScreen deps={deps} referenceNow={NOW} />,
    '(tabs)/meds': () => <MedsScreen deps={deps} />,
    '(tabs)/calendar': () => <CalendarScreen deps={deps} referenceNow={NOW} />,
    '(tabs)/tasks': () => <TasksScreen deps={deps} />,
  };

  return {
    tables,
    deps,
    routes,
    unsubscribeSpy,
    removeChannelSpy,
    emitTasksRealtime,
  };
}

beforeEach(() => {
  resetTodayState();
  delete process.env.MOCKS;
  delete process.env.EXPO_PUBLIC_MOCKS;
  jest.restoreAllMocks();
});

describe('CC-6b Shared tasks screen', () => {
  it('owner/helper can add, assign, complete, and un-complete a task through the real router and sync Today tasks due today', async () => {
    const { tables, routes } = setupRouter(HELPER_ID, []);
    await renderRouter(routes, { initialUrl: '/tasks', wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('tasks-empty-state')).toBeTruthy();
    });

    // Open Add task form
    await fireEvent.press(within(screen.getByTestId('tasks-add-button')).getByRole('button'));
    expect(screen.getByTestId('tasks-form')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('tasks-title-input'), 'Pick up insulin pens');
    await fireEvent.changeText(screen.getByTestId('tasks-due-date-input'), '2026-11-18');
    await fireEvent.changeText(screen.getByTestId('tasks-due-time-input'), '10:30');

    // Assign to Hannah Helper
    await fireEvent.press(
      within(screen.getByTestId(`tasks-assignee-option-${HELPER_ID}`)).getByRole('button'),
    );

    await fireEvent.press(within(screen.getByTestId('tasks-save-button')).getByRole('button'));

    await waitFor(() => {
      expect(screen.getByText('Pick up insulin pens')).toBeTruthy();
      expect(screen.getByText('Assigned to: Hannah Helper')).toBeTruthy();
      expect(screen.getByTestId('tasks-open-section')).toBeTruthy();
    });

    expect(tables.tasks).toHaveLength(1);
    const createdTask = tables.tasks![0]!;
    const taskId = String(createdTask.id);
    // 2026-11-18 10:30 America/New_York (EST, UTC-5) -> 15:30:00.000Z
    expect(createdTask.due_at).toBe('2026-11-18T15:30:00.000Z');
    expect(createdTask.assignee).toBe(HELPER_ID);
    expect(createdTask.done_at).toBeNull();
    expect(createdTask.done_by).toBeNull();

    // Complete task: sets done_at = NOW and done_by = HELPER_ID
    await fireEvent.press(
      within(screen.getByTestId(`task-complete-button-${taskId}`)).getByRole('button'),
    );

    await waitFor(() => {
      expect(screen.getByTestId('tasks-done-section')).toBeTruthy();
      expect(screen.getByTestId(`task-uncomplete-button-${taskId}`)).toBeTruthy();
    });
    expect(tables.tasks![0]?.done_at).toBe(NOW.toISOString());
    expect(tables.tasks![0]?.done_by).toBe(HELPER_ID);

    // Un-complete task: clears both done_at and done_by
    await fireEvent.press(
      within(screen.getByTestId(`task-uncomplete-button-${taskId}`)).getByRole('button'),
    );

    await waitFor(() => {
      expect(screen.getByTestId('tasks-open-section')).toBeTruthy();
      expect(screen.getByTestId(`task-complete-button-${taskId}`)).toBeTruthy();
    });
    expect(tables.tasks![0]?.done_at).toBeNull();
    expect(tables.tasks![0]?.done_by).toBeNull();

    // Switch to Today tab and verify the open task due today appears under Tasks due today
    await fireEvent.press(screen.getByTestId('tab-today'));
    await waitFor(() => {
      expect(screen.getByTestId(`today-task-row-${taskId}`)).toBeTruthy();
    });
    expect(
      within(screen.getByTestId(`today-task-row-${taskId}`)).getByText('Pick up insulin pens'),
    ).toBeTruthy();
  });

  it('orders open tasks by due date (no date last) before done tasks, shows visit_note badge, and filters by assignee (everyone, me, person, nobody)', async () => {
    const initialTasks = [
      {
        id: 'c1500001-0000-4000-8000-000000000001',
        circle_id: CIRCLE_ID,
        title: 'Task with no due date',
        due_at: null,
        assignee: null,
        done_at: null,
        done_by: null,
        source: 'manual',
      },
      {
        id: 'c1500001-0000-4000-8000-000000000002',
        circle_id: CIRCLE_ID,
        title: 'Book cardiology blood test',
        due_at: '2026-11-19T14:00:00.000Z',
        assignee: OWNER_ID,
        done_at: null,
        done_by: null,
        source: 'visit_note',
      },
      {
        id: 'c1500001-0000-4000-8000-000000000003',
        circle_id: CIRCLE_ID,
        title: 'Refill pill organizer',
        due_at: '2026-11-18T14:00:00.000Z',
        assignee: HELPER_ID,
        done_at: null,
        done_by: null,
        source: 'manual',
      },
      {
        id: 'c1500001-0000-4000-8000-000000000004',
        circle_id: CIRCLE_ID,
        title: 'Already completed task',
        due_at: '2026-11-17T14:00:00.000Z',
        assignee: OWNER_ID,
        done_at: '2026-11-17T16:00:00.000Z',
        done_by: OWNER_ID,
        source: 'manual',
      },
    ];

    const { routes } = setupRouter(OWNER_ID, initialTasks);
    await renderRouter(routes, { initialUrl: '/tasks', wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('tasks-open-section')).toBeTruthy();
      expect(screen.getByTestId('tasks-done-section')).toBeTruthy();
    });

    // Visit note badge shown on task 2
    expect(
      screen.getByTestId('task-visit-note-badge-c1500001-0000-4000-8000-000000000002'),
    ).toBeTruthy();

    // Verify open tasks order: earliest due first (task 3), then later due (task 2), then no due date (task 1)
    const openSection = screen.getByTestId('tasks-open-section');
    const openCards = within(openSection).getAllByTestId(/^task-card-/);
    expect(openCards.map((c) => c.props.testID)).toEqual([
      'task-card-c1500001-0000-4000-8000-000000000003',
      'task-card-c1500001-0000-4000-8000-000000000002',
      'task-card-c1500001-0000-4000-8000-000000000001',
    ]);

    // Filter: Me (OWNER_ID) -> only task 2 and task 4
    await fireEvent.press(within(screen.getByTestId('tasks-filter-me')).getByRole('button'));
    await waitFor(() => {
      expect(screen.getByText('Book cardiology blood test')).toBeTruthy();
      expect(screen.getByText('Already completed task')).toBeTruthy();
      expect(screen.queryByText('Refill pill organizer')).toBeNull();
      expect(screen.queryByText('Task with no due date')).toBeNull();
    });

    // Filter: Hannah Helper (HELPER_ID) -> only task 3
    await fireEvent.press(
      within(screen.getByTestId(`tasks-filter-person-${HELPER_ID}`)).getByRole('button'),
    );
    await waitFor(() => {
      expect(screen.getByText('Refill pill organizer')).toBeTruthy();
      expect(screen.queryByText('Book cardiology blood test')).toBeNull();
    });

    // Filter: Nobody (Unassigned) -> only task 1
    await fireEvent.press(within(screen.getByTestId('tasks-filter-nobody')).getByRole('button'));
    await waitFor(() => {
      expect(screen.getByText('Task with no due date')).toBeTruthy();
      expect(screen.queryByText('Refill pill organizer')).toBeNull();
    });
  });

  it('viewer sees task list only without add, edit, or complete controls; realtime updates a task completed on another phone and cleans up on unmount', async () => {
    const taskId = 'c1500001-0000-4000-8000-000000000009';
    const { routes, emitTasksRealtime, unsubscribeSpy, removeChannelSpy } = setupRouter(VIEWER_ID, [
      {
        id: taskId,
        circle_id: CIRCLE_ID,
        title: 'Order blood pressure cuff',
        due_at: '2026-11-18T16:00:00.000Z',
        assignee: HELPER_ID,
        done_at: null,
        done_by: null,
        source: 'manual',
      },
    ]);

    const r = await renderRouter(routes, { initialUrl: '/tasks', wrapper });

    await waitFor(() => {
      expect(screen.getByText('Order blood pressure cuff')).toBeTruthy();
      expect(screen.getByTestId('tasks-open-section')).toBeTruthy();
    });

    // Viewer sees no Add, Complete, or Edit buttons
    expect(screen.queryByTestId('tasks-add-button')).toBeNull();
    expect(screen.queryByTestId(`task-complete-button-${taskId}`)).toBeNull();
    expect(screen.queryByTestId(`task-edit-button-${taskId}`)).toBeNull();

    // Simulate task completed on another phone via Realtime UPDATE
    await act(async () => {
      emitTasksRealtime({
        eventType: 'UPDATE',
        new: {
          id: taskId,
          circle_id: CIRCLE_ID,
          title: 'Order blood pressure cuff',
          due_at: '2026-11-18T16:00:00.000Z',
          assignee: HELPER_ID,
          done_at: '2026-11-18T12:05:00.000Z',
          done_by: HELPER_ID,
          source: 'manual',
        },
        old: { id: taskId },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('tasks-done-section')).toBeTruthy();
      expect(screen.queryByTestId('tasks-open-section')).toBeNull();
    });

    await act(async () => {
      r.unmount();
    });
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(removeChannelSpy).toHaveBeenCalledTimes(1);
  });
});
