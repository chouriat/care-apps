import type { AuthProvider } from '@carecircle/core';
import {
  Button,
  Card,
  ErrorState,
  Header,
  MIN_TOUCH_TARGET_PT,
  Screen,
  radii,
  spacing,
  useTheme,
} from '@carecircle/ui';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import en from '../../../../i18n/en.json';

export interface SignInScreenProps {
  onSendMagicLink?: (email: string) => void | Promise<boolean | void>;
  onSignInOAuth?: (provider: AuthProvider) => void | Promise<boolean | void>;
  onRetry?: () => void;
  isLoading?: boolean;
  isOffline?: boolean;
  hasError?: boolean;
  magicLinkSent?: boolean;
  initialEmail?: string;
}

export function SignInScreen({
  onSendMagicLink,
  onSignInOAuth,
  onRetry,
  isLoading = false,
  isOffline = false,
  hasError = false,
  magicLinkSent = false,
  initialEmail = '',
}: SignInScreenProps) {
  const { colors, typography } = useTheme();
  const [email, setEmail] = useState(initialEmail);
  const copy = en.auth;

  const handleMagicLinkPress = () => {
    void onSendMagicLink?.(email.trim());
  };

  const handleApplePress = () => {
    void onSignInOAuth?.('apple');
  };

  const handleGooglePress = () => {
    void onSignInOAuth?.('google');
  };

  return (
    <Screen accessibilityLabel={copy.title}>
      <View testID="sign-in-screen" style={styles.container}>
        <Header title={copy.title} subtitle={copy.subtitle} />

        {isLoading ? (
          <View testID="sign-in-loading" style={styles.statusBox}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
              {copy.loading}
            </Text>
          </View>
        ) : null}

        {isOffline ? (
          <View testID="sign-in-offline">
            <ErrorState
              title={copy.offlineTitle}
              message={copy.offlineMessage}
              retryLabel={copy.retry}
              onRetry={onRetry ?? (() => undefined)}
            />
          </View>
        ) : null}

        {hasError ? (
          <View testID="sign-in-error">
            <ErrorState
              title={copy.errorTitle}
              message={copy.errorMessage}
              retryLabel={copy.retry}
              onRetry={onRetry ?? (() => undefined)}
            />
          </View>
        ) : null}

        {magicLinkSent ? (
          <View testID="sign-in-magic-link-sent">
            <Card accessibilityLabel={copy.magicLinkSentTitle}>
              <Text style={[typography.subtitle, { color: colors.textPrimary }]}>
                {copy.magicLinkSentTitle}
              </Text>
              <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
                {copy.magicLinkSentBody}
              </Text>
            </Card>
          </View>
        ) : null}

        <Card>
          <Text style={[typography.label, { color: colors.textPrimary }]}>{copy.emailLabel}</Text>
          <TextInput
            testID="sign-in-email-input"
            accessibilityLabel={copy.emailLabel}
            placeholder={copy.emailPlaceholder}
            placeholderTextColor={colors.textMuted}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            style={[
              styles.input,
              typography.body,
              {
                color: colors.textPrimary,
                backgroundColor: colors.surface,
                borderColor: colors.border,
              },
            ]}
          />
          <Button
            label={copy.sendMagicLink}
            accessibilityLabel={copy.sendMagicLinkA11y}
            onPress={handleMagicLinkPress}
            disabled={isLoading}
          />
        </Card>

        <View style={styles.oauthGroup}>
          <Button
            label={copy.continueWithApple}
            accessibilityLabel={copy.continueWithAppleA11y}
            variant="secondary"
            onPress={handleApplePress}
            disabled={isLoading}
          />
          <Button
            label={copy.continueWithGoogle}
            accessibilityLabel={copy.continueWithGoogleA11y}
            variant="secondary"
            onPress={handleGooglePress}
            disabled={isLoading}
          />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.md,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET_PT,
    minWidth: MIN_TOUCH_TARGET_PT,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
  },
  oauthGroup: {
    gap: spacing.sm,
  },
  statusBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
});
