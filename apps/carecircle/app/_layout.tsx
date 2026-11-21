import { ThemeProvider, useTheme } from '@carecircle/ui';
import { Stack, usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AuthGate } from '../src/features/auth/components';
import { useAuthController } from '../src/features/auth/hooks';
import { getPendingInviteToken, setPendingInviteToken } from '../src/features/circle';
import { fetchHealthConsentStatus, HealthConsentScreen } from '../src/features/consent';
import { loadCareCircleMocks } from '../src/features/mocks';
import { usePushNotifications } from '../src/features/notifications/hooks';
import { useObservability } from '../src/features/observability/hooks';

type ConsentGateState = {
  userId: string;
  status: 'loading' | 'missing' | 'consented';
};

function isConsentGatedPathname(pathname: string, hasPendingInvite: boolean): boolean {
  if (pathname === '/start' || pathname === '/(onboarding)/start') {
    return true;
  }
  if (pathname.startsWith('/onboarding/') || pathname.startsWith('/(onboarding)/')) {
    return true;
  }
  if (pathname.startsWith('/invite/')) {
    return true;
  }
  if (pathname === '/' && hasPendingInvite) {
    return true;
  }
  return false;
}

// Keeps every screen clear of the status bar, camera cutout, rounded corners and home
// indicator. Expo Router already wraps the app in a SafeAreaProvider.
function SafeAreaFrame({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <SafeAreaView style={[styles.frame, { backgroundColor: colors.background }]}>
      {children}
    </SafeAreaView>
  );
}

export default function RootLayout() {
  const pathname = usePathname();
  const router = useRouter();
  const { state, signOut } = useAuthController();
  usePushNotifications(state.status);
  useObservability(state);

  const mocks = loadCareCircleMocks();
  const hasAnonKey = Boolean(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim());
  const isConsentEnabled = !mocks && hasAnonKey;
  const activeUserId =
    isConsentEnabled && state.status === 'authenticated'
      ? (state.session?.user?.id ?? '__authenticated__')
      : null;

  const [consentState, setConsentState] = useState<ConsentGateState | null>(null);

  useEffect(() => {
    const match = /^\/invite\/([^/?#]+)/.exec(pathname);
    if (match?.[1] && state.status !== 'authenticated') {
      setPendingInviteToken(match[1]);
    }
  }, [pathname, state.status]);

  useEffect(() => {
    if (!activeUserId) {
      setConsentState(null);
      return;
    }

    let cancelled = false;
    setConsentState({ userId: activeUserId, status: 'loading' });

    void fetchHealthConsentStatus(activeUserId).then((res) => {
      if (cancelled) {
        return;
      }
      if (res.ok && res.healthConsentAt !== null) {
        setConsentState({ userId: activeUserId, status: 'consented' });
      } else {
        setConsentState({ userId: activeUserId, status: 'missing' });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeUserId]);

  const handleRedirect = useCallback(
    (targetRoute: string) => {
      router.replace(targetRoute as never);
    },
    [router],
  );

  const handleConsented = useCallback(() => {
    if (activeUserId) {
      setConsentState({ userId: activeUserId, status: 'consented' });
    }
  }, [activeUserId]);

  const effectiveConsentStatus = !activeUserId
    ? 'inactive'
    : consentState?.userId === activeUserId
      ? consentState.status
      : 'loading';

  const needsConsentGate =
    activeUserId !== null &&
    effectiveConsentStatus !== 'consented' &&
    isConsentGatedPathname(pathname, getPendingInviteToken() !== null);

  return (
    <ThemeProvider>
      <SafeAreaFrame>
        <AuthGate status={state.status} pathname={pathname} onRedirect={handleRedirect}>
          {needsConsentGate ? (
            effectiveConsentStatus === 'loading' ? (
              <View testID="health-consent-loading" style={styles.frame} />
            ) : (
              <HealthConsentScreen onConsented={handleConsented} onSignOut={signOut} />
            )
          ) : (
            <Stack screenOptions={{ headerShown: false }} />
          )}
        </AuthGate>
      </SafeAreaFrame>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  frame: {
    flex: 1,
  },
});
