import * as UI from '@carecircle/ui';
import { File, Paths } from 'expo-file-system';
import { Stack } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { AppState, type AppStateStatus, StyleSheet } from 'react-native';
import TabsLayout from '../app/(tabs)/_layout';
import CalendarScreen from '../app/(tabs)/calendar';
import MedsScreen from '../app/(tabs)/meds';
import TasksScreen from '../app/(tabs)/tasks';
import TodayScreen from '../app/(tabs)/today';
import CareLogRoute from '../app/log';
import VisitNewRoute from '../app/visit/new';
import { createFakeTodayClient } from './__fixtures__/today-fake-client';
import { CalendarScreenView } from './features/calendar';
import { USER_DATA_EXPORT_FILENAME, shareExportedUserDataJson } from './features/circle';
import { CareLogScreenView } from './features/log';
import {
  FALLBACK_IANA_TIMEZONES,
  filterIanaTimezones,
  getSupportedIanaTimezones,
} from './features/onboarding/api';
import { OnboardingStartScreen } from './features/onboarding/components';
import { TasksScreenView } from './features/tasks';
import {
  memoryTodayStorage,
  msUntilNextMidnightInZone,
  resetTodayState,
  type TodayDeps,
} from './features/today/api';
import { VisitNoteScreen } from './features/visit';

const CIRCLE_ID = 'c1c00001-0000-4000-8000-000000000001';
const OWNER_ID = 'c1000001-0000-4000-8000-00000000000a';
const HELPER_ID = 'c1000001-0000-4000-8000-00000000000c';
const MED_ID = 'c1200001-0000-4000-8000-000000000001';

const wrapper = ({ children }: { children: ReactNode }) => (
  <UI.ThemeProvider>{children}</UI.ThemeProvider>
);

function assertAllButtonsHaveLabelAnd44PtTouchTarget() {
  const buttons = screen.getAllByRole('button');
  expect(buttons.length).toBeGreaterThan(0);
  for (const btn of buttons) {
    expect(btn.props.accessibilityLabel).toEqual(expect.stringMatching(/\S/));
    const flat = StyleSheet.flatten(btn.props.style) as {
      minHeight?: number;
      minWidth?: number;
    };
    expect(flat.minHeight).toBeGreaterThanOrEqual(UI.MIN_TOUCH_TARGET_PT);
    expect(flat.minWidth).toBeGreaterThanOrEqual(UI.MIN_TOUCH_TARGET_PT);
  }
}

beforeEach(() => {
  resetTodayState();
  delete process.env.MOCKS;
  delete process.env.EXPO_PUBLIC_MOCKS;
  jest.restoreAllMocks();
});

