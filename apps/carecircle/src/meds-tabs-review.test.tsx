// Review tests for the CC-3b follow-up (PR #37): the tab bar, the "Scan a prescription" button and
// the way back from the scan screen, rendered through the real Expo Router (not a fake navigator).
import * as UI from '@carecircle/ui';
import { Stack } from 'expo-router';
import { fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { Text, View } from 'react-native';
import TabsLayout from '../app/(tabs)/_layout';
import MedsScreen from '../app/(tabs)/meds';
import MedsScanRoute from '../app/meds/scan';
import en from '../i18n/en.json';
import { createFakeTodayClient } from './__fixtures__/today-fake-client';
import type { MedsDeps } from './features/meds/api';
import type { PrescriptionScanScreenProps } from './features/meds/scan';
import { memoryTodayStorage, resetTodayState } from './features/today/api';

// The scan screen itself is tested in meds-scan-review.test.tsx. Here only its two exits matter:
// "saved" and "add by hand". The stub calls the callbacks the route gives it.
jest.mock('./features/meds/scan', () => ({
  PrescriptionScanScreen: (props: PrescriptionScanScreenProps) => {
    const { Pressable: P, Text: T, View: V } = jest.requireActual('react-native');
    return (
      <V testID="scan-stub">
        <P testID="scan-stub-save" onPress={() => props.onSaved?.({} as never)}>
          <T>save</T>
        </P>
        <P testID="scan-stub-manual" onPress={() => props.onNavigateManualEntry?.()}>
          <T>manual</T>
        </P>
      </V>
    );
  },
}));

const circleId = 'c1c00001-0000-4000-8000-000000000001';
const ownerId = 'c1000001-0000-4000-8000-00000000000a';
const viewerId = 'c1000001-0000-4000-8000-00000000000b';
const helperId = 'c1000001-0000-4000-8000-00000000000c';
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
      { circle_id: circleId, user_id: viewerId, role: 'viewer', joined_at: '2026-11-02T12:00:00Z' },
      { circle_id: circleId, user_id: helperId, role: 'helper', joined_at: '2026-11-03T12:00:00Z' },
    ],
    medications: [],
    dose_events: [],
    appointments: [],
    tasks: [],
  };
}

function setup(userId: string) {
  const tables = seedTables();
  const fake = createFakeTodayClient({ tables });
  const deps: MedsDeps = {
    getClient: () => fake.client,
    getUserId: async () => userId,
    storage: memoryTodayStorage,
    now: () => NOW,
  };
  const routes = {
    _layout: () => <Stack screenOptions={{ headerShown: false }} />,
    '(tabs)/_layout': TabsLayout,
    '(tabs)/today': () => (
      <View testID="today-stub">
        <Text>today</Text>
      </View>
    ),
    '(tabs)/meds': () => <MedsScreen deps={deps} />,
    '(tabs)/calendar': () => (
      <View testID="calendar-stub">
        <Text>calendar</Text>
      </View>
    ),
    'meds/scan': () => <MedsScanRoute />,
  };
  return { tables, routes };
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <UI.ThemeProvider>{children}</UI.ThemeProvider>
);

function addScannedMedicine(tables: ReturnType<typeof seedTables>) {
  tables.medications!.push({
    id: 'c1200001-0000-4000-8000-0000000000aa',
    circle_id: circleId,
    name: 'Amoxicillin',
    strength: '250 mg',
    dose_text: '1 capsule',
    schedule: { kind: 'daily', times: ['08:00'] },
    instructions: null,
    start_date: '2026-11-15',
    end_date: null,
    active: true,
    source: 'photo',
  });
}

// The routes in the app's root Stack, bottom to top (the tabs, the scan screen, ...).
function rootRouteNames(r: { getRouterState(): unknown }): string[] {
  type State = { routes: Array<{ name: string; state?: State }> };
  let state = r.getRouterState() as State | undefined;
  // The test router wraps the app's Stack in a "__root" route.
  while (state?.routes.length === 1 && state.routes[0]?.name === '__root') {
    state = state.routes[0].state;
  }
  return (state?.routes ?? []).map((route) => route.name);
}

