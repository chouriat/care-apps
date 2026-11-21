import { isNetworkFailureMessage } from '@carecircle/core';
import { Linking } from 'react-native';
import { getSupabaseClient } from '../auth/api';
import { openPaywallLegalLink } from '../paywall/api';

export type HealthConsentLookupResult =
  | { ok: true; healthConsentAt: string | null }
  | { ok: false; isOffline: boolean };

export type GiveHealthConsentResult =
  | { ok: true; healthConsentAt: string }
  | { ok: false; isOffline: boolean };

export async function fetchHealthConsentStatus(
  userId?: string | null,
): Promise<HealthConsentLookupResult> {
  const trimmedUserId = userId?.trim() ?? '';
  if (!trimmedUserId || trimmedUserId === '__authenticated__') {
    return {
      ok: true,
      healthConsentAt: null,
    };
  }

  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('users_profile')
      .select('health_consent_at')
      .eq('user_id', trimmedUserId)
      .maybeSingle();

    if (error) {
      return {
        ok: false,
        isOffline: isNetworkFailureMessage(error.message),
      };
    }

    const rawConsent = (data as { health_consent_at?: unknown } | null)?.health_consent_at;
    const healthConsentAt =
      typeof rawConsent === 'string' && rawConsent.trim().length > 0 ? rawConsent : null;

    return {
      ok: true,
      healthConsentAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      isOffline: isNetworkFailureMessage(message),
    };
  }
}

export async function giveHealthConsentViaRpc(): Promise<GiveHealthConsentResult> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('give_health_consent');

    if (error) {
      return {
        ok: false,
        isOffline: isNetworkFailureMessage(error.message),
      };
    }

    if (typeof data === 'string' && data.trim().length > 0) {
      return {
        ok: true,
        healthConsentAt: data,
      };
    }

    return {
      ok: false,
      isOffline: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      isOffline: isNetworkFailureMessage(message),
    };
  }
}

export async function openConsentPrivacyPolicy(): Promise<boolean> {
  const envUrl = process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL?.trim();
  if (envUrl) {
    try {
      await Linking.openURL(envUrl);
      return true;
    } catch {
      return false;
    }
  }
  return openPaywallLegalLink('privacy');
}
