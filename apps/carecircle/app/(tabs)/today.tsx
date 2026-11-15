import { EmptyState, Header, useTheme } from '@carecircle/ui';
import { StyleSheet, View } from 'react-native';
import en from '../../i18n/en.json';

export default function TodayScreen() {
  const { colors, spacing } = useTheme();

  return (
    <View
      testID="today-screen"
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          padding: spacing.lg,
          gap: spacing.md,
        },
      ]}
    >
      <Header title={en.today.title} />
      <View testID="today-empty-state">
        <EmptyState title={en.today.emptyTitle} message={en.today.emptyMessage} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
