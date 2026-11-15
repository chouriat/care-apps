// Added in review (PR #21): a broken analytics call must not undo a purchase on screen.
import { createPaywallController, type RevenueCatSdkAdapter } from './paywall';

const USER_A = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-15T12:00:00.000Z');
const FUTURE = '2026-12-15T12:00:00.000Z';

function setup(track: () => void | Promise<void>) {
  const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const sdk: RevenueCatSdkAdapter = {
    async logIn() {},
    async purchaseFamilyPackage() {
      return { entitlementActive: true, expiresAt: FUTURE, isTrial: true };
    },
    async restorePurchases() {
      return { entitlementActive: false, expiresAt: null };
    },
  };
  const controller = createPaywallController({
    userId: USER_A,
    store: {
      async getEntitlement() {
        return { data: null, error: null };
      },
    },
    sdk,
    analytics: { track },
    logger: {
      warn(msg, meta) {
        warnings.push({ msg, meta });
      },
    },
    now: () => NOW,
  });
  return { controller, warnings };
}

describe('F-5 paywall controller: analytics failures (added in review)', () => {
  it('a trial purchase stays unlocked when analytics throws', async () => {
    const { controller, warnings } = setup(() => {
      throw new Error('posthog down for user someone@example.com');
    });
    await expect(controller.purchase()).resolves.toBe(true);
    expect(controller.getState()).toMatchObject({ status: 'ready', active: true, errorCode: null });
    expect(JSON.stringify(warnings)).not.toContain('example.com');
  });

  it('a trial purchase stays unlocked when analytics rejects', async () => {
    const { controller } = setup(() => Promise.reject(new Error('network')));
    await expect(controller.purchase()).resolves.toBe(true);
    expect(controller.getState()).toMatchObject({ status: 'ready', active: true, errorCode: null });
  });
});
