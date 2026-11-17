import { Button, ErrorState, useTheme } from '@carecircle/ui';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import en from '../../i18n/en.json';
import { getAppAuthController } from '../../src/features/auth/api';
import {
  acceptInviteViaRpc,
  setPendingInviteToken,
  type AcceptInviteErrorCode,
} from '../../src/features/circle';
import { PaywallSheet } from '../../src/features/paywall/components';

export function messageForAcceptError(code: AcceptInviteErrorCode | null): string {
  switch (code) {
    case 'CIRCLE_FULL':
      return en.onboarding.joinCircleFullMessage;
    case 'INVITE_EXPIRED':
      return en.onboarding.joinExpiredMessage;
    case 'INVITE_USED':
      return en.onboarding.joinUsedMessage;
    case 'INVITE_INVALID':
    case 'VALIDATION_ERROR':
      return en.onboarding.joinInvalidMessage;
    case 'CIRCLE_LIMIT_REACHED':
    case 'CIRCLE_LIMIT':
      return en.onboarding.limitReachedMessage;
    default:
      return en.onboarding.errorMessage;
  }
}

export default function InviteTokenRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const { colors, spacing, typography } = useTheme();
  const rawToken = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';

  const [isLoading, setIsLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);
  const [errorCode, setErrorCode] = useState<AcceptInviteErrorCode | null>(null);
  const [paywallVisible, setPaywallVisible] = useState(false);

  const attemptAccept = useCallback(async () => {
    const authStatus = getAppAuthController().getState().status;
    if (authStatus === 'unauthenticated') {
      setPendingInviteToken(token);
      router.replace('/(auth)/sign-in' as never);
      return;
    }
    if (authStatus === 'loading') {
      setPendingInviteToken(token);
      return;
    }

    setIsLoading(true);
    setIsOffline(false);
    setErrorCode(null);

    const res = await acceptInviteViaRpc({ tokenOrUrl: token });
    // This screen handles the token now (and shows any error), so the home screen must not
    // try it again later without telling the person.
    setPendingInviteToken(null);
    if (res.ok) {
      router.replace('/(tabs)/today' as never);
      return;
    }

    setIsOffline(res.isOffline);
    setErrorCode(res.errorCode);
    if (res.errorCode === 'CIRCLE_LIMIT') {
      setPaywallVisible(true);
    }
    setIsLoading(false);
  }, [router, token]);

  useEffect(() => {
    void attemptAccept();
  }, [attemptAccept]);

  if (isLoading) {
    return (
      <View
        testID="invite-accept-loading"
        style={[styles.container, { backgroundColor: colors.background, gap: spacing.sm }]}
      >
        <ActivityIndicator color={colors.primary} />
        <Text
          style={{
            color: colors.textPrimary,
            fontSize: typography.body.fontSize,
            lineHeight: typography.body.lineHeight,
          }}
        >
          {en.onboarding.loading}
        </Text>
      </View>
    );
  }

  return (
    <View
      testID={isOffline ? 'invite-accept-offline' : 'invite-accept-error'}
      style={[
        styles.container,
        { backgroundColor: colors.background, padding: spacing.lg, gap: spacing.md },
      ]}
    >
      <ErrorState
        title={isOffline ? en.onboarding.offlineTitle : en.onboarding.joinTitle}
        message={isOffline ? en.onboarding.offlineMessage : messageForAcceptError(errorCode)}
        retryLabel={en.onboarding.retry}
        onRetry={() => {
          void attemptAccept();
        }}
      />
      <View testID="invite-accept-continue-button">
        <Button
          variant="secondary"
          label={en.onboarding.continueToApp}
          accessibilityLabel={en.onboarding.continueToApp}
          onPress={() => {
            router.replace('/' as never);
          }}
        />
      </View>
      <PaywallSheet
        visible={paywallVisible}
        trigger="circles"
        onClose={() => setPaywallVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
