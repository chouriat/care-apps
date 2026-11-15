// Added in review (PR #21): the RevenueCat SDK follows the Supabase user, and sign-out never
// waits on RevenueCat for long.
import {
  REVENUECAT_SIGN_OUT_TIMEOUT_MS,
  resetPaywallControllersForTests,
  syncRevenueCatAuthUser,
} from './features/paywall/api';

// jest.mock calls are hoisted above the import by babel-jest.
const mockPurchases = {
  configure: jest.fn(),
  logIn: jest.fn(async () => ({ customerInfo: {}, created: false })),
  logOut: jest.fn(async () => ({})),
};
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  // A getter, because the import above runs before `mockPurchases` is set.
  get default() {
    return mockPurchases;
  },
}));

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

describe('F-5 RevenueCat SDK wiring (added in review)', () => {
  const originalKey = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;

  beforeEach(() => {
    resetPaywallControllersForTests();
    jest.clearAllMocks();
    process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = 'appl_test_public_key';
  });

  afterAll(() => {
    process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = originalKey;
  });

  it('configures with the Supabase user id, switches users with logIn and logs out on sign-out', async () => {
    await syncRevenueCatAuthUser(USER_A);
    expect(mockPurchases.configure).toHaveBeenCalledWith({
      apiKey: 'appl_test_public_key',
      appUserID: USER_A,
    });
    await syncRevenueCatAuthUser(USER_A);
    expect(mockPurchases.logIn).not.toHaveBeenCalled();

    await syncRevenueCatAuthUser(null);
    expect(mockPurchases.logOut).toHaveBeenCalledTimes(1);

    await syncRevenueCatAuthUser(USER_B);
    expect(mockPurchases.configure).toHaveBeenCalledTimes(1);
    expect(mockPurchases.logIn).toHaveBeenCalledWith(USER_B);
  });

  it('does nothing without a public key', async () => {
    delete process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
    await syncRevenueCatAuthUser(USER_A);
    expect(mockPurchases.configure).not.toHaveBeenCalled();
  });

  it('sign-out goes ahead when logOut throws (anonymous user)', async () => {
    await syncRevenueCatAuthUser(USER_A);
    mockPurchases.logOut.mockRejectedValueOnce(
      new Error('LogOut was called but the current user is anonymous'),
    );
    await expect(syncRevenueCatAuthUser(null)).resolves.toBeUndefined();
  });

  it('sign-out does not hang when logOut never answers', async () => {
    await syncRevenueCatAuthUser(USER_A);
    jest.useFakeTimers();
    try {
      mockPurchases.logOut.mockImplementationOnce(() => new Promise(() => {}));
      let done = false;
      const signOut = syncRevenueCatAuthUser(null).then(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(REVENUECAT_SIGN_OUT_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await signOut;
      expect(done).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
