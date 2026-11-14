import {
  buildSupabaseAuthOptions,
  createAuthController,
  type AuthController,
  type AuthProvider,
  type AuthSession,
  type SecureStoreAdapter,
  type SupabaseAuthAdapter,
} from '@carecircle/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
        error: error ? { message: error.message, code: error.code } : null,
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
          error: { message: error.message, code: error.code },
        };
      }

      if (data?.url) {
        const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
        if (result.type === 'success' && result.url && cachedController) {
          await cachedController.handleAuthCallback(result.url);
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
        error: error ? { message: error.message, code: error.code } : null,
      };
    },

    async signOut() {
      const { error } = await supabase.auth.signOut();
      return {
        error: error ? { message: error.message, code: error.code } : null,
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
