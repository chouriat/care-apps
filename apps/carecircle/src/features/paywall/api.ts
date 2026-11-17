import {
  CARECIRCLE_FAMILY_ENTITLEMENT,
  createPaywallController,
  validateAnalyticsEvent,
  type CareCircleEntitlementId,
  type EntitlementReadStore,
  type EntitlementRow,
  type PaywallController,
  type RevenueCatSdkAdapter,
} from '@carecircle/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Linking, Platform } from 'react-native';
import Purchases, {
  type CustomerInfo,
  type PurchasesOfferings,
  type PurchasesPackage,
} from 'react-native-purchases';
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

// Sign-out waits for RevenueCat's logOut (a network call) at most this long, then goes ahead.
export const REVENUECAT_SIGN_OUT_TIMEOUT_MS = 5000;

function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        // Purchases.logOut() throws if the current RevenueCat user is already anonymous, and
        // fails offline. Either way sign-out goes ahead.
        clearTimeout(timer);
        resolve();
      },
    );
  });
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
    let logOutCall: Promise<unknown>;
    try {
      logOutCall = Promise.resolve(Purchases.logOut());
    } catch (err) {
      logOutCall = Promise.reject(err);
    }
    await settleWithin(logOutCall, REVENUECAT_SIGN_OUT_TIMEOUT_MS);
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

export type PaywallTrigger = 'members' | 'visit_note' | 'pdf_export' | 'circles' | 'settings';

export function trackPaywallViewed(trigger: PaywallTrigger): void {
  const payload = validateAnalyticsEvent('cc_paywall_viewed', { trigger });
  void getAppObservability()
    .analytics.track('cc_paywall_viewed', payload as { trigger: PaywallTrigger })
    .catch(() => undefined);
}

export interface FamilyOfferInfo {
  priceText: string | null;
  hasIntroOffer: boolean;
}

// INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE === 2 in @revenuecat/purchases-typescript-internal
const RC_INTRO_ELIGIBILITY_STATUS_ELIGIBLE = 2;

// RevenueCat trial & introductory price eligibility rules (checked 2026-11-17):
// - iOS (`Purchases.checkTrialOrIntroductoryPriceEligibility([productIdentifier])`):
//   Only show "Start free trial" when the product has `introPrice` AND
//   `checkTrialOrIntroductoryPriceEligibility` returns `INTRO_ELIGIBILITY_STATUS_ELIGIBLE` (2).
//   When status is `UNKNOWN` (0), `INELIGIBLE` (1), or `NO_INTRO_OFFER_EXISTS` (3), RevenueCat's
//   guidance is to display non-introductory pricing ("Subscribe") to avoid misleading users:
//   https://www.revenuecat.com/docs/subscription-guidance/subscription-offers/ios-subscription-offers#checking-eligibility (checked 2026-11-17)
// - Android (Google Play):
//   `checkTrialOrIntroductoryPriceEligibility` always returns `UNKNOWN` on Android; instead,
//   Google Play's BillingClient populates `product.defaultOption.freePhase` / `introPhase` only
//   when the Google account is eligible for the free trial or introductory phase:
//   https://www.revenuecat.com/docs/subscription-guidance/subscription-offers/google-play-offers (checked 2026-11-17)
export async function getFamilyOffer(platformOs: string = Platform.OS): Promise<FamilyOfferInfo> {
  const offerings = await Purchases.getOfferings();
  const pkg = selectFamilyPackage(offerings);
  if (!pkg) {
    return { priceText: null, hasIntroOffer: false };
  }
  const priceText = formatPackagePriceText(pkg);
  const product = pkg.product;
  if (!product) {
    return { priceText, hasIntroOffer: false };
  }

  if (platformOs === 'ios') {
    if (!product.introPrice || !product.identifier) {
      return { priceText, hasIntroOffer: false };
    }
    if (typeof Purchases.checkTrialOrIntroductoryPriceEligibility !== 'function') {
      return { priceText, hasIntroOffer: Boolean(product.introPrice) };
    }
    try {
      const eligibilityMap = await Purchases.checkTrialOrIntroductoryPriceEligibility([
        product.identifier,
      ]);
      const entry = eligibilityMap?.[product.identifier];
      const eligibleStatus =
        Purchases.INTRO_ELIGIBILITY_STATUS?.INTRO_ELIGIBILITY_STATUS_ELIGIBLE ??
        RC_INTRO_ELIGIBILITY_STATUS_ELIGIBLE;
      return {
        priceText,
        hasIntroOffer: entry?.status === eligibleStatus,
      };
    } catch {
      return { priceText, hasIntroOffer: false };
    }
  }

  // Android: check what RevenueCat's Google Play product defaultOption says
  const hasAndroidIntro = Boolean(
    product.defaultOption?.freePhase ||
      product.defaultOption?.introPhase ||
      (product.defaultOption === undefined && product.introPrice),
  );
  return { priceText, hasIntroOffer: hasAndroidIntro };
}

// RevenueCat Offerings & Displaying Products (`Purchases.getOfferings()`, `offering.monthly`,
// `$rc_monthly` / `PACKAGE_TYPE.MONTHLY`, `product.priceString`, `product.introPrice`):
// https://www.revenuecat.com/docs/offerings/offerings (checked 2026-11-15)
// https://www.revenuecat.com/docs/getting-started/displaying-products (checked 2026-11-15)
export function selectFamilyPackage(
  offerings: PurchasesOfferings | null | undefined,
): PurchasesPackage | null {
  const current = offerings?.current;
  if (!current) {
    return null;
  }
  if (current.monthly) {
    return current.monthly;
  }
  const packages = current.availablePackages ?? [];
  const monthlyPkg = packages.find(
    (pkg) => pkg.packageType === 'MONTHLY' || pkg.identifier === '$rc_monthly',
  );
  return monthlyPkg ?? packages[0] ?? null;
}

function formatPackagePriceText(pkg: PurchasesPackage): string | null {
  const rawPrice = pkg.product?.priceString?.trim() ?? '';
  if (!rawPrice) {
    return null;
  }
  if (rawPrice.includes('/')) {
    return rawPrice;
  }
  const period = pkg.product?.subscriptionPeriod;
  if (pkg.packageType === 'MONTHLY' || pkg.identifier === '$rc_monthly' || period === 'P1M') {
    return `${rawPrice} / month`;
  }
  if (pkg.packageType === 'ANNUAL' || pkg.identifier === '$rc_annual' || period === 'P1Y') {
    return `${rawPrice} / year`;
  }
  if (pkg.packageType === 'WEEKLY' || pkg.identifier === '$rc_weekly' || period === 'P1W') {
    return `${rawPrice} / week`;
  }
  return rawPrice;
}

// Final Terms of Use and Privacy Policy URLs will be supplied by Taha before CC-8 / store release.
// Keeping them in one table + helper makes pointing the paywall links at the live URLs a 2-line change.
export const PAYWALL_LEGAL_URLS: {
  terms: string | null;
  privacy: string | null;
} = {
  terms: null,
  privacy: null,
};

export async function openPaywallLegalLink(
  kind: 'terms' | 'privacy',
  openUrl: (url: string) => Promise<unknown> = (url) => Linking.openURL(url),
): Promise<boolean> {
  const targetUrl = PAYWALL_LEGAL_URLS[kind]?.trim();
  if (!targetUrl) {
    return false;
  }
  await openUrl(targetUrl);
  return true;
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
      const pkg = selectFamilyPackage(offerings);
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
