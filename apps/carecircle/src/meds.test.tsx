import * as Core from '@carecircle/core';
import * as UI from '@carecircle/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import MedsScreen from '../app/(tabs)/meds';
import en from '../i18n/en.json';
import { createFakeTodayClient } from './__fixtures__/today-fake-client';
import {
  addMedication,
  computeMedicationAdherence7d,
  formatScheduleSummary,
  loadMedicationsScreen,
  pauseMedication,
  updateMedication,
  type MedsDeps,
} from './features/meds/api';
import { MedsScreenView } from './features/meds/components';
import { loadCachedTodaySnapshot, memoryTodayStorage, resetTodayState } from './features/today/api';

const circleId = 'c1c00001-0000-4000-8000-000000000001';
const ownerId = 'c1000001-0000-4000-8000-00000000000a';
const viewerId = 'c1000001-0000-4000-8000-00000000000b';
const helperId = 'c1000001-0000-4000-8000-00000000000c';
const medDailyId = 'c1200001-0000-4000-8000-000000000001';
const medWeeklyId = 'c1200001-0000-4000-8000-000000000002';
const medPausedId = 'c1200001-0000-4000-8000-000000000003';
const NOW = new Date('2026-11-15T12:00:00.000Z');

function seedTables() {
  return {
    circles: [
      {
        id: circleId,
        name: 'Family Care',
        care_recipient_name: 'Evelyn',
        care_recipient_dob: null,
        timezone: 'Europe/London',
        created_by: ownerId,
        created_at: '2026-11-01T12:00:00.000Z',
      },
    ],
    circle_members: [
      { circle_id: circleId, user_id: ownerId, role: 'owner', joined_at: '2026-11-01T12:00:00Z' },
      { circle_id: circleId, user_id: viewerId, role: 'viewer', joined_at: '2026-11-02T12:00:00Z' },
      { circle_id: circleId, user_id: helperId, role: 'helper', joined_at: '2026-11-03T12:00:00Z' },
    ],
    medications: [
      {
        id: medDailyId,
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
      {
        id: medWeeklyId,
        circle_id: circleId,
        name: 'Lisinopril',
        strength: '10 mg',
        dose_text: '1 tablet',
        schedule: { kind: 'weekly', days: ['mon', 'thu'], times: ['09:00'] },
        instructions: null,
        start_date: '2026-11-01',
        end_date: null,
        active: true,
        source: 'manual',
      },
      {
        id: medPausedId,
        circle_id: circleId,
        name: 'Paused Med',
        strength: null,
        dose_text: '1 capsule',
        schedule: { kind: 'as_needed' },
        instructions: null,
        start_date: '2026-11-01',
        end_date: null,
        active: false,
        source: 'manual',
      },
    ],
    dose_events: [
      // Within last 7 days (2026-11-08T12:00Z .. 2026-11-15T12:00Z): 3 given, 1 missed = 3/4 (75%)
      {
        id: 'c1300001-0000-4000-8000-000000000001',
        medication_id: medDailyId,
        circle_id: circleId,
        due_at: '2026-11-13T08:00:00.000Z',
        status: 'given',
        acted_by: ownerId,
        acted_at: '2026-11-13T08:05:00.000Z',
      },
      {
        id: 'c1300001-0000-4000-8000-000000000002',
        medication_id: medDailyId,
        circle_id: circleId,
        due_at: '2026-11-13T20:00:00.000Z',
        status: 'given',
        acted_by: ownerId,
        acted_at: '2026-11-13T20:05:00.000Z',
      },
      {
        id: 'c1300001-0000-4000-8000-000000000003',
        medication_id: medDailyId,
        circle_id: circleId,
        due_at: '2026-11-14T08:00:00.000Z',
        status: 'missed',
        acted_by: null,
        acted_at: null,
      },
      {
        id: 'c1300001-0000-4000-8000-000000000004',
        medication_id: medDailyId,
        circle_id: circleId,
        due_at: '2026-11-15T08:00:00.000Z',
        status: 'given',
        acted_by: helperId,
        acted_at: '2026-11-15T08:02:00.000Z',
      },
      // Older than 7 days (2026-11-01): must be excluded by gte/lte query
      {
        id: 'c1300001-0000-4000-8000-000000000099',
        medication_id: medDailyId,
        circle_id: circleId,
        due_at: '2026-11-01T08:00:00.000Z',
        status: 'missed',
        acted_by: null,
        acted_at: null,
      },
    ],
  };
}

beforeEach(() => {
  resetTodayState();
  delete process.env.MOCKS;
  delete process.env.EXPO_PUBLIC_MOCKS;
});

describe('CC-3b Medication screens (/(tabs)/meds)', () => {
  it('renders loading, empty, error, and offline states', async () => {
    const onRetry = jest.fn();

    const { rerender } = await render(
      <UI.ThemeProvider>
        <MedsScreenView isLoading />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('meds-loading')).toBeTruthy();

    await rerender(
      <UI.ThemeProvider>
        <MedsScreenView items={[]} memberRole="owner" />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('meds-empty-state')).toBeTruthy();

    await rerender(
      <UI.ThemeProvider>
        <MedsScreenView hasError onRetry={onRetry} />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('meds-error')).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('meds-error')).getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);

    onRetry.mockClear();
    await rerender(
      <UI.ThemeProvider>
        <MedsScreenView isOffline onRetry={onRetry} />
      </UI.ThemeProvider>,
    );
    expect(screen.getByTestId('meds-offline')).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('meds-offline')).getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('loads active medications, formats all 4 schedule kinds, and queries 7-day adherence with gte/lte on due_at', async () => {
    expect(formatScheduleSummary({ kind: 'daily', times: ['08:00', '20:00'] })).toBe(
      'Daily · 08:00, 20:00',
    );
    expect(formatScheduleSummary({ kind: 'weekly', days: ['mon', 'thu'], times: ['09:00'] })).toBe(
      'Weekly (Mon, Thu) · 09:00',
    );
    expect(formatScheduleSummary({ kind: 'every_n_days', n: 3, times: ['08:00'] })).toBe(
      'Every 3 days · 08:00',
    );
    expect(formatScheduleSummary({ kind: 'as_needed' })).toBe('As needed');

    const fake = createFakeTodayClient({ tables: seedTables() });
    const res = await loadMedicationsScreen({
      getClient: () => fake.client,
      getUserId: async () => ownerId,
      storage: memoryTodayStorage,
      now: () => NOW,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Paused medication (active = false) is excluded
    expect(res.items.map((i) => i.medication.id)).toEqual([medDailyId, medWeeklyId]);
    expect(res.items[0]?.scheduleSummary).toBe('Daily · 08:00, 20:00');
    expect(res.items[0]?.adherence7d).toEqual({
      givenCount: 3,
      totalCount: 4,
      percent: 75,
      label: '3/4 given (75%)',
    });

    const doseQuery = fake.queries.find((q) => q.table === 'dose_events');
    expect(doseQuery?.filters).toEqual([
      ['eq', 'circle_id', circleId],
      ['gte', 'due_at', '2026-11-08T12:00:00.000Z'],
      ['lte', 'due_at', '2026-11-15T12:00:00.000Z'],
    ]);

    expect(
      computeMedicationAdherence7d(
        {
          id: 'c1200001-0000-4000-8000-000000000099',
          circleId,
          name: 'Acetaminophen',
          strength: null,
          doseText: '1 tablet',
          schedule: { kind: 'as_needed' },
          instructions: null,
          startDate: null,
          endDate: null,
          active: true,
          source: 'manual',
        },
        [],
        NOW,
      ).label,
    ).toBe(en.meds.adherenceAsNeeded);
  });

  it('uses the signed-in user’s own role from circle_members, hides Add/Edit/Pause from a viewer, and refuses viewer writes', async () => {
    const fake = createFakeTodayClient({ tables: seedTables() });
    const depsFor = (userId: string | null): MedsDeps => ({
      getClient: () => fake.client,
      getUserId: async () => userId,
      storage: memoryTodayStorage,
      now: () => NOW,
    });

    await render(
      <UI.ThemeProvider>
        <MedsScreen deps={depsFor(viewerId)} />
      </UI.ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId(`meds-item-${medDailyId}`)).toBeTruthy());
    expect(screen.queryByTestId('meds-add-button')).toBeNull();
    expect(screen.queryByTestId('meds-scan-button')).toBeNull();
    expect(screen.queryByTestId(`meds-edit-${medDailyId}`)).toBeNull();
    expect(screen.queryByTestId(`meds-pause-${medDailyId}`)).toBeNull();

    // Unknown user defaults to viewer
    const unknownLoad = await loadMedicationsScreen(depsFor(null));
    expect(unknownLoad.ok && unknownLoad.memberRole).toBe('viewer');

    // Direct API writes as viewer fail before touching the server
    expect(
      await addMedication(
        {
          circleId,
          name: 'Aspirin',
          doseText: '1 tablet',
          schedule: { kind: 'daily', times: ['08:00'] },
          memberRole: 'viewer',
        },
        depsFor(viewerId),
      ),
    ).toEqual({ ok: false, errorCode: 'FORBIDDEN_ROLE', isOffline: false });

    expect(
      await updateMedication(
        {
          circleId,
          medicationId: medDailyId,
          name: 'Metformin XR',
          doseText: '1 tablet',
          schedule: { kind: 'daily', times: ['08:00'] },
          memberRole: 'viewer',
        },
        depsFor(viewerId),
      ),
    ).toEqual({ ok: false, errorCode: 'FORBIDDEN_ROLE', isOffline: false });

    expect(
      await pauseMedication(
        { circleId, medicationId: medDailyId, memberRole: 'viewer' },
        depsFor(viewerId),
      ),
    ).toEqual({ ok: false, errorCode: 'FORBIDDEN_ROLE', isOffline: false });
  });

  it('adds, edits, and pauses a medication, fires cc_med_added with { source: "manual" } only, and reloads Today cache', async () => {
    const fake = createFakeTodayClient({ tables: seedTables() });
    const trackedEvents: Array<{ name: string; props: Record<string, unknown> }> = [];
    const deps: MedsDeps = {
      getClient: () => fake.client,
      getUserId: async () => helperId,
      storage: memoryTodayStorage,
      now: () => NOW,
      trackMedAdded: () => {
        const props = Core.validateAnalyticsEvent('cc_med_added', { source: 'manual' });
        trackedEvents.push({ name: 'cc_med_added', props });
      },
    };

    const onScanPrescription = jest.fn();

    await render(
      <UI.ThemeProvider>
        <MedsScreen deps={deps} onScanPrescription={onScanPrescription} />
      </UI.ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('meds-add-button')).toBeTruthy());
    expect(screen.getByTestId('meds-scan-button')).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('meds-scan-button')).getByRole('button'));
    expect(onScanPrescription).toHaveBeenCalledTimes(1);

    // 1. Add a new medication
    await fireEvent.press(within(screen.getByTestId('meds-add-button')).getByRole('button'));
    expect(screen.getByTestId('meds-form')).toBeTruthy();

    // Empty submit fails scheduleSchema / form validation
    await fireEvent.press(within(screen.getByTestId('meds-save-button')).getByRole('button'));
    expect(screen.getByTestId('meds-form-validation-error')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('meds-name-input'), 'Vitamin D3');
    await fireEvent.changeText(screen.getByTestId('meds-strength-input'), '1000 IU');
    await fireEvent.changeText(screen.getByTestId('meds-dose-text-input'), '1 softgel');
    await fireEvent.press(
      within(screen.getByTestId('meds-schedule-kind-every_n_days')).getByRole('button'),
    );
    await fireEvent.changeText(screen.getByTestId('meds-interval-input'), '3');
    await fireEvent.changeText(screen.getByTestId('meds-times-input'), '09:00');
    await fireEvent.press(within(screen.getByTestId('meds-save-button')).getByRole('button'));

    await waitFor(() => expect(screen.getByText('Vitamin D3 (1000 IU)')).toBeTruthy());
    expect(trackedEvents).toEqual([{ name: 'cc_med_added', props: { source: 'manual' } }]);
    expect(JSON.stringify(trackedEvents)).not.toContain('Vitamin');

    // Today snapshot cache was reloaded after save
    const cachedAfterAdd = await loadCachedTodaySnapshot(memoryTodayStorage, helperId);
    expect(cachedAfterAdd?.medications.some((m) => m.name === 'Vitamin D3')).toBe(true);

    // 2. Edit Metformin
    await fireEvent.press(
      within(screen.getByTestId(`meds-edit-${medDailyId}`)).getByRole('button'),
    );
    await fireEvent.changeText(screen.getByTestId('meds-dose-text-input'), '2 tablets');
    await fireEvent.press(within(screen.getByTestId('meds-save-button')).getByRole('button'));

    await waitFor(() => expect(screen.getByText('2 tablets')).toBeTruthy());
    expect(trackedEvents).toHaveLength(1);

    // 3. Pause Lisinopril (active = false)
    await fireEvent.press(
      within(screen.getByTestId(`meds-pause-${medWeeklyId}`)).getByRole('button'),
    );
    await waitFor(() => expect(screen.queryByTestId(`meds-item-${medWeeklyId}`)).toBeNull());
  });

  it('never shows a change as saved when the server refuses, and displays "Not saved"', async () => {
    const fake = createFakeTodayClient({
      tables: seedTables(),
      writeError: () => ({ message: 'permission denied for table medications', code: '42501' }),
    });
    const tracked: string[] = [];
    const deps: MedsDeps = {
      getClient: () => fake.client,
      getUserId: async () => helperId,
      storage: memoryTodayStorage,
      now: () => NOW,
      trackMedAdded: () => tracked.push('cc_med_added'),
    };

    await render(
      <UI.ThemeProvider>
        <MedsScreen deps={deps} />
      </UI.ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId(`meds-pause-${medDailyId}`)).toBeTruthy());
    await fireEvent.press(
      within(screen.getByTestId(`meds-pause-${medDailyId}`)).getByRole('button'),
    );

    await waitFor(() => expect(screen.getByTestId('meds-not-saved-notice')).toBeTruthy());
    expect(screen.getByText(en.meds.notSavedTitle)).toBeTruthy();
    // Metformin remains in the list because the server refused the pause
    expect(screen.getByTestId(`meds-item-${medDailyId}`)).toBeTruthy();
    expect(tracked).toEqual([]);
  });
});
