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
import {
  AppState,
  Platform,
  type AppStateStatus,
  type NativeEventSubscription,
} from 'react-native';

export const APP_AUTH_REDIRECT_URL = 'carecircle://auth/callback';

const secureStoreAdapter: SecureStoreAdapter = {
  getItemAsync: (key: string) => SecureStore.getItemAsync(key),
  setItemAsync: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  deleteItemAsync: (key: string) => SecureStore.deleteItemAsync(key),
};

let cachedSupabase: SupabaseClient | null = null;
let cachedController: AuthController | null = null;
let appStateSubscription: NativeEventSubscription | null = null;

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

// Expo copies EXPO_PUBLIC_ variables into a release build only where the code spells out
// `process.env.EXPO_PUBLIC_...` in full. Reading them through another object works in
// development (Metro serves the whole env) but is empty in every release and preview build.
// https://docs.expo.dev/guides/environment-variables/ (checked 2026-11-15)
function readSupabaseEnv(): Record<string, string | undefined> {
  return {
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  };
}

export function resolveSupabaseConfig(
  env: Record<string, string | undefined> = readSupabaseEnv(),
  isDev: boolean = (globalThis as { __DEV__?: boolean }).__DEV__ !== false,
): { url: string; anonKey: string } {
  const defaultLocalUrl =
    Platform.OS === 'android' ? 'http://10.0.2.2:54321' : 'http://127.0.0.1:54321';
  const configuredUrl = env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!configuredUrl && !isDev) {
    throw new Error(
      'CareCircle: Missing EXPO_PUBLIC_SUPABASE_URL environment variable in non-development build. Set it in your EAS build profile (eas.json / EAS Environment Variables).',
    );
  }

  if (!anonKey) {
    throw new Error(
      'CareCircle: Missing EXPO_PUBLIC_SUPABASE_ANON_KEY environment variable. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in apps/carecircle/.env (or your EAS build profile), then restart expo start.',
    );
  }

  if (!configuredUrl) {
    // Without EXPO_PUBLIC_SUPABASE_URL in dev, sign-in talks to a local Supabase that may not be
    // running, and the sign-in screen shows "You are offline". Say why in the dev console.
    console.warn(
      'CareCircle: EXPO_PUBLIC_SUPABASE_URL is not set in apps/carecircle/.env, so sign-in uses ' +
        'the local Supabase at ' +
        defaultLocalUrl +
        '. Set it, then restart expo start.',
    );
  }

  return { url: configuredUrl || defaultLocalUrl, anonKey };
}

export function getSupabaseClient(): SupabaseClient {
  if (cachedSupabase) {
    return cachedSupabase;
  }
  const { url, anonKey } = resolveSupabaseConfig();
  const client = createClient(url, anonKey, {
    auth: buildSupabaseAuthOptions(secureStoreAdapter),
  });
  cachedSupabase = client;

  // Checked 2026-11-15:
  // Supabase React Native Auth quickstart — manage background/foreground token auto-refresh with AppState:
  // https://supabase.com/docs/guides/auth/quickstarts/react-native
  if (Platform.OS !== 'web' && !appStateSubscription) {
    appStateSubscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        void client.auth.startAutoRefresh();
      } else {
        void client.auth.stopAutoRefresh();
      }
    });
  }

  return client;
}

export function resetSupabaseClientForTests(): void {
  appStateSubscription?.remove();
  appStateSubscription = null;
  cachedSupabase = null;
  cachedController = null;
  handledCallbacks.clear();
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
