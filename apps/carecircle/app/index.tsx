import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import en from '../i18n/en.json';
import { getSupabaseClient } from '../src/features/auth/api';
import { loadCareCircleMocks } from '../src/features/mocks';

export default function PlaceholderScreen() {
  const router = useRouter();
  const mocks = loadCareCircleMocks();
  const hasAnonKey = Boolean(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim());

  useEffect(() => {
    if (mocks || !hasAnonKey) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const supabase = getSupabaseClient();
        const { data, error } = await supabase.from('circles').select('id').limit(1);
        if (cancelled) return;
        if (!error && Array.isArray(data) && data.length > 0) {
          router.replace('/(tabs)/today' as never);
        } else {
          router.replace('/(onboarding)/start' as never);
        }
      } catch {
        if (!cancelled) {
          router.replace('/(onboarding)/start' as never);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasAnonKey, mocks, router]);

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
