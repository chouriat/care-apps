// Review tests for CC-3b (PR #33). Each test fails on a specific way the Meds screen can go wrong.
import * as UI from '@carecircle/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import MedsScreen from '../app/(tabs)/meds';
import TodayScreen from '../app/(tabs)/today';
import { createFakeTodayClient } from './__fixtures__/today-fake-client';
import {
  addMedication,
  computeMedicationAdherence7d,
  updateMedication,
  type MedsDeps,
} from './features/meds/api';
import * as ObservabilityApi from './features/observability/api';
import { memoryTodayStorage, resetTodayState } from './features/today/api';

const circleId = 'c1c00001-0000-4000-8000-000000000001';
const ownerId = 'c1000001-0000-4000-8000-00000000000a';
const helperId = 'c1000001-0000-4000-8000-00000000000c';
const medId = 'c1200001-0000-4000-8000-000000000001';
const otherMedId = 'c1200001-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-15T12:00:00.000Z');

function seedTables(): Record<string, Array<Record<string, unknown>>> {
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
      { circle_id: circleId, user_id: helperId, role: 'helper', joined_at: '2026-11-03T12:00:00Z' },
    ],
    medications: [
      {
        id: medId,
        circle_id: circleId,
        name: 'Metformin',
        strength: '500 mg',
        dose_text: '1 tablet',
        schedule: { kind: 'daily', times: ['08:00'] },
        instructions: null,
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

function dose(id: string, medicationId: string, dueAt: string, status: string) {
  return {
    id,
    medicationId,
    circleId,
    dueAt,
    status: status as 'given',
    actedBy: null,
    actedAt: null,
  };
}

beforeEach(() => {
  resetTodayState();
  delete process.env.MOCKS;
  delete process.env.EXPO_PUBLIC_MOCKS;
  jest.restoreAllMocks();
});

describe('CC-3b review', () => {
  it('7-day adherence counts only this medicine, only doses due in the last 7 days up to now', () => {
    const med = {
      id: medId,
      circleId,
      name: 'Metformin',
      strength: null,
      doseText: '1 tablet',
      schedule: { kind: 'daily' as const, times: ['08:00'] },
      instructions: null,
      startDate: '2026-11-01',
      endDate: null,
      active: true,
      source: 'manual' as const,
    };
    const result = computeMedicationAdherence7d(
      med,
      [
        dose('d1', medId, '2026-11-14T08:00:00.000Z', 'given'),
        dose('d2', medId, '2026-11-13T08:00:00.000Z', 'missed'),
        // 8 days ago: outside the window
        dose('d3', medId, '2026-11-07T08:00:00.000Z', 'missed'),
        // later today, still pending: not due yet
        dose('d4', medId, '2026-11-15T20:00:00.000Z', 'pending'),
        // another medicine
        dose('d5', otherMedId, '2026-11-14T08:00:00.000Z', 'missed'),
      ],
      NOW,
    );
    expect(result).toMatchObject({ givenCount: 1, totalCount: 2, percent: 50 });
  });

  it('the real cc_med_added sender sends exactly { source: "manual" }', async () => {
    const track = jest.fn(async () => undefined);
    jest
      .spyOn(ObservabilityApi, 'getAppObservability')
      .mockReturnValue({ analytics: { track } } as never);
    const fake = createFakeTodayClient({ tables: seedTables() });
    const res = await addMedication(
      {
        circleId,
        name: 'Vitamin D3',
        doseText: '1 softgel',
        schedule: { kind: 'daily', times: ['09:00'] },
        memberRole: 'helper',
      },
      {
        getClient: () => fake.client as never,
        getUserId: async () => helperId,
        storage: memoryTodayStorage,
        now: () => NOW,
      },
    );
    expect(res.ok).toBe(true);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('cc_med_added', { source: 'manual' });
  });

  it('a blank start date is left to the database default on add, and does not wipe it on edit', async () => {
    const fake = createFakeTodayClient({ tables: seedTables() });
    const deps: MedsDeps = {
      getClient: () => fake.client as never,
      getUserId: async () => helperId,
      storage: memoryTodayStorage,
      now: () => NOW,
      trackMedAdded: () => undefined,
    };
    await addMedication(
      {
        circleId,
        name: 'Vitamin D3',
        doseText: '1 softgel',
        schedule: { kind: 'daily', times: ['09:00'] },
        startDate: '',
        memberRole: 'helper',
      },
      deps,
    );
    await updateMedication(
      {
        circleId,
        medicationId: medId,
        name: 'Metformin',
        doseText: '2 tablets',
        schedule: { kind: 'daily', times: ['08:00'] },
        startDate: null,
        memberRole: 'helper',
      },
      deps,
    );
    const writes = fake.queries.filter(
      (q) => q.table === 'medications' && (q.op === 'insert' || q.op === 'update'),
    );
    expect(writes.map((q) => q.op)).toEqual(['insert', 'update']);
    for (const write of writes) {
      expect(write.values).not.toHaveProperty('start_date');
    }
  });

  it('a save the server confirmed is never shown as "Not saved", even if the reload after it fails', async () => {
    let saved = false;
    const tables = seedTables();
    const fake = createFakeTodayClient({
      tables,
      // The insert reaches the server and succeeds; the network drops right after.
      isOnline: () => !saved,
      writeError: () => {
        saved = true;
        return null;
      },
    });
    const tracked: string[] = [];
    const deps: MedsDeps = {
      getClient: () => fake.client as never,
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
    await waitFor(() => expect(screen.getByTestId('meds-add-button')).toBeTruthy());
    await fireEvent.press(within(screen.getByTestId('meds-add-button')).getByRole('button'));
    await fireEvent.changeText(screen.getByTestId('meds-name-input'), 'Vitamin D3');
    await fireEvent.changeText(screen.getByTestId('meds-dose-text-input'), '1 softgel');
    await fireEvent.press(within(screen.getByTestId('meds-save-button')).getByRole('button'));

    await waitFor(() => expect(screen.getByTestId('meds-offline')).toBeTruthy());
    expect(screen.queryByTestId('meds-not-saved-notice')).toBeNull();
    expect(tracked).toEqual(['cc_med_added']);
    expect(tables.medications!.filter((m) => m.name === 'Vitamin D3')).toHaveLength(1);

    // Back online: the list shows the saved medicine and the form is closed, not waiting
    // for a second Save.
    saved = false;
    await fireEvent.press(within(screen.getByTestId('meds-offline')).getByRole('button'));
    await waitFor(() => expect(screen.getByText('Vitamin D3')).toBeTruthy());
    expect(screen.queryByTestId('meds-form')).toBeNull();
    expect(screen.getByTestId('meds-add-button')).toBeTruthy();
  });

  it('the Today screen reloads after a medicine is saved', async () => {
    const tables = seedTables();
    // Today and Meds use separate clients on the same data, so we can see Today's own queries.
    const todayFake = createFakeTodayClient({ tables });
    const medsFake = createFakeTodayClient({ tables });
    await render(
      <UI.ThemeProvider>
        <TodayScreen
          deps={{
            getClient: () => todayFake.client as never,
            getUserId: async () => helperId,
            storage: memoryTodayStorage,
            now: () => NOW,
          }}
          referenceNow={NOW}
        />
      </UI.ThemeProvider>,
    );
    const todayCircleLoads = () => todayFake.queries.filter((q) => q.table === 'circles').length;
    await waitFor(() => expect(todayCircleLoads()).toBe(1));

    let res: Awaited<ReturnType<typeof addMedication>> | undefined;
    await act(async () => {
      res = await addMedication(
        {
          circleId,
          name: 'Vitamin D3',
          doseText: '1 softgel',
          schedule: { kind: 'daily', times: ['09:00'] },
          memberRole: 'helper',
        },
        {
          getClient: () => medsFake.client as never,
          getUserId: async () => helperId,
          storage: memoryTodayStorage,
          now: () => NOW,
          trackMedAdded: () => undefined,
        },
      );
    });
    expect(res?.ok).toBe(true);
    await waitFor(() => expect(todayCircleLoads()).toBe(2));
  });
});
