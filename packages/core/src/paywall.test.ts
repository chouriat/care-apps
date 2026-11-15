// F-5 [safety], app side. The webhook and the server check live in Edge Functions (Deno) and are tested
// in supabase/carecircle/functions/revenuecat-webhook/index_test.ts and
// supabase/carecircle/functions/_shared/entitlements_test.ts. This file covers only what the phone does.
//
// The phone never writes `entitlements` (RLS forbids it, see entitlements_rls.test.sql), so the
// controller gets a read-only store. What the phone shows is a convenience; the server decides access.

type CareCircleEntitlementId = 'carecircle_family';

interface EntitlementRow {
  user_id: string;
  entitlement: CareCircleEntitlementId;
  active: boolean;
  expires_at: string | null;
}

interface EntitlementReadStore {
  getEntitlement(
    userId: string,
    entitlement: CareCircleEntitlementId,
  ): Promise<{ data: EntitlementRow | null; error: { message: string } | null }>;
}

// Thin wrapper over react-native-purchases. purchaseFamilyPackage and restorePurchases throw on
// failure; a purchase the user cancels throws an error with `userCancelled: true`, as the SDK does.
interface RevenueCatSdkAdapter {
  logIn(appUserId: string): Promise<void>;
  purchaseFamilyPackage(): Promise<{
    entitlementActive: boolean;
    expiresAt: string | null;
    isTrial?: boolean;
  }>;
  restorePurchases(): Promise<{
    entitlementActive: boolean;
    expiresAt: string | null;
  }>;
}

interface PaywallState {
  status: 'loading' | 'ready' | 'error';
  entitlement: CareCircleEntitlementId;
  active: boolean;
  expiresAt: string | null;
  errorCode: string | null;
}

interface PaywallController {
  getState(): PaywallState;
  subscribe(listener: (state: PaywallState) => void): () => void;
  refreshEntitlement(): Promise<boolean>;
  purchase(): Promise<boolean>;
  restorePurchases(): Promise<boolean>;
}

interface PaywallModuleContract {
  CARECIRCLE_FAMILY_ENTITLEMENT: CareCircleEntitlementId;
  createPaywallController(deps: {
    userId: string;
    store: EntitlementReadStore;
    sdk: RevenueCatSdkAdapter;
    analytics?: { track(event: string, props?: Record<string, unknown>): void | Promise<void> };
    logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
    now?: () => Date;
  }): PaywallController;
}

function requirePaywallModule(): PaywallModuleContract {
  // Loaded at runtime so this tests-only PR typechecks before packages/core/paywall.ts exists.
  const mod = jest.requireActual<Partial<PaywallModuleContract>>('../paywall');
  if (!mod.createPaywallController || !mod.CARECIRCLE_FAMILY_ENTITLEMENT) {
    throw new Error('F-5 packages/core/paywall is not implemented yet.');
  }
  return mod as PaywallModuleContract;
}

const USER_A = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-15T10:00:00.000Z');
const FUTURE = '2026-12-15T10:00:00.000Z';

function readStore(initial: EntitlementRow | null = null) {
  let row = initial;
  let fail: 'error' | 'throw' | null = null;
  const lookups: string[] = [];
  const store: EntitlementReadStore = {
    async getEntitlement(userId, entitlement) {
      lookups.push(`${userId}:${entitlement}`);
      if (fail === 'throw') throw new Error('network down');
      if (fail === 'error') return { data: null, error: { message: 'PostgREST timeout' } };
      return { data: row && row.user_id === userId ? row : null, error: null };
    },
  };
  return {
    store,
    lookups,
    set(r: EntitlementRow | null) {
      row = r;
    },
    fail(mode: 'error' | 'throw' | null) {
      fail = mode;
    },
  };
}

const activeRow = (expires_at: string | null = FUTURE): EntitlementRow => ({
  user_id: USER_A,
  entitlement: 'carecircle_family',
  active: true,
  expires_at,
});

