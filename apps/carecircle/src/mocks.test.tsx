import { render, screen } from '@testing-library/react-native';
import PlaceholderScreen from '../app/index';

interface MocksFeatureContract {
  isMocksEnabled: (env?: Record<string, string | undefined>) => boolean;
  loadCareCircleMocks: (env?: Record<string, string | undefined>) => {
    circle: { id: string; name: string; careRecipientName: string; timezone: string };
    members: Array<{ circleId: string; userId: string; role: string }>;
    medications: Array<{ id: string; circleId: string; name: string; schedule: { kind: string } }>;
    doseEvents: Array<{ id: string; medicationId: string; circleId: string; dueAt: string }>;
    appointments: Array<{ id: string; circleId: string; title: string }>;
    tasks: Array<{ id: string; circleId: string; title: string }>;
    aiResponses: {
      extractPrescription: { name: string };
      summarizeVisit: { summary: string };
    };
  } | null;
}

function requireMocksFeature(): MocksFeatureContract {
  return jest.requireActual<MocksFeatureContract>('./features/mocks');
}

describe('CC-0 MOCKS=1 app loader (apps/carecircle)', () => {
  const originalMocks = process.env.MOCKS;
  const originalExpoPublicMocks = process.env.EXPO_PUBLIC_MOCKS;

  afterEach(() => {
    if (originalMocks === undefined) {
      delete process.env.MOCKS;
    } else {
      process.env.MOCKS = originalMocks;
    }
    if (originalExpoPublicMocks === undefined) {
      delete process.env.EXPO_PUBLIC_MOCKS;
    } else {
      process.env.EXPO_PUBLIC_MOCKS = originalExpoPublicMocks;
    }
  });

  it('returns null when MOCKS flag is unset or 0, and loads full C1/C2 fixture when MOCKS=1', () => {
    const { isMocksEnabled, loadCareCircleMocks } = requireMocksFeature();

    expect(isMocksEnabled({})).toBe(false);
    expect(isMocksEnabled({ MOCKS: '0' })).toBe(false);
    expect(loadCareCircleMocks({})).toBeNull();

    expect(isMocksEnabled({ MOCKS: '1' })).toBe(true);
    expect(isMocksEnabled({ EXPO_PUBLIC_MOCKS: '1' })).toBe(true);

    const mocks = loadCareCircleMocks({ MOCKS: '1' });
    expect(mocks).not.toBeNull();
    expect(mocks?.circle.name).toEqual(expect.stringMatching(/\S/));
    expect(mocks?.members).toHaveLength(3);
    expect(mocks?.medications).toHaveLength(4);
    expect(mocks?.appointments).toHaveLength(3);
    expect(mocks?.tasks).toHaveLength(5);

    const distinctDays = new Set(mocks?.doseEvents.map((e) => e.dueAt.slice(0, 10)));
    expect(distinctDays.size).toBe(7);

    expect(mocks?.aiResponses.extractPrescription.name).toBe('Metformin');
    expect(mocks?.aiResponses.summarizeVisit.summary).toEqual(expect.stringMatching(/\S/));
  });

  it('renders mock circle indicator in the app when MOCKS=1 is set', async () => {
    requireMocksFeature();
    process.env.MOCKS = '1';

    await render(<PlaceholderScreen />);
    expect(screen.getByTestId('mocks-loaded')).toBeTruthy();
  });
});

// Added in review: the flag must be exactly "1", the indicator must stay away without it,
// Expo only bundles EXPO_PUBLIC_ variables into the app, and the fake AI answers must match C2.
describe('CC-0 MOCKS flag, more cases (added in review)', () => {
  const saved = { MOCKS: process.env.MOCKS, EXPO_PUBLIC_MOCKS: process.env.EXPO_PUBLIC_MOCKS };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('only the exact value "1" turns mocks on', () => {
    const { isMocksEnabled, loadCareCircleMocks } = requireMocksFeature();
    for (const value of ['', 'true', 'yes', '01', ' 1', 'false']) {
      expect({ value, on: isMocksEnabled({ MOCKS: value }) }).toEqual({ value, on: false });
      expect({ value, on: isMocksEnabled({ EXPO_PUBLIC_MOCKS: value }) }).toEqual({
        value,
        on: false,
      });
    }
    expect(loadCareCircleMocks({ MOCKS: 'true' })).toBeNull();
  });

  it('without the flag the app shows no mock data', async () => {
    requireMocksFeature();
    delete process.env.MOCKS;
    delete process.env.EXPO_PUBLIC_MOCKS;
    await render(<PlaceholderScreen />);
    expect(screen.queryByTestId('mocks-loaded')).toBeNull();
  });

  it('EXPO_PUBLIC_MOCKS=1 (the variable Expo puts in the app bundle) turns mocks on in the app', async () => {
    requireMocksFeature();
    delete process.env.MOCKS;
    process.env.EXPO_PUBLIC_MOCKS = '1';
    await render(<PlaceholderScreen />);
    expect(screen.getByTestId('mocks-loaded')).toBeTruthy();
  });

  it('the fake AI answers in the mocks pass the C2 schemas, and the mock rows pass the C1 schemas', () => {
    const { loadCareCircleMocks } = requireMocksFeature();
    const mocks = loadCareCircleMocks({ MOCKS: '1' });
    const rx = jest.requireActual<{
      extractPrescriptionOutputSchema: { safeParse(v: unknown): { success: boolean } };
    }>('@carecircle/ai-gateway/schemas/carecircle/extractPrescription');
    const visit = jest.requireActual<{
      summarizeVisitOutputSchema: { safeParse(v: unknown): { success: boolean } };
    }>('@carecircle/ai-gateway/schemas/carecircle/summarizeVisit');
    expect(
      rx.extractPrescriptionOutputSchema.safeParse(mocks?.aiResponses.extractPrescription).success,
    ).toBe(true);
    expect(
      visit.summarizeVisitOutputSchema.safeParse(mocks?.aiResponses.summarizeVisit).success,
    ).toBe(true);
  });
});