beforeEach(() => {
  resetTodayState();
  delete process.env.MOCKS;
  delete process.env.EXPO_PUBLIC_MOCKS;
});

describe('CC-3b follow-up: tab bar, scan button and the way back (PR #37 review)', () => {
  it('opens on Today with exactly two tabs, Today and Medications, and the Meds tab opens Meds', async () => {
    const { routes } = setup(ownerId);
    await renderRouter(routes, { initialUrl: '/today', wrapper });

    expect(screen.getByTestId('today-stub')).toBeTruthy();
    expect(within(screen.getByTestId('tab-today')).getByText(en.today.title)).toBeTruthy();
    expect(within(screen.getByTestId('tab-meds')).getByText(en.meds.title)).toBeTruthy();
    expect(within(screen.getByTestId('tab-calendar')).getByText(en.calendar.title)).toBeTruthy();
    expect(screen.queryAllByTestId(/^tab-/)).toHaveLength(3);

    await fireEvent.press(screen.getByTestId('tab-meds'));
    await waitFor(() => expect(screen.getByTestId('meds-screen')).toBeTruthy());
    expect(screen).toHavePathname('/meds');
  });

  it('owner: Scan a prescription opens /meds/scan; after a save it goes back to the same Meds tab, which shows the new medicine', async () => {
    const { tables, routes } = setup(ownerId);
    const r = await renderRouter(routes, { initialUrl: '/meds', wrapper });

    await waitFor(() => expect(screen.getByTestId('meds-empty-state')).toBeTruthy());
    await fireEvent.press(within(screen.getByTestId('meds-scan-button')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('scan-stub')).toBeTruthy());
    expect(screen).toHavePathname('/meds/scan');

    addScannedMedicine(tables);
    await fireEvent.press(screen.getByTestId('scan-stub-save'));

    await waitFor(() => expect(screen.getByText('Amoxicillin (250 mg)')).toBeTruthy());
    expect(screen).toHavePathname('/meds');
    // Went back instead of stacking a second copy of the tabs on top of the first one.
    expect(rootRouteNames(r)).toEqual(['(tabs)']);
  });

  it('owner: "add by hand" on the scan screen goes back to Meds without a second copy of the tabs', async () => {
    const { routes } = setup(ownerId);
    const r = await renderRouter(routes, { initialUrl: '/meds', wrapper });

    await waitFor(() => expect(screen.getByTestId('meds-scan-button')).toBeTruthy());
    await fireEvent.press(within(screen.getByTestId('meds-scan-button')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('scan-stub')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('scan-stub-manual'));

    await waitFor(() => expect(screen.getByTestId('meds-screen')).toBeTruthy());
    expect(screen).toHavePathname('/meds');
    expect(rootRouteNames(r)).toEqual(['(tabs)']);
  });

  it('scan opened from a link with nothing underneath: a save opens Meds', async () => {
    const { tables, routes } = setup(ownerId);
    await renderRouter(routes, { initialUrl: '/meds/scan', wrapper });

    await waitFor(() => expect(screen.getByTestId('scan-stub')).toBeTruthy());
    addScannedMedicine(tables);
    await fireEvent.press(screen.getByTestId('scan-stub-save'));

    await waitFor(() => expect(screen.getByText('Amoxicillin (250 mg)')).toBeTruthy());
    expect(screen).toHavePathname('/meds');
  });

  it('helper sees Scan a prescription; viewer does not', async () => {
    const helper = setup(helperId);
    const first = await renderRouter(helper.routes, { initialUrl: '/meds', wrapper });
    await waitFor(() => expect(screen.getByTestId('meds-empty-state')).toBeTruthy());
    expect(screen.getByTestId('meds-scan-button')).toBeTruthy();
    expect(within(screen.getByTestId('meds-scan-button')).getByText(en.meds.scanCta)).toBeTruthy();
    first.unmount();

    const viewer = setup(viewerId);
    await renderRouter(viewer.routes, { initialUrl: '/meds', wrapper });
    await waitFor(() => expect(screen.getByTestId('meds-empty-state')).toBeTruthy());
    expect(screen.queryByTestId('meds-scan-button')).toBeNull();
    expect(screen.queryByTestId('meds-add-button')).toBeNull();
  });
});
