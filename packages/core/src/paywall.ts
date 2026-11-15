import { validateAnalyticsEvent } from './analytics';

export type CareCircleEntitlementId = 'carecircle_family';
export const CARECIRCLE_FAMILY_ENTITLEMENT: CareCircleEntitlementId = 'carecircle_family';

export interface EntitlementRow {
  user_id: string;
  entitlement: CareCircleEntitlementId;
  active: boolean;
  expires_at: string | null;
}

export interface EntitlementReadStore {
  getEntitlement(
    userId: string,
    entitlement: CareCircleEntitlementId,
  ): Promise<{ data: EntitlementRow | null; error: { message: string } | null }>;
}

export interface RevenueCatSdkAdapter {
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

export interface PaywallState {
  status: 'loading' | 'ready' | 'error';
  entitlement: CareCircleEntitlementId;
  active: boolean;
  expiresAt: string | null;
  errorCode: string | null;
}

export interface PaywallController {
  getState(): PaywallState;
  subscribe(listener: (state: PaywallState) => void): () => void;
  refreshEntitlement(): Promise<boolean>;
  purchase(): Promise<boolean>;
  restorePurchases(): Promise<boolean>;
}

export interface PaywallAnalytics {
  track(event: string, props?: Record<string, unknown>): void | Promise<void>;
}

export interface PaywallLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface PaywallControllerDeps {
  userId: string;
  store: EntitlementReadStore;
  sdk: RevenueCatSdkAdapter;
  analytics?: PaywallAnalytics;
  logger?: PaywallLogger;
  now?: () => Date;
}

function isFutureOrNullExpiry(expiresAt: string | null, nowMs: number): boolean {
  if (expiresAt === null) {
    return true;
  }
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) {
    return false;
  }
  return expiresMs > nowMs;
}

function isUserCancelledError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  return (err as { userCancelled?: unknown }).userCancelled === true;
}

export function createPaywallController(deps: PaywallControllerDeps): PaywallController {
  const nowFn = deps.now ?? (() => new Date());
  const listeners = new Set<(state: PaywallState) => void>();

  let state: PaywallState = {
    status: 'loading',
    entitlement: CARECIRCLE_FAMILY_ENTITLEMENT,
    active: false,
    expiresAt: null,
    errorCode: null,
  };

  function notify(): void {
    const snapshot: PaywallState = { ...state };
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  return {
    getState(): PaywallState {
      return { ...state };
    },

    subscribe(listener: (state: PaywallState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async refreshEntitlement(): Promise<boolean> {
      try {
        const result = await deps.store.getEntitlement(deps.userId, CARECIRCLE_FAMILY_ENTITLEMENT);
        if (result.error !== null) {
          state = {
            ...state,
            status: 'error',
            errorCode: 'ENTITLEMENT_REFRESH_FAILED',
          };
          deps.logger?.warn('paywall_refresh_failed', { code: 'ENTITLEMENT_REFRESH_FAILED' });
          notify();
          return state.active;
        }

        const row = result.data;
        const nowMs = nowFn().getTime();
        const isActive =
          row !== null &&
          row.user_id === deps.userId &&
          row.entitlement === CARECIRCLE_FAMILY_ENTITLEMENT &&
          row.active === true &&
          isFutureOrNullExpiry(row.expires_at, nowMs);

        state = {
          status: 'ready',
          entitlement: CARECIRCLE_FAMILY_ENTITLEMENT,
          active: isActive,
          expiresAt: row?.expires_at ?? null,
          errorCode: null,
        };
        notify();
        return isActive;
      } catch {
        state = {
          ...state,
          status: 'error',
          errorCode: 'ENTITLEMENT_REFRESH_FAILED',
        };
        deps.logger?.warn('paywall_refresh_failed', { code: 'ENTITLEMENT_REFRESH_FAILED' });
        notify();
        return state.active;
      }
    },

    async restorePurchases(): Promise<boolean> {
      try {
        await deps.sdk.logIn(deps.userId);
        const restored = await deps.sdk.restorePurchases();
        const nowMs = nowFn().getTime();
        const isActive =
          restored.entitlementActive === true && isFutureOrNullExpiry(restored.expiresAt, nowMs);

        state = {
          status: 'ready',
          entitlement: CARECIRCLE_FAMILY_ENTITLEMENT,
          active: isActive,
          expiresAt: isActive ? restored.expiresAt : null,
          errorCode: null,
        };
        notify();
        return isActive;
      } catch {
        state = {
          ...state,
          status: 'error',
          errorCode: 'RESTORE_FAILED',
        };
        deps.logger?.warn('paywall_restore_failed', { code: 'RESTORE_FAILED' });
        notify();
        return false;
      }
    },

    async purchase(): Promise<boolean> {
      try {
        await deps.sdk.logIn(deps.userId);
        const purchased = await deps.sdk.purchaseFamilyPackage();
        const nowMs = nowFn().getTime();
        const isActive =
          purchased.entitlementActive === true && isFutureOrNullExpiry(purchased.expiresAt, nowMs);

        state = {
          status: 'ready',
          entitlement: CARECIRCLE_FAMILY_ENTITLEMENT,
          active: isActive,
          expiresAt: isActive ? purchased.expiresAt : null,
          errorCode: null,
        };

        if (isActive && purchased.isTrial === true) {
          const props = validateAnalyticsEvent('cc_trial_started', {
            entitlement: CARECIRCLE_FAMILY_ENTITLEMENT,
          });
          await deps.analytics?.track('cc_trial_started', props);
        }

        notify();
        return isActive;
      } catch (err) {
        if (isUserCancelledError(err)) {
          state = {
            ...state,
            status: 'ready',
            errorCode: null,
          };
          notify();
          return false;
        }

        state = {
          ...state,
          status: 'error',
          errorCode: 'PURCHASE_FAILED',
        };
        deps.logger?.warn('paywall_purchase_failed', { code: 'PURCHASE_FAILED' });
        notify();
        return false;
      }
    },
  };
}
