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