describe('Step 21 small screen gaps', () => {
  it('1. Time zone picker uses Intl.supportedValuesOf("timeZone") with Hermes fallback, puts device timezone first, searches IANA zones, and selects a tapped zone', async () => {
    // Uses Intl.supportedValuesOf('timeZone') when available and puts device zone first
    const fromIntl = getSupportedIanaTimezones('America/New_York', () => [
      'Europe/Paris',
      'America/New_York',
      'Asia/Tokyo',
    ]);
    expect(fromIntl[0]).toBe('America/New_York');
    expect(fromIntl).toEqual(['America/New_York', 'Europe/Paris', 'Asia/Tokyo', 'UTC']);

    // Falls back to FALLBACK_IANA_TIMEZONES when Intl.supportedValuesOf is absent (older Hermes)
    const fromFallback = getSupportedIanaTimezones('Europe/Paris', null);
    expect(fromFallback[0]).toBe('Europe/Paris');
    expect(fromFallback.length).toBeGreaterThanOrEqual(FALLBACK_IANA_TIMEZONES.length);

    expect(filterIanaTimezones('tokyo', 'Europe/Paris')).toContain('Asia/Tokyo');

    const onCreateCircle = jest.fn();
    const view = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        start: () => (
          <OnboardingStartScreen defaultTimezone="Europe/Paris" onCreateCircle={onCreateCircle} />
        ),
      },
      { initialUrl: '/start', wrapper },
    );

    // Device timezone is default in the input and first option in the picker
    expect(screen.getByTestId('onboarding-timezone-input').props.value).toBe('Europe/Paris');
    expect(screen.getByTestId('onboarding-timezone-picker')).toBeTruthy();
    expect(screen.getByTestId('onboarding-timezone-option-Europe/Paris')).toBeTruthy();

    // Search for "New_York" and tap the matching IANA chip
    await fireEvent.changeText(screen.getByTestId('onboarding-timezone-input'), 'New_York');
    expect(screen.getByTestId('onboarding-timezone-option-America/New_York')).toBeTruthy();

    await fireEvent.press(
      within(screen.getByTestId('onboarding-timezone-option-America/New_York')).getByRole('button'),
    );
    expect(screen.getByTestId('onboarding-timezone-input').props.value).toBe('America/New_York');

    await fireEvent.changeText(screen.getByTestId('onboarding-circle-name-input'), 'Care Family');
    await fireEvent.changeText(screen.getByTestId('onboarding-recipient-name-input'), 'Evelyn');
    await fireEvent.press(
      within(screen.getByTestId('onboarding-submit-button')).getByRole('button'),
    );

    expect(onCreateCircle).toHaveBeenCalledWith({
      name: 'Care Family',
      careRecipientName: 'Evelyn',
      timezone: 'America/New_York',
    });

    await act(async () => {
      view.unmount();
    });
  });

  it('2. Today reloads when the date in the circle time zone changes (timer to next midnight and on return to foreground)', async () => {
    jest.useFakeTimers();
    try {
      // 2026-11-18T04:59:50.000Z is 2026-11-17 23:59:50 in America/New_York (EST, UTC-5): 10s before midnight
      let currentClock = new Date('2026-11-18T04:59:50.000Z');
      expect(msUntilNextMidnightInZone(currentClock, 'America/New_York')).toBe(10_000);

      let appStateListener: ((state: AppStateStatus) => void) | null = null;
      jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
        appStateListener = listener as (state: AppStateStatus) => void;
        return { remove: jest.fn() };
      });

      const tables = {
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
        ],
        medications: [
          {
            id: MED_ID,
            circle_id: CIRCLE_ID,
            name: 'Metformin',
            strength: '500 mg',
            dose_text: '1 tablet',
            schedule: { kind: 'daily', times: ['08:00', '09:00', '10:00'] },
            instructions: null,
            start_date: '2026-11-01',
            end_date: null,
            active: true,
            source: 'manual',
          },
        ],
        dose_events: [
          // Due on 2026-11-17 at 08:00 America/New_York (13:00 UTC)
          {
            id: 'c1300001-0000-4000-8000-000000000001',
            medication_id: MED_ID,
            circle_id: CIRCLE_ID,
            due_at: '2026-11-17T13:00:00.000Z',
            status: 'pending',
            acted_by: null,
            acted_at: null,
          },
          // Due on 2026-11-18 at 09:00 America/New_York (14:00 UTC)
          {
            id: 'c1300001-0000-4000-8000-000000000002',
            medication_id: MED_ID,
            circle_id: CIRCLE_ID,
            due_at: '2026-11-18T14:00:00.000Z',
            status: 'pending',
            acted_by: null,
            acted_at: null,
          },
          // Due on 2026-11-19 at 10:00 America/New_York (15:00 UTC)
          {
            id: 'c1300001-0000-4000-8000-000000000003',
            medication_id: MED_ID,
            circle_id: CIRCLE_ID,
            due_at: '2026-11-19T15:00:00.000Z',
            status: 'pending',
            acted_by: null,
            acted_at: null,
          },
        ],
        appointments: [],
        tasks: [],
      };

      const { client } = createFakeTodayClient({ tables });
      const deps: TodayDeps = {
        getClient: () => client,
        getUserId: async () => OWNER_ID,
        storage: memoryTodayStorage,
        now: () => currentClock,
      };

      const view = await renderRouter(
        {
          _layout: () => <Stack screenOptions={{ headerShown: false }} />,
          '(tabs)/_layout': TabsLayout,
          '(tabs)/today': () => <TodayScreen deps={deps} />,
          '(tabs)/meds': () => <MedsScreen />,
          '(tabs)/calendar': () => <CalendarScreen />,
          '(tabs)/tasks': () => <TasksScreen />,
        },
        { initialUrl: '/today', wrapper },
      );

      // Before midnight (2026-11-17 in America/New_York): shows 08:00 dose
      await waitFor(() => {
        expect(screen.getByTestId('today-dose-time-08:00')).toBeTruthy();
      });
      expect(screen.queryByTestId('today-dose-time-09:00')).toBeNull();

      // Advance fake clock past midnight in America/New_York (to 2026-11-18 00:00:01 EST = 05:00:01 UTC)
      currentClock = new Date('2026-11-18T05:00:01.000Z');
      await act(async () => {
        jest.advanceTimersByTime(11_000);
      });

      // Today reloads automatically for 2026-11-18 and shows the 09:00 dose
      await waitFor(() => {
        expect(screen.getByTestId('today-dose-time-09:00')).toBeTruthy();
      });
      expect(screen.queryByTestId('today-dose-time-08:00')).toBeNull();

      // Simulate phone sleeping until the next day (2026-11-19 in America/New_York) and returning to foreground
      currentClock = new Date('2026-11-19T12:00:00.000Z');
      await act(async () => {
        appStateListener?.('active');
      });

      await waitFor(() => {
        expect(screen.getByTestId('today-dose-time-10:00')).toBeTruthy();
      });
      expect(screen.queryByTestId('today-dose-time-09:00')).toBeNull();

      await act(async () => {
        view.unmount();
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('3. renders all four states (loading, empty, error with retry, offline) on Calendar, Tasks, Care log, and Visit note', async () => {
    const onRetry = jest.fn();

    // --- A. Calendar ---
    const calView = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        calendar: () => <CalendarScreenView isLoading onRetry={onRetry} />,
      },
      { initialUrl: '/calendar', wrapper },
    );
    expect(screen.getByTestId('calendar-loading')).toBeTruthy();
    await act(async () => {
      calView.unmount();
    });

    const calEmpty = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        calendar: () => <CalendarScreenView appointments={[]} onRetry={onRetry} />,
      },
      { initialUrl: '/calendar', wrapper },
    );
    expect(screen.getByTestId('calendar-empty-state')).toBeTruthy();
    await act(async () => {
      calEmpty.unmount();
    });

    onRetry.mockClear();
    const calErr = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        calendar: () => <CalendarScreenView hasError onRetry={onRetry} />,
      },
      { initialUrl: '/calendar', wrapper },
    );
    expect(screen.getByTestId('calendar-error')).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('calendar-error')).getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => {
      calErr.unmount();
    });

    onRetry.mockClear();
    const calOff = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        calendar: () => <CalendarScreenView isOffline notSavedNotice onRetry={onRetry} />,
      },
      { initialUrl: '/calendar', wrapper },
    );
    expect(screen.getByTestId('calendar-offline')).toBeTruthy();
    expect(screen.getByTestId('calendar-not-saved-notice')).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('calendar-offline')).getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => {
      calOff.unmount();
    });

    // --- B. Tasks ---
    const baseTasksProps = {
      circleId: CIRCLE_ID,
      circleTimezone: 'UTC',
      currentUserId: OWNER_ID,
      memberRole: 'owner' as const,
      members: [],
      tasks: [],
      isLoading: false,
      hasError: false,
      isOffline: false,
      onRetry,
    };

    const tasksLoading = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        tasks: () => <TasksScreenView {...baseTasksProps} isLoading />,
      },
      { initialUrl: '/tasks', wrapper },
    );
    expect(screen.getByTestId('tasks-loading')).toBeTruthy();
    await act(async () => {
      tasksLoading.unmount();
    });

    onRetry.mockClear();
    const tasksError = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        tasks: () => <TasksScreenView {...baseTasksProps} hasError />,
      },
      { initialUrl: '/tasks', wrapper },
    );
    expect(screen.getByTestId('tasks-error-state')).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('tasks-error-state')).getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => {
      tasksError.unmount();
    });

    onRetry.mockClear();
    const tasksOffline = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        tasks: () => <TasksScreenView {...baseTasksProps} isOffline notSavedNotice />,
      },
      { initialUrl: '/tasks', wrapper },
    );
    expect(screen.getByTestId('tasks-offline-banner')).toBeTruthy();
    expect(screen.getByTestId('tasks-not-saved-banner')).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('tasks-offline-banner')).getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => {
      tasksOffline.unmount();
    });

    // --- C. Care log ---
    const baseLogProps = {
      circleName: 'Family Care',
      timezone: 'UTC',
      members: [],
      entries: [],
      selectedType: null,
      selectedPersonId: null,
      onSelectType: jest.fn(),
      onSelectPerson: jest.fn(),
      hasMore: false,
      isLoading: false,
      isLoadingMore: false,
      hasError: false,
      isOffline: false,
      onRetry,
      onLoadMore: jest.fn(),
      exportFrom: '2026-11-01',
      exportTo: '2026-11-18',
      onChangeExportFrom: jest.fn(),
      onChangeExportTo: jest.fn(),
      onPressExportPdf: jest.fn(),
      isExporting: false,
      exportError: null,
    };

    const logLoading = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        log: () => <CareLogScreenView {...baseLogProps} isLoading />,
      },
      { initialUrl: '/log', wrapper },
    );
    expect(screen.getByTestId('care-log-loading')).toBeTruthy();
    await act(async () => {
      logLoading.unmount();
    });

    const logEmpty = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        log: () => <CareLogScreenView {...baseLogProps} />,
      },
      { initialUrl: '/log', wrapper },
    );
    expect(screen.getByTestId('care-log-empty')).toBeTruthy();
    await act(async () => {
      logEmpty.unmount();
    });

    onRetry.mockClear();
    const logError = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        log: () => <CareLogScreenView {...baseLogProps} hasError />,
      },
      { initialUrl: '/log', wrapper },
    );
    expect(screen.getByTestId('care-log-error')).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('care-log-error')).getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => {
      logError.unmount();
    });

    const logOfflineRoute = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        log: () => <CareLogRoute deps={{ isOffline: true }} />,
      },
      { initialUrl: '/log', wrapper },
    );
    await waitFor(() => {
      expect(screen.getByTestId('care-log-offline')).toBeTruthy();
    });
    await act(async () => {
      logOfflineRoute.unmount();
    });

    // --- D. Visit note ---
    const visitEmpty = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        'visit/new': () => (
          <VisitNoteScreen circleId={CIRCLE_ID} circleTimezone="UTC" memberRole="owner" />
        ),
      },
      { initialUrl: '/visit/new', wrapper },
    );
    expect(screen.getByTestId('visit-empty-state')).toBeTruthy();
    await act(async () => {
      visitEmpty.unmount();
    });

    let shouldFailVisitContext = true;
    const visitErrorClient = {
      from: () => ({
        select: () => ({
          order: () => ({
            limit: async () =>
              shouldFailVisitContext
                ? { data: null, error: { message: 'Database unavailable' } }
                : {
                    data: [
                      {
                        id: CIRCLE_ID,
                        name: 'Family Care',
                        care_recipient_name: 'Evelyn',
                        care_recipient_dob: null,
                        timezone: 'UTC',
                        created_by: OWNER_ID,
                        created_at: '2026-11-01T12:00:00.000Z',
                      },
                    ],
                    error: null,
                  },
          }),
          eq: () => ({
            eq: async () => ({ data: [{ role: 'owner' }], error: null }),
            then: (resolve: (val: unknown) => unknown) =>
              Promise.resolve({ data: [], error: null }).then(resolve),
          }),
        }),
      }),
    };

    const visitErrorRoute = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        'visit/new': () => (
          <VisitNewRoute
            deps={{
              getClient: () => visitErrorClient as never,
              getUserId: async () => OWNER_ID,
            }}
          />
        ),
      },
      { initialUrl: '/visit/new', wrapper },
    );
    await waitFor(() => {
      expect(screen.getByTestId('visit-context-error')).toBeTruthy();
    });
    shouldFailVisitContext = false;
    await fireEvent.press(within(screen.getByTestId('visit-context-error')).getByRole('button'));
    await waitFor(() => {
      expect(screen.getByTestId('visit-capture-section')).toBeTruthy();
    });
    await act(async () => {
      visitErrorRoute.unmount();
    });

    const visitOfflineRoute = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        'visit/new': () => <VisitNewRoute deps={{ isOffline: true }} />,
      },
      { initialUrl: '/visit/new', wrapper },
    );
    await waitFor(() => {
      expect(screen.getByTestId('visit-offline')).toBeTruthy();
    });
    await act(async () => {
      visitOfflineRoute.unmount();
    });
  });

  it('4. every button on Calendar, Tasks, Care log, and Visit note has a non-empty accessibilityLabel and at least 44 pt touch target', async () => {
    // 1. Calendar with form open and an existing appointment
    const cal = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        calendar: () => (
          <CalendarScreenView
            circleId={CIRCLE_ID}
            circleTimezone="UTC"
            memberRole="owner"
            members={[{ userId: HELPER_ID, displayName: 'Hannah Helper', role: 'helper' }]}
            appointments={[
              {
                id: 'c1400001-0000-4000-8000-000000000001',
                circleId: CIRCLE_ID,
                title: 'Cardiology check-up',
                startsAt: '2026-11-18T15:00:00.000Z',
                endsAt: null,
                location: null,
                driverUserId: null,
                notes: null,
              },
            ]}
            initialSelectedDate="2026-11-15"
          />
        ),
      },
      { initialUrl: '/calendar', wrapper },
    );
    await fireEvent.press(within(screen.getByTestId('calendar-add-button')).getByRole('button'));
    assertAllButtonsHaveLabelAnd44PtTouchTarget();
    await act(async () => {
      cal.unmount();
    });

    // 2. Tasks with form open and an existing task
    const tasks = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        tasks: () => (
          <TasksScreenView
            circleId={CIRCLE_ID}
            circleTimezone="UTC"
            currentUserId={OWNER_ID}
            memberRole="owner"
            members={[{ userId: HELPER_ID, displayName: 'Hannah Helper', role: 'helper' }]}
            tasks={[
              {
                id: 'c1500001-0000-4000-8000-000000000001',
                circleId: CIRCLE_ID,
                title: 'Pick up prescription',
                dueAt: '2026-11-18T10:00:00.000Z',
                assignee: HELPER_ID,
                doneAt: null,
                doneBy: null,
                source: 'manual',
              },
            ]}
            isLoading={false}
            hasError={false}
            isOffline={false}
            onRetry={jest.fn()}
          />
        ),
      },
      { initialUrl: '/tasks', wrapper },
    );
    await fireEvent.press(within(screen.getByTestId('tasks-add-button')).getByRole('button'));
    assertAllButtonsHaveLabelAnd44PtTouchTarget();
    await act(async () => {
      tasks.unmount();
    });

    // 3. Care log with entries, filters, export button, and Load more button
    const log = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        log: () => (
          <CareLogScreenView
            circleName="Family Care"
            timezone="UTC"
            members={[{ userId: HELPER_ID, displayName: 'Hannah Helper' }]}
            entries={[
              {
                id: 'c1900001-0000-4000-8000-000000000001',
                circleId: CIRCLE_ID,
                type: 'dose',
                refId: null,
                summary: 'Dose marked given',
                createdBy: HELPER_ID,
                createdAt: '2026-11-18T08:00:00.000Z',
                actorDisplayName: 'Hannah Helper',
              },
            ]}
            selectedType={null}
            selectedPersonId={null}
            onSelectType={jest.fn()}
            onSelectPerson={jest.fn()}
            hasMore
            isLoading={false}
            isLoadingMore={false}
            hasError={false}
            onRetry={jest.fn()}
            onLoadMore={jest.fn()}
            exportFrom="2026-11-01"
            exportTo="2026-11-18"
            onChangeExportFrom={jest.fn()}
            onChangeExportTo={jest.fn()}
            onPressExportPdf={jest.fn()}
            isExporting={false}
            exportError={null}
          />
        ),
      },
      { initialUrl: '/log', wrapper },
    );
    assertAllButtonsHaveLabelAnd44PtTouchTarget();
    await act(async () => {
      log.unmount();
    });

    // 4. Visit note capture and draft review
    const visit = await renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        'visit/new': () => (
          <VisitNoteScreen
            circleId={CIRCLE_ID}
            circleTimezone="UTC"
            memberRole="owner"
            deps={{
              callSummarizeVisit: async () => ({
                ok: true,
                output: {
                  summary: 'Everything looks good.',
                  followUps: [{ title: 'Book lab test', dueHint: null, dueDate: '2026-11-25' }],
                  medChanges: [
                    {
                      action: 'stop',
                      medicationId: MED_ID,
                      name: 'Aspirin',
                      detail: 'Stop taking',
                    },
                  ],
                  questionsToAsk: [],
                },
                model: 'fake',
                latencyMs: 10,
              }),
            }}
          />
        ),
      },
      { initialUrl: '/visit/new', wrapper },
    );
    assertAllButtonsHaveLabelAnd44PtTouchTarget();
    await fireEvent.changeText(screen.getByTestId('visit-notes-text-input'), 'Notes from visit');
    await fireEvent.press(within(screen.getByTestId('visit-summarise-button')).getByRole('button'));
    await waitFor(() => {
      expect(screen.getByTestId('visit-draft-review')).toBeTruthy();
    });
    assertAllButtonsHaveLabelAnd44PtTouchTarget();
    await act(async () => {
      visit.unmount();
    });
  });

  it('5. Data export writes a .json file and shares its file url through the system share sheet without logging any exported data', async () => {
    const sharedPayloads: Array<{ url?: string; message: string; title?: string }> = [];

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const sensitiveExportJson = JSON.stringify(
      {
        userId: OWNER_ID,
        profile: { display_name: 'Evelyn Secret Care' },
        medications: [{ name: 'Metformin 500mg' }],
      },
      null,
      2,
    );

    const res = await shareExportedUserDataJson(sensitiveExportJson, {
      share: async (payload) => {
        sharedPayloads.push(payload);
      },
    });

    const exportedFile = new File(Paths.cache, USER_DATA_EXPORT_FILENAME);
    expect(res.fileUri).toBe(exportedFile.uri);
    expect(exportedFile.uri.endsWith('.json')).toBe(true);
    expect(await exportedFile.text()).toBe(sensitiveExportJson);
    expect(sharedPayloads).toHaveLength(1);
    expect(sharedPayloads[0]?.url).toBe(exportedFile.uri);
    expect(sharedPayloads[0]?.title).toBe(USER_DATA_EXPORT_FILENAME);
    expect(sharedPayloads[0]?.message).toBe(sensitiveExportJson);

    const allConsoleCalls = JSON.stringify([
      ...logSpy.mock.calls,
      ...infoSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ]);
    expect(allConsoleCalls).not.toContain('Evelyn');
    expect(allConsoleCalls).not.toContain('Metformin');
  });
});