function cancelledError() {
  return Object.assign(new Error('Purchase was cancelled.'), { userCancelled: true });
}

function setup(
  opts: {
    row?: EntitlementRow | null;
    purchase?: () => Promise<{
      entitlementActive: boolean;
      expiresAt: string | null;
      isTrial?: boolean;
    }>;
    restore?: () => Promise<{ entitlementActive: boolean; expiresAt: string | null }>;
  } = {},
) {
  const { createPaywallController } = requirePaywallModule();
  const db = readStore(opts.row ?? null);
  const order: string[] = [];
  const tracked: Array<{ event: string; props?: Record<string, unknown> }> = [];
  const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const sdk: RevenueCatSdkAdapter = {
    async logIn(appUserId) {
      order.push(`logIn:${appUserId}`);
    },
    async purchaseFamilyPackage() {
      order.push('purchase');
      return opts.purchase
        ? opts.purchase()
        : { entitlementActive: true, expiresAt: FUTURE, isTrial: true };
    },
    async restorePurchases() {
      order.push('restore');
      return opts.restore ? opts.restore() : { entitlementActive: true, expiresAt: FUTURE };
    },
  };
  const controller = createPaywallController({
    userId: USER_A,
    store: db.store,
    sdk,
    analytics: {
      track(event, props) {
        tracked.push({ event, props });
      },
    },
    logger: {
      warn(msg, meta) {
        warnings.push({ msg, meta });
      },
    },
    now: () => NOW,
  });
  return { controller, db, order, tracked, warnings };
}

