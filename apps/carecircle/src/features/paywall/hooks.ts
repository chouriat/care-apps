import {
  CARECIRCLE_FAMILY_ENTITLEMENT,
  type CareCircleEntitlementId,
  type PaywallState,
} from '@carecircle/core';
import { useCallback, useEffect, useState } from 'react';
import { useAuthController } from '../auth/hooks';
import { getAppPaywallController, syncRevenueCatAuthUser } from './api';

export interface UseEntitlementResult {
  active: boolean;
  status: 'loading' | 'ready' | 'error';
  expiresAt: string | null;
  purchase: () => Promise<boolean>;
  restorePurchases: () => Promise<boolean>;
  refresh: () => Promise<boolean>;
}

const SIGNED_OUT_STATE: PaywallState = {
  status: 'ready',
  entitlement: CARECIRCLE_FAMILY_ENTITLEMENT,
  active: false,
  expiresAt: null,
  errorCode: null,
};

export function useEntitlement(entitlementId: CareCircleEntitlementId): UseEntitlementResult {
  const { state: authState } = useAuthController();
  const userId =
    authState.status === 'authenticated' ? (authState.session?.user?.id ?? null) : null;

  const [paywallState, setPaywallState] = useState<PaywallState>(() =>
    userId ? getAppPaywallController(userId).getState() : SIGNED_OUT_STATE,
  );

  useEffect(() => {
    if (!userId || entitlementId !== CARECIRCLE_FAMILY_ENTITLEMENT) {
      if (!userId) {
        void syncRevenueCatAuthUser(null);
      }
      setPaywallState(SIGNED_OUT_STATE);
      return;
    }

    void syncRevenueCatAuthUser(userId).catch(() => {
      // Unconfigured keys in dev/tests are surfaced when purchase/restore is invoked.
    });
    const controller = getAppPaywallController(userId);
    setPaywallState(controller.getState());
    const unsubscribe = controller.subscribe((next) => {
      setPaywallState(next);
    });
    void controller.refreshEntitlement();

    return unsubscribe;
  }, [userId, entitlementId]);

  const purchase = useCallback(async (): Promise<boolean> => {
    if (!userId) return false;
    return getAppPaywallController(userId).purchase();
  }, [userId]);

  const restorePurchases = useCallback(async (): Promise<boolean> => {
    if (!userId) return false;
    return getAppPaywallController(userId).restorePurchases();
  }, [userId]);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!userId) return false;
    return getAppPaywallController(userId).refreshEntitlement();
  }, [userId]);

  return {
    active: paywallState.active,
    status: paywallState.status,
    expiresAt: paywallState.expiresAt,
    purchase,
    restorePurchases,
    refresh,
  };
}
