import { Button, Card, ErrorState, Header, MIN_TOUCH_TARGET_PT, useTheme } from '@carecircle/ui';
import { useCallback, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import en from '../../../../i18n/en.json';
import { parseInviteToken, type AcceptInviteErrorCode } from '../../circle/api';
import {
  createCircleFormSchema,
  resolveDefaultTimezone,
  type CreateCircleErrorCode,
  type CreateCircleFormValues,
} from '../api';

export type OnboardingMode = 'create' | 'join';

export interface OnboardingStartScreenProps {
  initialMode?: OnboardingMode;
  defaultTimezone?: string;
  isLoading?: boolean;
  isOffline?: boolean;
  hasError?: boolean;
  errorCode?: CreateCircleErrorCode | AcceptInviteErrorCode | null;
  onCreateCircle?: (values: CreateCircleFormValues) => void | Promise<boolean | void>;
  onJoinCircle?: (tokenOrUrl: string) => void | Promise<boolean | void>;
  onRetry?: () => void;
}

export function OnboardingStartScreen({
  initialMode = 'create',
  defaultTimezone,
  isLoading = false,
  isOffline = false,
  hasError = false,
  errorCode = null,
  onCreateCircle,
  onJoinCircle,
  onRetry,
}: OnboardingStartScreenProps) {
  const { colors, radii, spacing, typography } = useTheme();
  const [mode, setMode] = useState<OnboardingMode>(initialMode);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState('');
  const submittingRef = useRef(false);

  const initialTz = defaultTimezone ?? resolveDefaultTimezone();

  const { control, getValues, setValue } = useForm<CreateCircleFormValues>({
    defaultValues: {
      name: '',
      careRecipientName: '',
      timezone: initialTz,
    },
  });

  const busy = isLoading || submitting;

  const handleSubmitCreate = useCallback(async () => {
    if (busy || submittingRef.current) {
      return;
    }

    const rawValues = getValues();
    const parsed = createCircleFormSchema.safeParse({
      name: rawValues.name.trim(),
      careRecipientName: rawValues.careRecipientName.trim(),
      timezone: rawValues.timezone.trim(),
    });

    if (!parsed.success) {
      setValidationError(en.onboarding.validationError);
      return;
    }

    setValidationError(null);
    if (!onCreateCircle) {
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onCreateCircle(parsed.data);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [busy, getValues, onCreateCircle]);

  const handleSubmitJoin = useCallback(async () => {
    if (busy || submittingRef.current) {
      return;
    }

    const token = parseInviteToken(inviteLink);
    if (!token) {
      setValidationError(en.onboarding.joinInvalidMessage);
      return;
    }

    setValidationError(null);
    if (!onJoinCircle) {
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onJoinCircle(inviteLink.trim());
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [busy, inviteLink, onJoinCircle]);

  const handleRetry = useCallback(() => {
    setValidationError(null);
    if (onRetry) {
      onRetry();
    } else if (mode === 'join') {
      void handleSubmitJoin();
    } else {
      void handleSubmitCreate();
    }
  }, [handleSubmitCreate, handleSubmitJoin, mode, onRetry]);

  const errorMessage =
    errorCode === 'CIRCLE_LIMIT_REACHED' || errorCode === 'CIRCLE_LIMIT'
      ? en.onboarding.limitReachedMessage
      : errorCode === 'CIRCLE_FULL'
        ? en.onboarding.joinCircleFullMessage
        : errorCode === 'INVITE_EXPIRED'
          ? en.onboarding.joinExpiredMessage
          : errorCode === 'INVITE_USED'
            ? en.onboarding.joinUsedMessage
            : errorCode === 'INVITE_INVALID'
              ? en.onboarding.joinInvalidMessage
              : en.onboarding.errorMessage;

  return (
    <ScrollView
      testID="onboarding-start-screen"
      keyboardShouldPersistTaps="handled"
      style={[styles.screen, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.content,
        {
          padding: spacing.lg,
          gap: spacing.md,
        },
      ]}
    >
      <Header title={en.onboarding.title} />

      <Text
        style={{
          color: colors.textSecondary,
          fontSize: typography.body.fontSize,
          lineHeight: typography.body.lineHeight,
        }}
      >
        {en.onboarding.subtitle}
      </Text>

      <View style={[styles.choiceRow, { gap: spacing.sm }]}>
        <View testID="onboarding-choice-create" style={styles.choiceButton}>
          <Button
            variant={mode === 'create' ? 'primary' : 'secondary'}
            label={en.onboarding.choiceCreate}
            accessibilityLabel={en.onboarding.choiceCreateA11y}
            disabled={busy}
            onPress={() => {
              setMode('create');
              setValidationError(null);
            }}
          />
        </View>
        <View testID="onboarding-choice-join" style={styles.choiceButton}>
          <Button
            variant={mode === 'join' ? 'primary' : 'secondary'}
            label={en.onboarding.choiceJoin}
            accessibilityLabel={en.onboarding.choiceJoinA11y}
            disabled={busy}
            onPress={() => {
              setMode('join');
              setValidationError(null);
            }}
          />
        </View>
      </View>

      {busy ? (
        <View testID="onboarding-loading" style={[styles.statusBox, { gap: spacing.sm }]}>
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
      ) : null}

      {isOffline ? (
        <View testID="onboarding-offline">
          <ErrorState
            title={en.onboarding.offlineTitle}
            message={en.onboarding.offlineMessage}
            retryLabel={en.onboarding.retry}
            onRetry={handleRetry}
          />
        </View>
      ) : null}

      {hasError && !isOffline ? (
        <View testID="onboarding-error">
          <ErrorState
            title={en.onboarding.errorTitle}
            message={errorMessage}
            retryLabel={en.onboarding.retry}
            onRetry={handleRetry}
          />
        </View>
      ) : null}

      {mode === 'create' ? (
        <Card>
          <View testID="onboarding-create-form" style={{ gap: spacing.sm }}>
            <Text
              style={{
                color: colors.textPrimary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.onboarding.circleNameLabel}
            </Text>
            <Controller
              control={control}
              name="name"
              render={({ field: { value } }) => (
                <TextInput
                  testID="onboarding-circle-name-input"
                  accessibilityLabel={en.onboarding.circleNameLabel}
                  placeholder={en.onboarding.circleNamePlaceholder}
                  placeholderTextColor={colors.textMuted}
                  editable={!busy}
                  value={value}
                  onChangeText={(next) => {
                    setValue('name', next);
                    if (validationError) setValidationError(null);
                  }}
                  style={[
                    styles.input,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                      borderRadius: radii.md,
                      color: colors.textPrimary,
                      fontSize: typography.body.fontSize,
                      paddingHorizontal: spacing.md,
                      paddingVertical: spacing.sm,
                    },
                  ]}
                />
              )}
            />

            <Text
              style={{
                color: colors.textPrimary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.onboarding.careRecipientLabel}
            </Text>
            <Controller
              control={control}
              name="careRecipientName"
              render={({ field: { value } }) => (
                <TextInput
                  testID="onboarding-recipient-name-input"
                  accessibilityLabel={en.onboarding.careRecipientLabel}
                  placeholder={en.onboarding.careRecipientPlaceholder}
                  placeholderTextColor={colors.textMuted}
                  editable={!busy}
                  value={value}
                  onChangeText={(next) => {
                    setValue('careRecipientName', next);
                    if (validationError) setValidationError(null);
                  }}
                  style={[
                    styles.input,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                      borderRadius: radii.md,
                      color: colors.textPrimary,
                      fontSize: typography.body.fontSize,
                      paddingHorizontal: spacing.md,
                      paddingVertical: spacing.sm,
                    },
                  ]}
                />
              )}
            />

            <Text
              style={{
                color: colors.textPrimary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.onboarding.timezoneLabel}
            </Text>
            <Controller
              control={control}
              name="timezone"
              render={({ field: { value } }) => (
                <TextInput
                  testID="onboarding-timezone-input"
                  accessibilityLabel={en.onboarding.timezoneLabel}
                  placeholder={en.onboarding.timezonePlaceholder}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  value={value}
                  onChangeText={(next) => {
                    setValue('timezone', next);
                    if (validationError) setValidationError(null);
                  }}
                  style={[
                    styles.input,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                      borderRadius: radii.md,
                      color: colors.textPrimary,
                      fontSize: typography.body.fontSize,
                      paddingHorizontal: spacing.md,
                      paddingVertical: spacing.sm,
                    },
                  ]}
                />
              )}
            />

            {validationError ? (
              <Text
                testID="onboarding-validation-error"
                style={{
                  color: colors.danger,
                  fontSize: typography.caption.fontSize,
                  lineHeight: typography.caption.lineHeight,
                }}
              >
                {validationError}
              </Text>
            ) : null}

            <View testID="onboarding-submit-button">
              <Button
                label={en.onboarding.submitCreate}
                accessibilityLabel={en.onboarding.submitCreateA11y}
                disabled={busy}
                onPress={() => {
                  void handleSubmitCreate();
                }}
              />
            </View>
          </View>
        </Card>
      ) : (
        <Card>
          <View testID="onboarding-join-panel" style={{ gap: spacing.sm }}>
            <Text
              style={{
                color: colors.textPrimary,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.onboarding.joinTitle}
            </Text>
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              {en.onboarding.joinBody}
            </Text>
            <TextInput
              testID="onboarding-join-input"
              accessibilityLabel={en.onboarding.joinInputLabel}
              placeholder={en.onboarding.joinInputPlaceholder}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              value={inviteLink}
              onChangeText={(next) => {
                setInviteLink(next);
                if (validationError) setValidationError(null);
              }}
              style={[
                styles.input,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                  borderRadius: radii.md,
                  color: colors.textPrimary,
                  fontSize: typography.body.fontSize,
                  paddingHorizontal: spacing.md,
                  paddingVertical: spacing.sm,
                },
              ]}
            />

            {validationError ? (
              <Text
                testID="onboarding-validation-error"
                style={{
                  color: colors.danger,
                  fontSize: typography.caption.fontSize,
                  lineHeight: typography.caption.lineHeight,
                }}
              >
                {validationError}
              </Text>
            ) : null}

            <View testID="onboarding-join-button">
              <Button
                label={en.onboarding.submitJoin}
                accessibilityLabel={en.onboarding.submitJoinA11y}
                disabled={busy}
                onPress={() => {
                  void handleSubmitJoin();
                }}
              />
            </View>
          </View>
        </Card>
      )}

      <Text
        testID="onboarding-disclaimer"
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
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
  },
  choiceRow: {
    flexDirection: 'row',
  },
  choiceButton: {
    flex: 1,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET_PT,
    minWidth: MIN_TOUCH_TARGET_PT,
    borderWidth: 1,
  },
  statusBox: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
