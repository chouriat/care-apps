import { ThemeProvider } from '@carecircle/ui';
import { Stack, usePathname, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { AuthGate } from '../src/features/auth/components';
import { useAuthController } from '../src/features/auth/hooks';

export default function RootLayout() {
  const pathname = usePathname();
  const router = useRouter();
  const { state } = useAuthController();

  const handleRedirect = useCallback(
    (targetRoute: string) => {
      router.replace(targetRoute as never);
    },
    [router],
  );

  return (
    <ThemeProvider>
      <AuthGate status={state.status} pathname={pathname} onRedirect={handleRedirect}>
        <Stack screenOptions={{ headerShown: false }} />
      </AuthGate>
    </ThemeProvider>
  );
}
