import {
  buildSupabaseAuthOptions,
  createAuthController,
  type AuthController,
  type AuthProvider,
  type AuthSession,
  type SecureStoreAdapter,
  type SupabaseAuthAdapter,
} from '@carecircle/core';
import {
  createClient,
  isAuthRetryableFetchError,
  type AuthError,
  type SupabaseClient,
} from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

export const APP_AUTH_REDIRECT_URL = 'carecircle://auth/callback';

const secureStoreAdapter: SecureStoreAdapter = {
  getItemAsync: (key: string) => SecureStore.getItemAsync(key),
  setItemAsync: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  deleteItemAsync: (key: string) => SecureStore.deleteItemAsync(key),
};

let cachedSupabase: SupabaseClient | null = null;
let cachedController: AuthController | null = null;

// supabase-js reports a failed network call (status 0) as an error result, not a throw.
// Map it to NETWORK_ERROR so the sign-in screen shows its offline state.
function toAdapterError(error: AuthError | null): { message: string; code?: string } | null {
  if (!error) return null;
  const offline = isAuthRetryableFetchError(error) && !error.status;
  return { message: error.message, code: offline ? 'NETWORK_ERROR' : error.code };
}

// One callback link can arrive several times: getInitialURL on every mount of a screen using
// the auth hook (again after sign-out), the 'url' event, and openAuthSessionAsync on Android.
// A PKCE code works only once, so a second exchange fails and shows an error. Handle each once.
const handledCallbacks = new Map<string, Promise<boolean>>();

export function handleAuthCallbackOnce(url: string): Promise<boolean> {
  let pending = handledCallbacks.get(url);
  if (!pending) {
    pending = getAppAuthController().handleAuthCallback(url);
    handledCallbacks.set(url, pending);
  }
  return pending;
}

function resolveSupabaseConfig(): { url: string; anonKey: string } {
  const defaultLocalUrl =
    Platform.OS === 'android' ? 'http://10.0.2.2:54321' : 'http://127.0.0.1:54321';
  const envObj =
    typeof process !== 'undefined' && process.env
      ? (process.env as Record<string, string | undefined>)
      : {};
  const url = envObj.EXPO_PUBLIC_SUPABASE_URL?.trim() || defaultLocalUrl;
  const anonKey = envObj.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() || 'public-anon-key-placeholder';
  return { url, anonKey };
}

export function getSupabaseClient(): SupabaseClient {
  if (cachedSupabase) {
    return cachedSupabase;
  }
  const { url, anonKey } = resolveSupabaseConfig();
  cachedSupabase = createClient(url, anonKey, {
    auth: buildSupabaseAuthOptions(secureStoreAdapter),
  });
  return cachedSupabase;
}

export function getAppAuthController(): AuthController {
  if (cachedController) {
    return cachedController;
  }

  const supabase = getSupabaseClient();

  const supabaseAuthAdapter: SupabaseAuthAdapter = {
    async signInWithOtp({ email, options }) {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: options?.emailRedirectTo ?? APP_AUTH_REDIRECT_URL,
        },
      });
      return {
        error: toAdapterError(error),
      };
    },

    async signInWithOAuth({
      provider,
      options,
    }: {
      provider: AuthProvider;
      options?: { redirectTo?: string };
    }) {
      const redirectTo = options?.redirectTo ?? APP_AUTH_REDIRECT_URL;
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
          skipBrowserRedirect: true,
        },
      });

      if (error) {
        return {
          data: { url: null },
          error: toAdapterError(error),
        };
      }

      if (data?.url) {
        const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
        if (result.type === 'success' && result.url) {
          const ok = await handleAuthCallbackOnce(result.url);
          if (!ok) {
            // Report the failure so the controller keeps the error instead of clearing it.
            const code = getAppAuthController().getState().errorCode ?? 'CODE_EXCHANGE_FAILED';
            return { data: { url: null }, error: { message: code, code } };
          }
        }
      }

      return {
        data: { url: data?.url ?? null },
        error: null,
      };
    },

    async exchangeCodeForSession(code: string) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      return {
        data: { session: (data?.session as unknown as AuthSession | null) ?? null },
        error: toAdapterError(error),
      };
    },

    async signOut() {
      const { error } = await supabase.auth.signOut();
      return {
        error: toAdapterError(error),
      };
    },
  };

  const controller = createAuthController({
    secureStore: secureStoreAdapter,
    supabaseAuth: supabaseAuthAdapter,
    redirectUrl: APP_AUTH_REDIRECT_URL,
  });

  cachedController = controller;

  supabase.auth.onAuthStateChange((event, session) => {
    if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && session) {
      void controller.receiveSession(session as unknown as AuthSession);
    } else if (event === 'SIGNED_OUT' && controller.getState().status === 'authenticated') {
      void controller.signOut();
    }
  });

  return controller;
}
