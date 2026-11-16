import { useTheme } from '@carecircle/ui';
import { Tabs } from 'expo-router';
import en from '../../i18n/en.json';

export default function TabsLayout() {
  const { colors, typography } = useTheme();

  return (
    <Tabs
      // Root SafeAreaFrame in app/_layout.tsx already pads the bottom safe area, so zero out
      // the tab navigator's own bottom inset to avoid a double bottom gap on iPhone.
      safeAreaInsets={{ bottom: 0 }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarLabelStyle: {
          fontSize: typography.caption.fontSize,
          lineHeight: typography.caption.lineHeight,
        },
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
      }}
    >
      <Tabs.Screen
        name="today"
        options={{
          title: en.today.title,
          tabBarAccessibilityLabel: en.today.title,
          tabBarButtonTestID: 'tab-today',
        }}
      />
      <Tabs.Screen
        name="meds"
        options={{
          title: en.meds.title,
          tabBarAccessibilityLabel: en.meds.title,
          tabBarButtonTestID: 'tab-meds',
        }}
      />
    </Tabs>
  );
}
