import { ThemeProvider, useTheme } from '@carecircle/ui';
import { Stack, usePathname, useRouter } from 'expo-router';
import { useCallback, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AuthGate } from '../src/features/auth/components';
import { useAuthController } from '../src/features/auth/hooks';
import { usePushNotifications } from '../src/features/notifications/hooks';

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
  const { state } = useAuthController();
  usePushNotifications(state.status);

  const handleRedirect = useCallback(
    (targetRoute: string) => {
      router.replace(targetRoute as never);
    },
    [router],
  );

  return (
    <ThemeProvider>
      <SafeAreaFrame>
        <AuthGate status={state.status} pathname={pathname} onRedirect={handleRedirect}>
          <Stack screenOptions={{ headerShown: false }} />
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
