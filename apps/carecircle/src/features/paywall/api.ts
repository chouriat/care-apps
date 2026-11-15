import {
  CARECIRCLE_FAMILY_ENTITLEMENT,
  createPaywallController,
  type CareCircleEntitlementId,
  type EntitlementReadStore,
  type EntitlementRow,
  type PaywallController,
  type RevenueCatSdkAdapter,
} from '@carecircle/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import Purchases, { type CustomerInfo } from 'react-native-purchases';
import { getSupabaseClient } from '../auth/api';
import { getAppObservability } from '../observability/api';

// Expo copies EXPO_PUBLIC_ variables into release/preview builds only when written out as
// `process.env.EXPO_PUBLIC_...` in full: https://docs.expo.dev/guides/environment-variables/ (checked 2026-11-15)
export function resolveRevenueCatApiKey(platformOs: string = Platform.OS): string | null {
  if (platformOs === 'ios') {
    const key = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY?.trim();
    return key ? key : null;
  }
  if (platformOs === 'android') {
    const key = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY?.trim();
    return key ? key : null;
  }
  return null;
}

let sdkConfigured = false;
let sdkCurrentUserId: string | null = null;

function extractEntitlementState(customerInfo: CustomerInfo): {
  entitlementActive: boolean;
  expiresAt: string | null;
  isTrial: boolean;
} {
  const entitlement = customerInfo.entitlements?.active?.[CARECIRCLE_FAMILY_ENTITLEMENT];
  if (!entitlement || !entitlement.isActive) {
    return {
      entitlementActive: false,
      expiresAt: null,
      isTrial: false,
    };
  }
  return {
    entitlementActive: true,
    expiresAt: entitlement.expirationDate ?? null,
    isTrial: entitlement.periodType === 'TRIAL',
  };
}

// RevenueCat React Native SDK installation & user identification (`Purchases.configure`,
// `Purchases.logIn`, `Purchases.logOut`):
// https://www.revenuecat.com/docs/getting-started/installation/reactnative (checked 2026-11-15)
// https://www.revenuecat.com/docs/customers/user-ids (checked 2026-11-15)
export async function syncRevenueCatAuthUser(userId: string | null): Promise<void> {
  if (!userId) {
    controllersByUser.clear();
    if (!sdkConfigured) {
      sdkCurrentUserId = null;
      return;
    }
    sdkCurrentUserId = null;
    try {
      await Purchases.logOut();
    } catch {
      // Purchases.logOut() throws if the current RevenueCat user is already anonymous; ignore.
    }
    return;
  }

  const apiKey = resolveRevenueCatApiKey();
  if (!apiKey) {
    return;
  }
  if (!sdkConfigured) {
    Purchases.configure({ apiKey, appUserID: userId });
    sdkConfigured = true;
    sdkCurrentUserId = userId;
    return;
  }
  if (sdkCurrentUserId !== userId) {
    await Purchases.logIn(userId);
    sdkCurrentUserId = userId;
  }
}

export function createRevenueCatSdkAdapter(): RevenueCatSdkAdapter {
  return {
    async logIn(appUserId: string): Promise<void> {
      const apiKey = resolveRevenueCatApiKey();
      if (!apiKey) {
        throw new Error('REVENUECAT_NOT_CONFIGURED');
      }
      await syncRevenueCatAuthUser(appUserId);
    },

    async purchaseFamilyPackage() {
      const offerings = await Purchases.getOfferings();
      const pkg = offerings.current?.availablePackages?.[0];
      if (!pkg) {
        throw new Error('NO_OFFERING_AVAILABLE');
      }
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      return extractEntitlementState(customerInfo);
    },

    async restorePurchases() {
      const customerInfo = await Purchases.restorePurchases();
      const { entitlementActive, expiresAt } = extractEntitlementState(customerInfo);
      return { entitlementActive, expiresAt };
    },
  };
}

export function createSupabaseEntitlementReadStore(
  getClient: () => SupabaseClient = getSupabaseClient,
): EntitlementReadStore {
  return {
    async getEntitlement(
      userId: string,
      entitlement: CareCircleEntitlementId,
    ): Promise<{ data: EntitlementRow | null; error: { message: string } | null }> {
      const supabase = getClient();
      const { data, error } = await supabase
        .from('entitlements')
        .select('user_id, entitlement, active, expires_at')
        .eq('user_id', userId)
        .eq('entitlement', entitlement)
        .maybeSingle();

      if (error) {
        return { data: null, error: { message: error.message } };
      }
      return {
        data: (data as EntitlementRow | null) ?? null,
        error: null,
      };
    },
  };
}

const controllersByUser = new Map<string, PaywallController>();

export function getAppPaywallController(userId: string): PaywallController {
  let controller = controllersByUser.get(userId);
  if (!controller) {
    controller = createPaywallController({
      userId,
      store: createSupabaseEntitlementReadStore(),
      sdk: createRevenueCatSdkAdapter(),
      analytics: {
        track(event, props) {
          return getAppObservability().analytics.track(event as never, props as never);
        },
      },
    });
    controllersByUser.set(userId, controller);
  }
  return controller;
}

export function resetPaywallControllersForTests(): void {
  controllersByUser.clear();
  sdkConfigured = false;
  sdkCurrentUserId = null;
}
