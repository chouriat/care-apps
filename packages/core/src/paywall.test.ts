type CareCircleEntitlementId = 'carecircle_family';

interface EntitlementRow {
  user_id: string;
  entitlement: CareCircleEntitlementId;
  active: boolean;
  expires_at: string | null;
}

interface EntitlementStoreAdapter {
  upsertEntitlement(row: EntitlementRow): Promise<{ error: { message: string } | null }>;
  getEntitlement(
    userId: string,
    entitlement: CareCircleEntitlementId,
  ): Promise<{ data: EntitlementRow | null; error: { message: string } | null }>;
}

interface RevenueCatSdkAdapter {
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
  processRevenueCatWebhook(input: {
    authHeader: string | null;
    expectedWebhookSecret: string;
    payload: unknown;
    store: EntitlementStoreAdapter;
    now?: Date;
  }): Promise<{
    status: number;
    ok: boolean;
    errorCode?: string;
    row?: EntitlementRow;
  }>;
  verifyServerEntitlement(input: {
    authenticatedUserId: string;
    entitlement?: CareCircleEntitlementId;
    clientClaim?: Record<string, unknown>;
    store: Pick<EntitlementStoreAdapter, 'getEntitlement'>;
    now?: Date;
  }): Promise<{ allowed: boolean; reason?: 'ENTITLEMENT_REQUIRED' | 'STORE_ERROR' }>;
  createPaywallController(deps: {
    userId: string;
    store: Pick<EntitlementStoreAdapter, 'getEntitlement' | 'upsertEntitlement'>;
    sdk: RevenueCatSdkAdapter;
    analytics?: { track(event: string, props?: Record<string, unknown>): void | Promise<void> };
    logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
    now?: () => Date;
  }): PaywallController;
}

function requirePaywallModule(): PaywallModuleContract {
  // Loaded at runtime so this tests-only PR typechecks before packages/core/paywall.ts exists.
  const mod = jest.requireActual<Partial<PaywallModuleContract>>('../paywall');
  if (
    !mod.processRevenueCatWebhook ||
    !mod.verifyServerEntitlement ||
    !mod.createPaywallController
  ) {
    throw new Error('F-5 packages/core/paywall is not implemented yet.');
  }
  return mod as PaywallModuleContract;
}

const USER_A = '11111111-1111-4111-8111-111111111111';
const WEBHOOK_SECRET = 'rc-webhook-secret-token-2026';

function createInMemoryEntitlementStore(initialRows: EntitlementRow[] = []) {
  const rows = new Map<string, EntitlementRow>();
  for (const r of initialRows) {
    rows.set(`${r.user_id}:${r.entitlement}`, r);
  }
  const store: EntitlementStoreAdapter = {
    async upsertEntitlement(row) {
      rows.set(`${row.user_id}:${row.entitlement}`, row);
      return { error: null };
    },
    async getEntitlement(userId, entitlement) {
      return { data: rows.get(`${userId}:${entitlement}`) ?? null, error: null };
    },
  };
  return { rows, store };
}

