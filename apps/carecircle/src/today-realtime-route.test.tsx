// CC-2b review: the Today route itself must subscribe to its circle's dose_events, show a change
// that another carer (or mark-missed) makes, and remove the channel when the screen unmounts.
// dose-realtime.test.ts covers subscribeToCircleDoseEvents on its own; this covers the wiring.
import * as UI from '@carecircle/ui';
import { act, render, screen, waitFor, within } from '@testing-library/react-native';
import TodayScreen from '../app/(tabs)/today';
import en from '../i18n/en.json';
import { memoryTodayStorage, resetTodayState, type TodayDeps } from './features/today/api';
import { createFakeTodayClient } from './__fixtures__/today-fake-client';

type Listener = (payload: {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old?: Record<string, unknown>;
}) => void;

describe('CC-2b Today route realtime wiring', () => {
  beforeEach(() => {
    resetTodayState();
    delete process.env.MOCKS;
    delete process.env.EXPO_PUBLIC_MOCKS;
  });

  it('subscribes with its circle id, shows a dose ticked on another phone, and unsubscribes on unmount', async () => {
    const circleId = 'c2b00001-0000-4000-8000-0000000000c1';
    const medId = 'c2b00001-0000-4000-8000-0000000000a1';
    const doseId = 'c2b00001-0000-4000-8000-0000000000d1';
    const ownerId = 'c2b00001-0000-4000-8000-0000000000e1';
    const otherCarerId = 'c2b00001-0000-4000-8000-0000000000e2';
    const pendingRow = {
      id: doseId,
      medication_id: medId,
      circle_id: circleId,
      due_at: '2026-11-15T20:00:00.000Z',
      status: 'pending',
      acted_by: null,
      acted_at: null,
    };

    const fake = createFakeTodayClient({
      tables: {
        circles: [
          {
            id: circleId,
            name: 'Realtime Circle',
            care_recipient_name: 'Evelyn',
            care_recipient_dob: null,
            timezone: 'Europe/London',
            created_by: ownerId,
            created_at: '2026-11-01T12:00:00.000Z',
          },
        ],
        circle_members: [
          {
            circle_id: circleId,
            user_id: ownerId,
            role: 'owner',
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
            schedule: { kind: 'daily', times: ['20:00'] },
            instructions: null,
            start_date: '2026-11-01',
            end_date: null,
            active: true,
            source: 'manual',
          },
        ],
        dose_events: [{ ...pendingRow }],
        appointments: [],
        tasks: [],
      },
    });

    const channels: Array<{ name: string; filter: Record<string, unknown>; listener: Listener }> =
      [];
    const removed: string[] = [];
    const client = fake.client as unknown as Record<string, unknown>;
    client.channel = (name: string) => {
      const entry = { name, filter: {}, listener: (() => undefined) as Listener };
      channels.push(entry);
      const channel = {
        on: (_type: string, filter: Record<string, unknown>, listener: Listener) => {
          entry.filter = filter;
          entry.listener = listener;
          return channel;
        },
        subscribe: () => channel,
        __name: name,
      };
      return channel;
    };
    client.removeChannel = (channel: { __name: string }) => {
      removed.push(channel.__name);
    };

    const deps: TodayDeps = {
      getClient: () => fake.client,
      getUserId: async () => ownerId,
      storage: memoryTodayStorage,
      now: () => new Date('2026-11-15T18:00:00.000Z'),
    };

    const { unmount } = await render(
      <UI.ThemeProvider>
        <TodayScreen deps={deps} referenceNow={new Date('2026-11-15T18:00:00.000Z')} />
      </UI.ThemeProvider>,
    );

    await waitFor(() => expect(channels).toHaveLength(1));
    expect(channels[0]?.filter).toMatchObject({
      schema: 'public',
      table: 'dose_events',
      filter: `circle_id=eq.${circleId}`,
    });
    expect(screen.getByTestId(`today-dose-given-${doseId}`)).toBeTruthy();

    // Another carer ticks the dose: Realtime sends the new row (old holds only the id).
    await act(async () => {
      channels[0]?.listener({
        eventType: 'UPDATE',
        new: {
          ...pendingRow,
          status: 'given',
          acted_by: otherCarerId,
          acted_at: '2026-11-15T18:01:00.000Z',
        },
        old: { id: doseId },
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId(`today-dose-given-${doseId}`)).toBeNull();
    });
    expect(
      within(screen.getByTestId(`today-dose-status-${doseId}`)).getByText(en.today.statusGiven),
    ).toBeTruthy();

    expect(removed).toHaveLength(0);
    await act(async () => {
      unmount();
    });
    expect(removed).toEqual([channels[0]?.name]);
  });
});
