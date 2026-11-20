import {
  scheduleSchema,
  type Medication,
  type MedicationSchedule,
  type MemberRole,
} from '@carecircle/core';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Header,
  MIN_TOUCH_TARGET_PT,
  useTheme,
} from '@carecircle/ui';
import { useCallback, useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import en from '../../../../i18n/en.json';
import type { ActiveMedicationItem } from '../api';

export interface MedicationFormDraft {
  name: string;
  strength: string;
  doseText: string;
  instructions: string;
  scheduleKind: 'daily' | 'weekly' | 'every_n_days' | 'as_needed';
  timesText: string;
  daysText: string;
  intervalText: string;
  startDate: string;
  endDate: string;
}

export interface ValidatedMedicationFormPayload {
  name: string;
  strength: string | null;
  doseText: string;
  schedule: MedicationSchedule;
  instructions: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface MedsScreenViewProps {
  circleTitle?: string;
  memberRole?: MemberRole;
  items?: ReadonlyArray<ActiveMedicationItem>;
  isLoading?: boolean;
  hasError?: boolean;
  isOffline?: boolean;
  notSavedNotice?: boolean;
  onRetry?: () => void;
  onScanPrescription?: () => void;
  onSaveMedication?: (
    payload: ValidatedMedicationFormPayload,
    editingMedicationId: string | null,
  ) => Promise<boolean> | boolean;
  onPauseMedication?: (medicationId: string) => Promise<boolean> | boolean;
}

const ISO_DATE_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function draftFromMedication(med?: Medication | null): MedicationFormDraft {
  if (!med) {
    return {
      name: '',
      strength: '',
      doseText: '',
      instructions: '',
      scheduleKind: 'daily',
      timesText: '08:00',
      daysText: 'mon, thu',
      intervalText: '2',
      startDate: '',
      endDate: '',
    };
  }

  const sched = med.schedule;
  return {
    name: med.name,
    strength: med.strength ?? '',
    doseText: med.doseText,
    instructions: med.instructions ?? '',
    scheduleKind: sched.kind,
    timesText: sched.kind === 'as_needed' ? '08:00' : sched.times.join(', '),
    daysText: sched.kind === 'weekly' ? sched.days.join(', ') : 'mon, thu',
    intervalText: sched.kind === 'every_n_days' ? String(sched.n) : '2',
    startDate: med.startDate ?? '',
    endDate: med.endDate ?? '',
  };
}

export function buildValidatedMedicationPayload(
  draft: MedicationFormDraft,
): ValidatedMedicationFormPayload | null {
  const name = draft.name.trim();
  const doseText = draft.doseText.trim();
  if (!name || !doseText) {
    return null;
  }

  const strength = draft.strength.trim() || null;
  const instructions = draft.instructions.trim() || null;
  const startDate = draft.startDate.trim() || null;
  const endDate = draft.endDate.trim() || null;

  if (startDate !== null && !ISO_DATE_REGEX.test(startDate)) {
    return null;
  }
  if (endDate !== null && !ISO_DATE_REGEX.test(endDate)) {
    return null;
  }

  const times = draft.timesText
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let rawSchedule: unknown;
  if (draft.scheduleKind === 'as_needed') {
    rawSchedule = { kind: 'as_needed' };
  } else if (draft.scheduleKind === 'daily') {
    rawSchedule = { kind: 'daily', times };
  } else if (draft.scheduleKind === 'weekly') {
    const days = draft.daysText
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    rawSchedule = { kind: 'weekly', days, times };
  } else {
    const n = Number.parseInt(draft.intervalText.trim(), 10);
    rawSchedule = { kind: 'every_n_days', n, times };
  }

  const parsedSchedule = scheduleSchema.safeParse(rawSchedule);
  if (!parsedSchedule.success) {
    return null;
  }

  return {
    name,
    strength,
    doseText,
    schedule: parsedSchedule.data,
    instructions,
    startDate,
    endDate,
  };
}

export interface MedicationFormTopNotice {
  title: string;
  detail?: string | null;
  testID?: string;
}

export interface MedicationFormCardProps {
  initialDraft: MedicationFormDraft;
  isEdit: boolean;
  topNotice?: MedicationFormTopNotice | null;
  onSubmit?: (payload: ValidatedMedicationFormPayload) => Promise<boolean> | boolean;
  onCancel: () => void;
}

export function MedicationFormCard({
  initialDraft,
  isEdit,
  topNotice = null,
  onSubmit,
  onCancel,
}: MedicationFormCardProps) {
  const { colors, radii, spacing, typography } = useTheme();
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { control, getValues, reset, setValue, watch } = useForm<MedicationFormDraft>({
    defaultValues: initialDraft,
  });

  useEffect(() => {
    setValidationError(null);
    reset(initialDraft);
  }, [initialDraft, reset]);

  const scheduleKind = watch('scheduleKind');

  const handleSubmitForm = useCallback(async () => {
    if (submitting) return;
    const payload = buildValidatedMedicationPayload(getValues());
    if (!payload) {
      setValidationError(en.meds.validationError);
      return;
    }

    setValidationError(null);
    if (!onSubmit) {
      onCancel();
      return;
    }

    setSubmitting(true);
    try {
      const ok = await onSubmit(payload);
      if (ok) {
        onCancel();
      }
    } finally {
      setSubmitting(false);
    }
  }, [getValues, onCancel, onSubmit, submitting]);

  return (
    <Card>
      <View testID="meds-form" style={{ gap: spacing.sm }}>
        {topNotice ? (
          <Card tone="warning">
            <View
              testID={topNotice.testID ?? 'visit-med-form-change-banner'}
              style={{ gap: spacing.xs }}
            >
              <Text
                style={{
                  color: colors.onWarningSurface,
                  fontSize: typography.subtitle.fontSize,
                  lineHeight: typography.subtitle.lineHeight,
                  fontWeight: typography.subtitle.fontWeight,
                }}
              >
                {topNotice.title}
              </Text>
              {topNotice.detail ? (
                <Text
                  style={{
                    color: colors.onWarningSurface,
                    fontSize: typography.bodySmall.fontSize,
                    lineHeight: typography.bodySmall.lineHeight,
                  }}
                >
                  {topNotice.detail}
                </Text>
              ) : null}
            </View>
          </Card>
        ) : null}

        <Text
          style={{
            color: colors.textPrimary,
            fontSize: typography.subtitle.fontSize,
            lineHeight: typography.subtitle.lineHeight,
            fontWeight: typography.subtitle.fontWeight,
          }}
        >
          {isEdit ? en.meds.formEditTitle : en.meds.formAddTitle}
        </Text>

        <Text
          style={{
            color: colors.textPrimary,
            fontSize: typography.body.fontSize,
            lineHeight: typography.body.lineHeight,
          }}
        >
          {en.meds.nameLabel}
        </Text>
        <Controller
          control={control}
          name="name"
          render={({ field: { value } }) => (
            <TextInput
              testID="meds-name-input"
              accessibilityLabel={en.meds.nameLabel}
              placeholder={en.meds.namePlaceholder}
              placeholderTextColor={colors.textMuted}
              editable={!submitting}
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
          }}
        >
          {en.meds.strengthLabel}
        </Text>
        <Controller
          control={control}
          name="strength"
          render={({ field: { value } }) => (
            <TextInput
              testID="meds-strength-input"
              accessibilityLabel={en.meds.strengthLabel}
              placeholder={en.meds.strengthPlaceholder}
              placeholderTextColor={colors.textMuted}
              editable={!submitting}
              value={value}
              onChangeText={(next) => setValue('strength', next)}
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
          }}
        >
          {en.meds.doseTextLabel}
        </Text>
        <Controller
          control={control}
          name="doseText"
          render={({ field: { value } }) => (
            <TextInput
              testID="meds-dose-text-input"
              accessibilityLabel={en.meds.doseTextLabel}
              placeholder={en.meds.doseTextPlaceholder}
              placeholderTextColor={colors.textMuted}
              editable={!submitting}
              value={value}
              onChangeText={(next) => {
                setValue('doseText', next);
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
          }}
        >
          {en.meds.scheduleKindLabel}
        </Text>
        <View style={[styles.scheduleKindRow, { gap: spacing.xs }]}>
          {(
            [
              ['daily', en.meds.scheduleKindDaily],
              ['weekly', en.meds.scheduleKindWeekly],
              ['every_n_days', en.meds.scheduleKindEveryNDays],
              ['as_needed', en.meds.scheduleKindAsNeeded],
            ] as const
          ).map(([kind, label]) => (
            <View key={kind} testID={`meds-schedule-kind-${kind}`}>
              <Button
                variant={scheduleKind === kind ? 'primary' : 'secondary'}
                label={label}
                accessibilityLabel={label}
                onPress={() => {
                  setValue('scheduleKind', kind);
                  if (validationError) setValidationError(null);
                }}
              />
            </View>
          ))}
        </View>

        {scheduleKind === 'weekly' ? (
          <Controller
            control={control}
            name="daysText"
            render={({ field: { value } }) => (
              <View style={{ gap: spacing.xs }}>
                <Text
                  style={{
                    color: colors.textPrimary,
                    fontSize: typography.body.fontSize,
                    lineHeight: typography.body.lineHeight,
                  }}
                >
                  {en.meds.daysLabel}
                </Text>
                <TextInput
                  testID="meds-days-input"
                  accessibilityLabel={en.meds.daysLabel}
                  placeholder={en.meds.daysPlaceholder}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={value}
                  onChangeText={(next) => {
                    setValue('daysText', next);
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
              </View>
            )}
          />
        ) : null}

        {scheduleKind === 'every_n_days' ? (
          <Controller
            control={control}
            name="intervalText"
            render={({ field: { value } }) => (
              <View style={{ gap: spacing.xs }}>
                <Text
                  style={{
                    color: colors.textPrimary,
                    fontSize: typography.body.fontSize,
                    lineHeight: typography.body.lineHeight,
                  }}
                >
                  {en.meds.intervalLabel}
                </Text>
                <TextInput
                  testID="meds-interval-input"
                  accessibilityLabel={en.meds.intervalLabel}
                  placeholder={en.meds.intervalPlaceholder}
                  placeholderTextColor={colors.textMuted}
                  keyboardType="number-pad"
                  value={value}
                  onChangeText={(next) => {
                    setValue('intervalText', next);
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
              </View>
            )}
          />
        ) : null}

        {scheduleKind !== 'as_needed' ? (
          <Controller
            control={control}
            name="timesText"
            render={({ field: { value } }) => (
              <View style={{ gap: spacing.xs }}>
                <Text
                  style={{
                    color: colors.textPrimary,
                    fontSize: typography.body.fontSize,
                    lineHeight: typography.body.lineHeight,
                  }}
                >
                  {en.meds.timesLabel}
                </Text>
                <TextInput
                  testID="meds-times-input"
                  accessibilityLabel={en.meds.timesLabel}
                  placeholder={en.meds.timesPlaceholder}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={value}
                  onChangeText={(next) => {
                    setValue('timesText', next);
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
              </View>
            )}
          />
        ) : null}

        <Text
          style={{
            color: colors.textPrimary,
            fontSize: typography.body.fontSize,
            lineHeight: typography.body.lineHeight,
          }}
        >
          {en.meds.instructionsLabel}
        </Text>
        <Controller
          control={control}
          name="instructions"
          render={({ field: { value } }) => (
            <TextInput
              testID="meds-instructions-input"
              accessibilityLabel={en.meds.instructionsLabel}
              placeholder={en.meds.instructionsPlaceholder}
              placeholderTextColor={colors.textMuted}
              value={value}
              onChangeText={(next) => setValue('instructions', next)}
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
            testID="meds-form-validation-error"
            style={{
              color: colors.danger,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            {validationError}
          </Text>
        ) : null}

        <View style={[styles.formActions, { gap: spacing.sm }]}>
          <View testID="meds-save-button" style={styles.actionButton}>
            <Button
              label={en.meds.saveCta}
              accessibilityLabel={en.meds.saveCta}
              disabled={submitting}
              onPress={() => {
                void handleSubmitForm();
              }}
            />
          </View>
          <View testID="meds-cancel-button" style={styles.actionButton}>
            <Button
              variant="secondary"
              label={en.meds.cancelCta}
              accessibilityLabel={en.meds.cancelCta}
              disabled={submitting}
              onPress={onCancel}
            />
          </View>
        </View>
      </View>
    </Card>
  );
}

export function MedsScreenView({
  circleTitle,
  memberRole = 'viewer',
  items = [],
  isLoading = false,
  hasError = false,
  isOffline = false,
  notSavedNotice = false,
  onRetry,
  onScanPrescription,
  onSaveMedication,
  onPauseMedication,
}: MedsScreenViewProps) {
  const { colors, spacing, typography } = useTheme();
  const canEdit = memberRole === 'owner' || memberRole === 'helper';

  const [formOpen, setFormOpen] = useState(false);
  const [editingMed, setEditingMed] = useState<Medication | null>(null);
  const [formDraft, setFormDraft] = useState<MedicationFormDraft>(() => draftFromMedication(null));

  useEffect(() => {
    if (!canEdit) {
      setFormOpen(false);
      setEditingMed(null);
    }
  }, [canEdit]);

  const openAddForm = useCallback(() => {
    setEditingMed(null);
    setFormDraft(draftFromMedication(null));
    setFormOpen(true);
  }, []);

  const openEditForm = useCallback((med: Medication) => {
    setEditingMed(med);
    setFormDraft(draftFromMedication(med));
    setFormOpen(true);
  }, []);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditingMed(null);
  }, []);

  const showStatusOnly = isLoading || hasError || isOffline;

  return (
    <ScrollView
      testID="meds-screen"
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
      <Header title={circleTitle ? `${en.meds.title} · ${circleTitle}` : en.meds.title} />

      {isLoading ? (
        <View testID="meds-loading" style={[styles.statusRow, { gap: spacing.sm }]}>
          <ActivityIndicator color={colors.primary} />
          <Text
            style={{
              color: colors.textPrimary,
              fontSize: typography.body.fontSize,
              lineHeight: typography.body.lineHeight,
            }}
          >
            {en.meds.loading}
          </Text>
        </View>
      ) : null}

      {isOffline ? (
        <View testID="meds-offline">
          <ErrorState
            title={en.meds.offlineTitle}
            message={en.meds.offlineMessage}
            retryLabel={en.meds.retry}
            onRetry={() => onRetry?.()}
          />
        </View>
      ) : null}

      {hasError && !isOffline ? (
        <View testID="meds-error">
          <ErrorState
            title={en.meds.errorTitle}
            message={en.meds.errorMessage}
            retryLabel={en.meds.retry}
            onRetry={() => onRetry?.()}
          />
        </View>
      ) : null}

      {notSavedNotice ? (
        <Card>
          <View testID="meds-not-saved-notice" style={{ gap: spacing.xs }}>
            <Text
              style={{
                color: colors.danger,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.meds.notSavedTitle}
            </Text>
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              {en.meds.notSavedMessage}
            </Text>
          </View>
        </Card>
      ) : null}

      {!showStatusOnly && canEdit && !formOpen ? (
        <View style={[styles.formActions, { gap: spacing.sm }]}>
          <View testID="meds-add-button" style={styles.actionButton}>
            <Button
              label={en.meds.addCta}
              accessibilityLabel={en.meds.addA11y}
              onPress={openAddForm}
            />
          </View>
          <View testID="meds-scan-button" style={styles.actionButton}>
            <Button
              variant="secondary"
              label={en.meds.scanCta}
              accessibilityLabel={en.meds.scanA11y}
              onPress={() => onScanPrescription?.()}
            />
          </View>
        </View>
      ) : null}

      {!showStatusOnly && canEdit && formOpen ? (
        <MedicationFormCard
          initialDraft={formDraft}
          isEdit={Boolean(editingMed)}
          onSubmit={
            onSaveMedication
              ? (payload) => onSaveMedication(payload, editingMed?.id ?? null)
              : undefined
          }
          onCancel={closeForm}
        />
      ) : null}

      {!showStatusOnly && items.length === 0 ? (
        <View testID="meds-empty-state">
          <EmptyState title={en.meds.emptyTitle} message={en.meds.emptyMessage} />
        </View>
      ) : null}

      {!showStatusOnly && items.length > 0 ? (
        <View testID="meds-list" style={{ gap: spacing.md }}>
          {items.map((item) => {
            const med = item.medication;
            return (
              <Card key={med.id}>
                <View testID={`meds-item-${med.id}`} style={{ gap: spacing.xs }}>
                  <Text
                    style={{
                      color: colors.textPrimary,
                      fontSize: typography.subtitle.fontSize,
                      lineHeight: typography.subtitle.lineHeight,
                      fontWeight: typography.subtitle.fontWeight,
                    }}
                  >
                    {med.strength ? `${med.name} (${med.strength})` : med.name}
                  </Text>
                  <Text
                    style={{
                      color: colors.textPrimary,
                      fontSize: typography.body.fontSize,
                      lineHeight: typography.body.lineHeight,
                    }}
                  >
                    {med.doseText}
                  </Text>
                  {med.instructions ? (
                    <Text
                      style={{
                        color: colors.textSecondary,
                        fontSize: typography.caption.fontSize,
                        lineHeight: typography.caption.lineHeight,
                      }}
                    >
                      {med.instructions}
                    </Text>
                  ) : null}
                  <Text
                    testID={`meds-schedule-${med.id}`}
                    style={{
                      color: colors.textSecondary,
                      fontSize: typography.caption.fontSize,
                      lineHeight: typography.caption.lineHeight,
                    }}
                  >
                    {item.scheduleSummary}
                  </Text>
                  <Text
                    testID={`meds-adherence-${med.id}`}
                    style={{
                      color: colors.textSecondary,
                      fontSize: typography.caption.fontSize,
                      lineHeight: typography.caption.lineHeight,
                    }}
                  >
                    {item.adherence7d.label}
                  </Text>

                  {canEdit ? (
                    <View style={[styles.itemActions, { gap: spacing.xs }]}>
                      <View testID={`meds-edit-${med.id}`}>
                        <Button
                          variant="secondary"
                          label={en.meds.editCta}
                          accessibilityLabel={`${en.meds.editCta} ${med.name}`}
                          onPress={() => openEditForm(med)}
                        />
                      </View>
                      <View testID={`meds-pause-${med.id}`}>
                        <Button
                          variant="secondary"
                          label={en.meds.pauseCta}
                          accessibilityLabel={`${en.meds.pauseCta} ${med.name}`}
                          onPress={() => {
                            void onPauseMedication?.(med.id);
                          }}
                        />
                      </View>
                    </View>
                  ) : null}
                </View>
              </Card>
            );
          })}
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
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    minHeight: MIN_TOUCH_TARGET_PT,
    minWidth: MIN_TOUCH_TARGET_PT,
    borderWidth: 1,
  },
  scheduleKindRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  formActions: {
    flexDirection: 'row',
  },
  actionButton: {
    flex: 1,
  },
  itemActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
});