describe('F-5 Paywall on RevenueCat, app side (@carecircle/core/paywall)', () => {
  it('exports the spec entitlement id', () => {
    expect(requirePaywallModule().CARECIRCLE_FAMILY_ENTITLEMENT).toBe('carecircle_family');
  });

  it('refreshEntitlement reads the server row for the signed-in user and respects expiry', async () => {
    const { controller, db } = setup();

    expect(await controller.refreshEntitlement()).toBe(false);
    expect(controller.getState()).toEqual({
      status: 'ready',
      entitlement: 'carecircle_family',
      active: false,
      expiresAt: null,
      errorCode: null,
    });
    expect(db.lookups).toEqual([`${USER_A}:carecircle_family`]);

    db.set(activeRow());
    expect(await controller.refreshEntitlement()).toBe(true);
    expect(controller.getState()).toMatchObject({ active: true, expiresAt: FUTURE });

    // active = true but the period ended: not active.
    db.set(activeRow('2026-11-15T10:00:00.000Z'));
    expect(await controller.refreshEntitlement()).toBe(false);
    expect(controller.getState().active).toBe(false);

    db.set({ ...activeRow(), active: false });
    expect(await controller.refreshEntitlement()).toBe(false);
    expect(controller.getState().active).toBe(false);
  });

  it('a failed refresh shows an error but does not take away access the user already had', async () => {
    const { controller, db } = setup({ row: activeRow() });
    await controller.refreshEntitlement();
    expect(controller.getState().active).toBe(true);

    for (const mode of ['error', 'throw'] as const) {
      db.fail(mode);
      await expect(controller.refreshEntitlement()).resolves.toBe(true);
      expect(controller.getState()).toMatchObject({ status: 'error', active: true });
      expect(controller.getState().errorCode).toEqual(expect.stringMatching(/\S/));
    }

    // Recovers on the next good read and clears the error.
    db.fail(null);
    await controller.refreshEntitlement();
    expect(controller.getState()).toMatchObject({ status: 'ready', active: true, errorCode: null });
  });

  it('restore on a fresh install logs in to RevenueCat as this user first, then unlocks', async () => {
    // The webhook has not reached the server yet: the server row is still empty.
    const { controller, order } = setup();
    await controller.refreshEntitlement();
    expect(controller.getState().active).toBe(false);

    expect(await controller.restorePurchases()).toBe(true);
    expect(order).toEqual([`logIn:${USER_A}`, 'restore']);
    expect(controller.getState()).toMatchObject({
      status: 'ready',
      entitlement: 'carecircle_family',
      active: true,
      expiresAt: FUTURE,
      errorCode: null,
    });
  });

  it('restore that finds nothing is not an error and does not unlock', async () => {
    const { controller } = setup({
      restore: async () => ({ entitlementActive: false, expiresAt: null }),
    });
    expect(await controller.restorePurchases()).toBe(false);
    expect(controller.getState()).toMatchObject({
      status: 'ready',
      active: false,
      errorCode: null,
    });
  });

  it('a failed restore shows an error and keeps current access', async () => {
    const { controller } = setup({
      row: activeRow(),
      restore: async () => {
        throw new Error('store unavailable');
      },
    });
    await controller.refreshEntitlement();
    expect(await controller.restorePurchases()).toBe(false);
    expect(controller.getState()).toMatchObject({ status: 'error', active: true });
    expect(controller.getState().errorCode).toEqual(expect.stringMatching(/\S/));
  });

  it('a trial purchase logs in first, unlocks and sends cc_trial_started with no personal data', async () => {
    const { controller, order, tracked } = setup();
    expect(await controller.purchase()).toBe(true);
    expect(order).toEqual([`logIn:${USER_A}`, 'purchase']);
    expect(controller.getState()).toMatchObject({ status: 'ready', active: true, errorCode: null });
    expect(tracked).toEqual([
      { event: 'cc_trial_started', props: { entitlement: 'carecircle_family' } },
    ]);
  });

  it('a paid purchase without a trial does not send cc_trial_started', async () => {
    const { controller, tracked } = setup({
      purchase: async () => ({ entitlementActive: true, expiresAt: FUTURE, isTrial: false }),
    });
    expect(await controller.purchase()).toBe(true);
    expect(controller.getState().active).toBe(true);
    expect(tracked.filter((t) => t.event === 'cc_trial_started')).toEqual([]);
  });

  it('a cancelled purchase is quiet: no error, no event, nothing unlocked', async () => {
    const { controller, tracked } = setup({
      purchase: async () => {
        throw cancelledError();
      },
    });
    await controller.refreshEntitlement();
    expect(await controller.purchase()).toBe(false);
    expect(controller.getState()).toMatchObject({
      status: 'ready',
      active: false,
      errorCode: null,
    });
    expect(tracked).toEqual([]);
  });

  it('a failed purchase shows an error, sends no event and does not remove existing access', async () => {
    const { controller, tracked } = setup({
      row: activeRow(),
      purchase: async () => {
        throw new Error('STORE_PROBLEM');
      },
    });
    await controller.refreshEntitlement();
    expect(await controller.purchase()).toBe(false);
    expect(controller.getState()).toMatchObject({ status: 'error', active: true });
    expect(controller.getState().errorCode).toEqual(expect.stringMatching(/\S/));
    expect(tracked).toEqual([]);
  });

  it('a purchase the store reports as not active does not unlock or send the trial event', async () => {
    const { controller, tracked } = setup({
      purchase: async () => ({ entitlementActive: false, expiresAt: null, isTrial: true }),
    });
    expect(await controller.purchase()).toBe(false);
    expect(controller.getState().active).toBe(false);
    expect(tracked).toEqual([]);
  });

  it('notifies subscribers and stops after unsubscribe', async () => {
    const { controller } = setup();
    const seen: boolean[] = [];
    const unsubscribe = controller.subscribe((s) => seen.push(s.active));
    await controller.restorePurchases();
    expect(seen[seen.length - 1]).toBe(true);
    const count = seen.length;
    unsubscribe();
    await controller.refreshEntitlement();
    expect(seen.length).toBe(count);
  });

  it('never puts the user id or raw error text in logs', async () => {
    const { controller, warnings } = setup({
      purchase: async () => {
        throw new Error(`receipt for ${USER_A} rejected`);
      },
    });
    await controller.purchase();
    expect(JSON.stringify(warnings)).not.toContain(USER_A);
  });
});
