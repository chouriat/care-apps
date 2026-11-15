import type { AuthProvider, AuthState } from '@carecircle/core';
import * as Linking from 'expo-linking';
import { useCallback, useEffect, useState } from 'react';
import { getAppAuthController, handleAuthCallbackOnce } from './api';

export function useAuthController() {
  const controller = getAppAuthController();
  const [state, setState] = useState<AuthState>(() => controller.getState());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    if (controller.getState().status === 'loading') {
      void controller.initialize();
    }

    void Linking.getInitialURL().then((initialUrl) => {
      if (initialUrl && initialUrl.includes('auth/callback')) {
        void handleAuthCallbackOnce(initialUrl);
      }
    });

    const urlSubscription = Linking.addEventListener('url', ({ url }) => {
      if (url && url.includes('auth/callback')) {
        void handleAuthCallbackOnce(url);
      }
    });

    return () => {
      unsubscribe();
      urlSubscription.remove();
    };
  }, [controller]);

  const signInWithEmail = useCallback(
    (email: string) => controller.signInWithEmail(email),
    [controller],
  );

  const signInWithOAuth = useCallback(
    (provider: AuthProvider) => controller.signInWithOAuth(provider),
    [controller],
  );

  const retry = useCallback(() => {
    void controller.initialize();
  }, [controller]);

  const signOut = useCallback(() => controller.signOut(), [controller]);

  return {
    state,
    signInWithEmail,
    signInWithOAuth,
    retry,
    signOut,
  };
}
