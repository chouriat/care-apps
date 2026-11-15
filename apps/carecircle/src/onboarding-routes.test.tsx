// Review tests for PR #26 (CC-1a): the routes around create_circle, with the real
// createCircleViaRpc and a fake Supabase client that answers like PostgREST.
import * as UI from '@carecircle/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import HomeScreen from '../app/index';
import OnboardingStartRoute from '../app/(onboarding)/start';
import en from '../i18n/en.json';

const mockReplace = jest.fn();
const mockRpc = jest.fn();
const mockCirclesQuery = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock('./features/auth/api', () => ({
  getSupabaseClient: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => ({
      select: () => ({ limit: () => mockCirclesQuery() }),
    }),
  }),
}));

jest.mock('./features/observability/api', () => ({
  getAppObservability: () => ({
    analytics: { track: jest.fn().mockResolvedValue(undefined) },
  }),
}));

jest.mock('./features/mocks', () => ({ loadCareCircleMocks: () => null }));

// Exactly what PostgREST returns for `returns public.circles`: one snake_case row object,
// with Postgres's own timestamp format.
const createdRow = {
  id: 'c1c00001-0000-4000-8000-000000000001',
  name: 'Family Care',
  care_recipient_name: 'Evelyn',
  care_recipient_dob: null,
  timezone: 'Europe/Paris',
  created_by: 'c1000001-1111-4111-8111-111111111111',
  created_at: '2026-11-15T20:41:25.123456+00:00',
};

async function fillAndSubmit() {
  await render(
    <UI.ThemeProvider>
      <OnboardingStartRoute />
    </UI.ThemeProvider>,
  );
  await fireEvent.changeText(screen.getByTestId('onboarding-circle-name-input'), 'Family Care');
  await fireEvent.changeText(screen.getByTestId('onboarding-recipient-name-input'), 'Evelyn');
  await fireEvent.changeText(screen.getByTestId('onboarding-timezone-input'), 'Europe/Paris');
  await fireEvent.press(screen.getByText(en.onboarding.submitCreate));
}

describe('PR #26 review: /(onboarding)/start route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('opens Today after create_circle returns the new circle row', async () => {
    mockRpc.mockResolvedValue({ data: createdRow, error: null });
    await fillAndSubmit();
    expect(mockRpc).toHaveBeenCalledWith('create_circle', {
      name: 'Family Care',
      careRecipientName: 'Evelyn',
      timezone: 'Europe/Paris',
    });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/today'));
  });

  it('opens Today instead of a dead end when the account already owns a circle', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'CIRCLE_LIMIT_REACHED', code: 'P0001' },
    });
    await fillAndSubmit();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/today'));
  });

  it('shows the error state, not the limit message, for another database error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'Circle name must not be empty', code: 'P0001' },
    });
    await fillAndSubmit();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(await screen.findByTestId('onboarding-error')).toBeTruthy();
    expect(screen.queryByText(en.onboarding.limitReachedMessage)).toBeNull();
  });
});

describe('PR #26 review: home screen redirect', () => {
  const originalKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCirclesQuery.mockReset();
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  });

  afterAll(() => {
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = originalKey;
  });

  async function renderHome() {
    await render(
      <UI.ThemeProvider>
        <HomeScreen />
      </UI.ThemeProvider>,
    );
  }

  it('sends a member of a circle to Today', async () => {
    mockCirclesQuery.mockResolvedValue({ data: [{ id: createdRow.id }], error: null });
    await renderHome();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/today'));
  });

  it('sends someone with no circle to onboarding', async () => {
    mockCirclesQuery.mockResolvedValue({ data: [], error: null });
    await renderHome();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(onboarding)/start'));
  });

  it('shows a retry instead of onboarding when the circles query fails', async () => {
    mockCirclesQuery.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } });
    await renderHome();
    expect(await screen.findByTestId('home-load-error')).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();

    mockCirclesQuery.mockResolvedValueOnce({ data: [{ id: createdRow.id }], error: null });
    await fireEvent.press(screen.getByText(en.home.retry));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/today'));
  });
});