describe('F-5 Paywall on RevenueCat (@carecircle/core/paywall)', () => {
  it('sets entitlements.active = true on sandbox purchase webhook and active = false on expiration, rejecting bad auth', async () => {
    const { processRevenueCatWebhook, CARECIRCLE_FAMILY_ENTITLEMENT } = requirePaywallModule();
    expect(CARECIRCLE_FAMILY_ENTITLEMENT).toBe('carecircle_family');

    const { rows, store } = createInMemoryEntitlementStore();
    const now = new Date('2026-11-15T10:00:00.000Z');
    const futureMs = Date.parse('2026-12-15T10:00:00.000Z');

    // Forged webhook calls (missing header, wrong secret, or empty server secret) are rejected with 401.
    for (const [authHeader, expectedWebhookSecret] of [
      [null, WEBHOOK_SECRET],
      ['Bearer wrong-secret', WEBHOOK_SECRET],
      ['Bearer ', ''],
    ] as const) {
      const unauth = await processRevenueCatWebhook({
        authHeader,
        expectedWebhookSecret,
        payload: {
          event: {
            type: 'INITIAL_PURCHASE',
            app_user_id: USER_A,
            entitlement_ids: ['carecircle_family'],
            expiration_at_ms: futureMs,
          },
        },
        store,
        now,
      });
      expect(unauth.status).toBe(401);
      expect(unauth.ok).toBe(false);
    }
    expect(rows.size).toBe(0);

    // Valid INITIAL_PURCHASE webhook writes active = true for carecircle_family.
    const purchase = await processRevenueCatWebhook({
      authHeader: `Bearer ${WEBHOOK_SECRET}`,
      expectedWebhookSecret: WEBHOOK_SECRET,
      payload: {
        event: {
          type: 'INITIAL_PURCHASE',
          app_user_id: USER_A,
          entitlement_ids: ['carecircle_family'],
          expiration_at_ms: futureMs,
        },
      },
      store,
      now,
    });
    expect(purchase.status).toBe(200);
    expect(purchase.ok).toBe(true);
    expect(rows.get(`${USER_A}:carecircle_family`)).toEqual({
      user_id: USER_A,
      entitlement: 'carecircle_family',
      active: true,
      expires_at: '2026-12-15T10:00:00.000Z',
    });

    // EXPIRATION webhook flips active = false.
    const expired = await processRevenueCatWebhook({
      authHeader: `Bearer ${WEBHOOK_SECRET}`,
      expectedWebhookSecret: WEBHOOK_SECRET,
      payload: {
        event: {
          type: 'EXPIRATION',
          app_user_id: USER_A,
          entitlement_ids: ['carecircle_family'],
          expiration_at_ms: Date.parse('2026-11-15T09:00:00.000Z'),
        },
      },
      store,
      now,
    });
    expect(expired.status).toBe(200);
    expect(rows.get(`${USER_A}:carecircle_family`)?.active).toBe(false);
  });

  it('refuses a forged client claim of entitlement when the server entitlements table is inactive, expired, or errors', async () => {
    const { verifyServerEntitlement } = requirePaywallModule();
    const now = new Date('2026-11-15T10:00:00.000Z');
    const { rows, store } = createInMemoryEntitlementStore([
      {
        user_id: USER_A,
        entitlement: 'carecircle_family',
        active: false,
        expires_at: null,
      },
    ]);

    // Client claims active=true / entitlement='carecircle_family' in request payload,
    // but server table has active=false -> MUST be refused.
    const forgedAttempt = await verifyServerEntitlement({
      authenticatedUserId: USER_A,
      clientClaim: {
        entitlement: 'carecircle_family',
        active: true,
        isPro: true,
        user_id: USER_A,
      },
      store,
      now,
    });
    expect(forgedAttempt).toEqual({
      allowed: false,
      reason: 'ENTITLEMENT_REQUIRED',
    });

    // Expired row (active=true in DB, but expires_at <= now) -> MUST be refused.
    rows.set(`${USER_A}:carecircle_family`, {
      user_id: USER_A,
      entitlement: 'carecircle_family',
      active: true,
      expires_at: '2026-11-15T09:59:59.000Z',
    });
    const expiredAttempt = await verifyServerEntitlement({
      authenticatedUserId: USER_A,
      clientClaim: { entitlement: 'carecircle_family', active: true },
      store,
      now,
    });
    expect(expiredAttempt.allowed).toBe(false);

    // Store read failure fails closed (never fails open).
    const errorAttempt = await verifyServerEntitlement({
      authenticatedUserId: USER_A,
      clientClaim: { entitlement: 'carecircle_family', active: true },
      store: {
        async getEntitlement() {
          return { data: null, error: { message: 'PostgREST timeout' } };
        },
      },
      now,
    });
    expect(errorAttempt).toEqual({
      allowed: false,
      reason: 'STORE_ERROR',
    });

    // Valid active server row -> allowed.
    rows.set(`${USER_A}:carecircle_family`, {
      user_id: USER_A,
      entitlement: 'carecircle_family',
      active: true,
      expires_at: '2026-12-15T10:00:00.000Z',
    });
    const validAttempt = await verifyServerEntitlement({
      authenticatedUserId: USER_A,
      store,
      now,
    });
    expect(validAttempt).toEqual({ allowed: true });
  });

  it('unlocks carecircle_family on restorePurchases on a fresh install and tracks cc_trial_started on trial purchase', async () => {
    const { createPaywallController } = requirePaywallModule();
    const { rows, store } = createInMemoryEntitlementStore();
    const tracked: Array<{ event: string; props?: Record<string, unknown> }> = [];

    const controller = createPaywallController({
      userId: USER_A,
      store,
      sdk: {
        async purchaseFamilyPackage() {
          rows.set(`${USER_A}:carecircle_family`, {
            user_id: USER_A,
            entitlement: 'carecircle_family',
            active: true,
            expires_at: '2026-12-15T10:00:00.000Z',
          });
          return {
            entitlementActive: true,
            expiresAt: '2026-12-15T10:00:00.000Z',
            isTrial: true,
          };
        },
        async restorePurchases() {
          rows.set(`${USER_A}:carecircle_family`, {
            user_id: USER_A,
            entitlement: 'carecircle_family',
            active: true,
            expires_at: '2026-12-15T10:00:00.000Z',
          });
          return {
            entitlementActive: true,
            expiresAt: '2026-12-15T10:00:00.000Z',
          };
        },
      },
      analytics: {
        track(event, props) {
          tracked.push({ event, props });
        },
      },
    });

    // Fresh install starts inactive
    await controller.refreshEntitlement();
    expect(controller.getState().active).toBe(false);

    // Restore on fresh install unlocks the entitlement
    const restored = await controller.restorePurchases();
    expect(restored).toBe(true);
    expect(controller.getState().active).toBe(true);
    expect(controller.getState().entitlement).toBe('carecircle_family');

    // Trial purchase emits cc_trial_started without PII
    const purchased = await controller.purchase();
    expect(purchased).toBe(true);
    expect(tracked).toEqual([
      { event: 'cc_trial_started', props: { entitlement: 'carecircle_family' } },
    ]);
  });
});
