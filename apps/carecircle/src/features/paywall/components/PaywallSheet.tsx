import { Button, Card, ErrorState, MIN_TOUCH_TARGET_PT, Sheet, useTheme } from '@carecircle/ui';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import en from '../../../../i18n/en.json';

// Apple App Store Review Guideline 3.1.2(c) (Auto-Renewable Subscriptions):
// subscription paywalls must clearly display the billed price and billing period (`priceText`,
// formatted by the store from the RevenueCat package) alongside functional links to the
// Terms of Use and Privacy Policy:
// https://developer.apple.com/app-store/review/guidelines/#in-app-purchase (checked 2026-11-15)
export interface PaywallSheetProps {
  visible: boolean;
  onClose: () => void;
  onPurchase?: () => void | Promise<boolean | void>;
  onRestorePurchases?: () => void | Promise<boolean | void>;
  onRetry?: () => void;
  isLoading?: boolean;
  isOffline?: boolean;
  hasError?: boolean;
  isActive?: boolean;
  priceText?: string;
  onOpenTerms?: () => void;
  onOpenPrivacy?: () => void;
}

export function PaywallSheet({
  visible,
  onClose,
  onPurchase,
  onRestorePurchases,
  onRetry,
  isLoading = false,
  isOffline = false,
  hasError = false,
  isActive = false,
  priceText,
  onOpenTerms,
  onOpenPrivacy,
}: PaywallSheetProps) {
  const { colors, spacing, typography } = useTheme();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const isActionBlocked = isLoading || busy;

  const handlePurchase = useCallback(async () => {
    if (isLoading || busyRef.current || !onPurchase) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await onPurchase();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [isLoading, onPurchase]);

  const handleRestore = useCallback(async () => {
    if (isLoading || busyRef.current || !onRestorePurchases) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await onRestorePurchases();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [isLoading, onRestorePurchases]);

  const handleRetry = useCallback(() => {
    onRetry?.();
  }, [onRetry]);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={en.paywall.title}
      closeLabel={en.gallery.sheetClose}
    >
      <View testID="paywall-sheet" style={{ gap: spacing.md }}>
        <Text
          style={{
            color: colors.textSecondary,
            fontSize: typography.body.fontSize,
            lineHeight: typography.body.lineHeight,
          }}
        >
          {en.paywall.subtitle}
        </Text>

        {isLoading ? (
          <View testID="paywall-loading" style={[styles.statusBox, { gap: spacing.sm }]}>
            <ActivityIndicator color={colors.primary} />
            <Text
              style={{
                color: colors.textPrimary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              {en.paywall.loading}
            </Text>
          </View>
        ) : null}

        {isOffline ? (
          <View testID="paywall-offline">
            <ErrorState
              title={en.paywall.offlineTitle}
              message={en.paywall.offlineMessage}
              retryLabel={en.paywall.retry}
              onRetry={handleRetry}
            />
          </View>
        ) : null}

        {hasError && !isOffline ? (
          <View testID="paywall-error">
            <ErrorState
              title={en.paywall.errorTitle}
              message={en.paywall.errorMessage}
              retryLabel={en.paywall.retry}
              onRetry={handleRetry}
            />
          </View>
        ) : null}

        {isActive ? (
          <View testID="paywall-active">
            <Card>
              <Text
                style={{
                  color: colors.textPrimary,
                  fontSize: typography.subtitle.fontSize,
                  lineHeight: typography.subtitle.lineHeight,
                  fontWeight: typography.subtitle.fontWeight,
                  marginBottom: spacing.xs,
                }}
              >
                {en.paywall.activeTitle}
              </Text>
              <Text
                style={{
                  color: colors.textSecondary,
                  fontSize: typography.body.fontSize,
                  lineHeight: typography.body.lineHeight,
                }}
              >
                {en.paywall.activeBody}
              </Text>
            </Card>
          </View>
        ) : (
          <View style={{ gap: spacing.sm }}>
            <Text
              testID="paywall-price"
              style={{
                color: colors.textPrimary,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {priceText ?? en.paywall.defaultPrice}
            </Text>

            <Button
              label={en.paywall.subscribeCta}
              accessibilityLabel={en.paywall.subscribeA11y}
              disabled={isActionBlocked}
              onPress={() => {
                void handlePurchase();
              }}
            />

            <Button
              variant="secondary"
              label={en.paywall.restoreCta}
              accessibilityLabel={en.paywall.restoreA11y}
              disabled={isActionBlocked}
              onPress={() => {
                void handleRestore();
              }}
            />

            <View style={[styles.legalRow, { gap: spacing.md }]}>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={en.paywall.termsA11y}
                onPress={onOpenTerms}
                style={styles.legalLink}
              >
                <Text
                  style={{
                    color: colors.textSecondary,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                    textDecorationLine: 'underline',
                  }}
                >
                  {en.paywall.termsLabel}
                </Text>
              </Pressable>

              <Pressable
                accessibilityRole="link"
                accessibilityLabel={en.paywall.privacyA11y}
                onPress={onOpenPrivacy}
                style={styles.legalLink}
              >
                <Text
                  style={{
                    color: colors.textSecondary,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                    textDecorationLine: 'underline',
                  }}
                >
                  {en.paywall.privacyLabel}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  statusBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
  },
  legalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  legalLink: {
    minHeight: MIN_TOUCH_TARGET_PT,
    minWidth: MIN_TOUCH_TARGET_PT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
});
