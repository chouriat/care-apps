import { Button, MIN_TOUCH_TARGET_PT, useTheme } from '@carecircle/ui';
import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import en from '../../../../i18n/en.json';
import {
  giveHealthConsentViaRpc,
  openConsentPrivacyPolicy,
  type GiveHealthConsentResult,
} from '../api';

export interface HealthConsentScreenProps {
  onConsented: (consentedAt: string) => void;
  onSignOut: () => void | Promise<void>;
  recordConsent?: () => Promise<GiveHealthConsentResult>;
  onOpenPrivacyPolicy?: () => void | Promise<boolean | void>;
}

export function HealthConsentScreen({
  onConsented,
  onSignOut,
  recordConsent = giveHealthConsentViaRpc,
  onOpenPrivacyPolicy = openConsentPrivacyPolicy,
}: HealthConsentScreenProps) {
  const { colors, radii, spacing, typography } = useTheme();
  const [isChecked, setIsChecked] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeclined, setIsDeclined] = useState(false);
  const [errorKind, setErrorKind] = useState<'offline' | 'error' | null>(null);
  const inFlightRef = useRef(false);

  const handleToggleCheckbox = useCallback(() => {
    if (inFlightRef.current) {
      return;
    }
    setIsChecked((prev) => !prev);
    setErrorKind(null);
  }, []);

  const handleContinue = useCallback(async () => {
    if (!isChecked || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setIsSubmitting(true);
    setErrorKind(null);

    try {
      const result = await recordConsent();
      if (result.ok) {
        onConsented(result.healthConsentAt);
        return;
      }
      setErrorKind(result.isOffline ? 'offline' : 'error');
    } catch {
      setErrorKind('error');
    } finally {
      inFlightRef.current = false;
      setIsSubmitting(false);
    }
  }, [isChecked, onConsented, recordConsent]);

  const handleDecline = useCallback(() => {
    if (inFlightRef.current) {
      return;
    }
    setIsDeclined(true);
    setErrorKind(null);
  }, []);

  const handlePrivacyPress = useCallback(() => {
    void onOpenPrivacyPolicy();
  }, [onOpenPrivacyPolicy]);

  const handleSignOutPress = useCallback(() => {
    void onSignOut();
  }, [onSignOut]);

  return (
    <ScrollView
      testID="health-consent-screen"
      style={[styles.scroll, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.container,
        { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: spacing.xs }}>
        <Text
          accessibilityRole="header"
          style={{
            color: colors.textPrimary,
            fontSize: typography.title.fontSize,
            lineHeight: typography.title.lineHeight,
            fontWeight: typography.title.fontWeight,
          }}
        >
          {en.consent.title}
        </Text>

        <Text
          style={{
            color: colors.textSecondary,
            fontSize: typography.body.fontSize,
            lineHeight: typography.body.lineHeight,
          }}
        >
          {en.consent.body}
        </Text>

        <Pressable
          testID="health-consent-privacy-link"
          accessibilityRole="link"
          accessibilityLabel={en.consent.privacyLinkA11y}
          onPress={handlePrivacyPress}
          style={styles.privacyLink}
        >
          <Text
            style={{
              color: colors.primary,
              fontSize: typography.label.fontSize,
              lineHeight: typography.label.lineHeight,
              fontWeight: typography.label.fontWeight,
              textDecorationLine: 'underline',
            }}
          >
            {en.consent.privacyLinkLabel}
          </Text>
        </Pressable>
      </View>

      <Pressable
        testID="health-consent-checkbox"
        accessibilityRole="checkbox"
        accessibilityLabel={en.consent.checkboxLabel}
        accessibilityState={{ checked: isChecked, disabled: isSubmitting }}
        onPress={handleToggleCheckbox}
        style={[
          styles.checkboxRow,
          {
            backgroundColor: colors.surface,
            borderColor: isChecked ? colors.primary : colors.border,
            borderRadius: radii.md,
            padding: spacing.sm,
            gap: spacing.sm,
          },
        ]}
      >
        <View
          style={[
            styles.checkboxBox,
            {
              borderRadius: radii.sm,
              borderColor: isChecked ? colors.primary : colors.border,
              backgroundColor: isChecked ? colors.primary : colors.surface,
            },
          ]}
        >
          {isChecked ? (
            <Text
              style={{
                color: colors.onPrimary,
                fontSize: typography.label.fontSize,
                fontWeight: typography.label.fontWeight,
              }}
            >
              ✓
            </Text>
          ) : null}
        </View>
        <Text
          style={{
            flex: 1,
            color: colors.textPrimary,
            fontSize: typography.bodySmall.fontSize,
            lineHeight: typography.bodySmall.lineHeight,
          }}
        >
          {en.consent.checkboxLabel}
        </Text>
      </Pressable>

      {errorKind !== null ? (
        <View
          testID={errorKind === 'offline' ? 'health-consent-offline' : 'health-consent-error'}
          accessibilityRole="alert"
          style={[
            styles.noticeBox,
            {
              backgroundColor: colors.warningSurface,
              borderRadius: radii.md,
              padding: spacing.sm,
              gap: spacing.xxs,
            },
          ]}
        >
          <Text
            style={{
              color: colors.onWarningSurface,
              fontSize: typography.label.fontSize,
              lineHeight: typography.label.lineHeight,
              fontWeight: typography.label.fontWeight,
            }}
          >
            {errorKind === 'offline' ? en.consent.offlineTitle : en.consent.errorTitle}
          </Text>
          <Text
            style={{
              color: colors.onWarningSurface,
              fontSize: typography.bodySmall.fontSize,
              lineHeight: typography.bodySmall.lineHeight,
            }}
          >
            {errorKind === 'offline' ? en.consent.offlineMessage : en.consent.errorMessage}
          </Text>
        </View>
      ) : null}

      <View style={{ gap: spacing.xs }}>
        <View testID="health-consent-continue-button">
          <Button
            variant="primary"
            label={en.consent.continueCta}
            accessibilityLabel={en.consent.continueA11y}
            disabled={!isChecked}
            onPress={() => {
              void handleContinue();
            }}
          />
        </View>

        <View testID="health-consent-decline-button">
          <Button
            variant="secondary"
            label={en.consent.declineCta}
            accessibilityLabel={en.consent.declineA11y}
            onPress={handleDecline}
          />
        </View>
      </View>

      {isDeclined ? (
        <View
          testID="health-consent-declined-message"
          style={[
            styles.noticeBox,
            {
              backgroundColor: colors.surfaceMuted,
              borderRadius: radii.md,
              padding: spacing.sm,
              gap: spacing.xs,
            },
          ]}
        >
          <Text
            style={{
              color: colors.textPrimary,
              fontSize: typography.bodySmall.fontSize,
              lineHeight: typography.bodySmall.lineHeight,
            }}
          >
            {en.consent.declinedMessage}
          </Text>
          <View testID="health-consent-sign-out-button">
            <Button
              variant="danger"
              label={en.consent.signOutCta}
              accessibilityLabel={en.consent.signOutA11y}
              onPress={handleSignOutPress}
            />
          </View>
        </View>
      ) : null}

      <Text
        style={{
          color: colors.textMuted,
          fontSize: typography.caption.fontSize,
          lineHeight: typography.caption.lineHeight,
        }}
      >
        {en.common.notMedicalAdvice}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  privacyLink: {
    alignSelf: 'flex-start',
    minHeight: MIN_TOUCH_TARGET_PT,
    minWidth: MIN_TOUCH_TARGET_PT,
    justifyContent: 'center',
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: MIN_TOUCH_TARGET_PT,
    minWidth: MIN_TOUCH_TARGET_PT,
    borderWidth: 1,
  },
  checkboxBox: {
    width: 24,
    height: 24,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noticeBox: {
    width: '100%',
  },
});
