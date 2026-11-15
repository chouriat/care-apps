import { StyleSheet, Text, View } from 'react-native';
import en from '../i18n/en.json';
import { loadCareCircleMocks } from '../src/features/mocks';

export default function PlaceholderScreen() {
  const mocks = loadCareCircleMocks();

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
