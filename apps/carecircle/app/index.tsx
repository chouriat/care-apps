import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ErrorState } from '@carecircle/ui';
import { StyleSheet, Text, View } from 'react-native';
import en from '../i18n/en.json';
import { getSupabaseClient } from '../src/features/auth/api';
import { acceptInviteViaRpc, consumePendingInviteToken } from '../src/features/circle';
import { loadCareCircleMocks } from '../src/features/mocks';

export default function PlaceholderScreen() {
  const router = useRouter();
  const mocks = loadCareCircleMocks();
  const hasAnonKey = Boolean(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim());
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (mocks || !hasAnonKey) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const pendingToken = consumePendingInviteToken();
        if (pendingToken) {
          const joinRes = await acceptInviteViaRpc({ tokenOrUrl: pendingToken });
          if (cancelled) return;
          if (joinRes.ok) {
            router.replace('/(tabs)/today' as never);
            return;
          }
        }

        const supabase = getSupabaseClient();
        const { data, error } = await supabase.from('circles').select('id').limit(1);
        if (cancelled) return;
        // Only a successful answer of "no circles" means onboarding. A network or server error
        // must not send someone who already has a circle to the create-circle screen.
        if (error || !Array.isArray(data)) {
          setLoadFailed(true);
        } else if (data.length > 0) {
          router.replace('/(tabs)/today' as never);
        } else {
          router.replace('/(onboarding)/start' as never);
        }
      } catch {
        if (!cancelled) {
          setLoadFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt, hasAnonKey, mocks, router]);

  if (loadFailed) {
    return (
      <View testID="home-load-error" style={styles.container}>
        <ErrorState
          title={en.home.loadErrorTitle}
          message={en.home.loadErrorMessage}
          retryLabel={en.home.retry}
          onRetry={() => {
            setLoadFailed(false);
            setAttempt((n) => n + 1);
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container} accessibilityLabel={en.placeholder.title}>
      <Text style={styles.title}>{en.placeholder.title}</Text>
      <Text style={styles.subtitle}>{en.placeholder.subtitle}</Text>
      {mocks ? (
        <Text testID="mocks-loaded" style={styles.mocksBadge}>
          {mocks.circle.name}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 8 },
  subtitle: { fontSize: 16 },
  mocksBadge: { fontSize: 14, marginTop: 12 },
});
