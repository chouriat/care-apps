import {
  createAiGatewayClient,
  type AiErrorCode,
  type AiFetch,
  type AiGatewayResponse,
} from '@carecircle/ai-gateway/client';
import {
  extractPrescriptionOutputSchema,
  type ExtractPrescriptionOutput,
} from '@carecircle/ai-gateway/schemas/carecircle/extractPrescription';
import {
  circleRowSchema,
  medicationRowSchema,
  memberRoleSchema,
  scheduleSchema,
  validateAnalyticsEvent,
  type Medication,
  type MedicationRow,
  type MedicationSchedule,
  type MemberRole,
} from '@carecircle/core';
import {
  Button,
  Card,
  Header,
  LOW_CONFIDENCE_THRESHOLD,
  MIN_TOUCH_TARGET_PT,
  useTheme,
} from '@carecircle/ui';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import en from '../../../i18n/en.json';
import { getSupabaseClient, resolveSupabaseConfig } from '../auth/api';
import { loadCareCircleMocks } from '../mocks';
import { getAppObservability } from '../observability/api';
import { PaywallSheet } from '../paywall/components';
import { loadTodaySnapshot, type TodayDeps } from '../today/api';
import {
  MAX_PRESCRIPTION_PHOTO_BYTES,
  createPrescriptionPhotoId,
  deletePrescriptionPhoto,
  uploadPrescriptionPhoto,
  type RxStorageSupabaseLike,
} from './rx-storage';

export const MAX_SCAN_IMAGE_DIMENSION_PX = 1600;
export const SCAN_JPEG_QUALITY = 0.8;

export interface PickedPrescriptionPhoto {
  bytes: Uint8Array;
  width: number;
  height: number;
  contentType: string;
}

export interface PrescriptionPhotoCaptureOptions {
  maxDimensionPx: number;
  jpegQuality: number;
}

export interface PrescriptionPhotoPickerAdapter {
  takePhoto: (options: PrescriptionPhotoCaptureOptions) => Promise<PickedPrescriptionPhoto | null>;
  pickPhoto: (options: PrescriptionPhotoCaptureOptions) => Promise<PickedPrescriptionPhoto | null>;
  resizeAndConvertToJpeg?: (
    photo: PickedPrescriptionPhoto,
    options: PrescriptionPhotoCaptureOptions,
  ) => Promise<PickedPrescriptionPhoto>;
}

export interface ScanDeps extends TodayDeps {
  supabase?: RxStorageSupabaseLike & Pick<SupabaseClient, 'from'>;
  getAccessToken?: () => Promise<string | null> | string | null;
  aiFetch?: AiFetch;
  callExtractPrescription?: (input: {
    imagePath: string;
  }) => Promise<AiGatewayResponse<ExtractPrescriptionOutput>>;
  photoPicker?: PrescriptionPhotoPickerAdapter;
  photoId?: string;
  trackMedAddedFromPhoto?: () => void;
}

export async function preparePrescriptionPhotoForUpload(
  photo: PickedPrescriptionPhoto,
  resizer?: PrescriptionPhotoPickerAdapter['resizeAndConvertToJpeg'],
): Promise<{ bytes: Uint8Array; contentType: 'image/jpeg' }> {
  let processed = photo;
  const needsConversion =
    processed.width > MAX_SCAN_IMAGE_DIMENSION_PX ||
    processed.height > MAX_SCAN_IMAGE_DIMENSION_PX ||
    processed.contentType.trim().toLowerCase() !== 'image/jpeg';

  if (needsConversion && resizer) {
    processed = await resizer(processed, {
      maxDimensionPx: MAX_SCAN_IMAGE_DIMENSION_PX,
      jpegQuality: SCAN_JPEG_QUALITY,
    });
  }

  if (
    processed.width > MAX_SCAN_IMAGE_DIMENSION_PX ||
    processed.height > MAX_SCAN_IMAGE_DIMENSION_PX
  ) {
    throw new Error(
      `Prescription photo dimensions (${processed.width}x${processed.height}) exceed ${MAX_SCAN_IMAGE_DIMENSION_PX}px`,
    );
  }

  if (processed.contentType.trim().toLowerCase() !== 'image/jpeg') {
    throw new Error('Prescription photo must be converted to image/jpeg before upload');
  }

  if (
    processed.bytes.byteLength === 0 ||
    processed.bytes.byteLength > MAX_PRESCRIPTION_PHOTO_BYTES
  ) {
    throw new Error('Prescription photo size must be between 1 byte and 2 MB');
  }

  return {
    bytes: processed.bytes,
    contentType: 'image/jpeg',
  };
}

export type ScanPrescriptionResult =
  | {
      ok: true;
      imagePath: string;
      draft: ExtractPrescriptionOutput;
    }
  | {
      ok: false;
      imagePath: string | null;
      errorCode: AiErrorCode | 'UPLOAD_FAILED' | 'FORBIDDEN_ROLE';
    };

export async function scanPrescriptionPhoto(
  input: {
    circleId: string;
    memberRole?: MemberRole;
    photo: PickedPrescriptionPhoto;
    existingImagePath?: string | null;
  },
  deps: ScanDeps = {},
): Promise<ScanPrescriptionResult> {
  if (input.memberRole === 'viewer') {
    return { ok: false, imagePath: null, errorCode: 'FORBIDDEN_ROLE' };
  }

  const mocks = loadCareCircleMocks(deps.env);
  const supabase =
    deps.supabase ??
    (getSupabaseClient() as unknown as RxStorageSupabaseLike & Pick<SupabaseClient, 'from'>);

  let imagePath = input.existingImagePath ?? null;

  if (!imagePath) {
    try {
      const prepared = await preparePrescriptionPhotoForUpload(
        input.photo,
        deps.photoPicker?.resizeAndConvertToJpeg,
      );
      const uploaded = await uploadPrescriptionPhoto({
        supabase,
        circleId: input.circleId,
        photoId: deps.photoId,
        bytes: prepared.bytes,
        contentType: prepared.contentType,
      });
      imagePath = uploaded.imagePath;
    } catch {
      return { ok: false, imagePath: null, errorCode: 'UPLOAD_FAILED' };
    }
  }

  if (mocks && !deps.callExtractPrescription && !deps.aiFetch) {
    return {
      ok: true,
      imagePath,
      draft: extractPrescriptionOutputSchema.parse(mocks.aiResponses.extractPrescription),
    };
  }

  let gatewayResponse: AiGatewayResponse<ExtractPrescriptionOutput>;
  if (deps.callExtractPrescription) {
    gatewayResponse = await deps.callExtractPrescription({ imagePath });
  } else {
    const baseUrl = resolveSupabaseConfig(deps.env, true).url;
    const getAccessToken =
      deps.getAccessToken ??
      (async () => {
        const { data } = await getSupabaseClient().auth.getSession();
        return data.session?.access_token ?? null;
      });
    const client = createAiGatewayClient({
      baseUrl,
      getAccessToken,
      fetchImpl: deps.aiFetch,
    });
    gatewayResponse = await client.call(
      {
        requestId: createPrescriptionPhotoId(),
        task: 'carecircle.extractPrescription',
        input: { imagePath },
      },
      extractPrescriptionOutputSchema,
    );
  }

  if (!gatewayResponse.ok) {
    return {
      ok: false,
      imagePath,
      errorCode: gatewayResponse.error.code,
    };
  }

  return {
    ok: true,
    imagePath,
    draft: gatewayResponse.output,
  };
}

function medicationFromRow(row: MedicationRow): Medication {
  return {
    id: row.id,
    circleId: row.circle_id,
    name: row.name,
    strength: row.strength,
    doseText: row.dose_text,
    schedule: row.schedule,
    instructions: row.instructions,
    startDate: row.start_date,
    endDate: row.end_date,
    active: row.active,
    source: row.source,
  };
}

function defaultTrackMedAddedFromPhoto(): void {
  const payload = validateAnalyticsEvent('cc_med_added', { source: 'photo' });
  void getAppObservability()
    .analytics.track('cc_med_added', payload as { source: 'photo' })
    .catch(() => undefined);
}

export async function confirmAndSaveScannedMedication(
  input: {
    circleId: string;
    memberRole?: MemberRole;
    imagePath: string;
    name: string;
    strength: string | null;
    doseText: string;
    schedule: MedicationSchedule;
    instructions: string | null;
  },
  deps: ScanDeps = {},
): Promise<
  | { ok: true; medication: Medication }
  | { ok: false; errorCode: 'FORBIDDEN_ROLE' | 'VALIDATION_ERROR' | 'SAVE_FAILED' }
> {
  if (input.memberRole === 'viewer') {
    return { ok: false, errorCode: 'FORBIDDEN_ROLE' };
  }

  const name = input.name.trim();
  const doseText = input.doseText.trim();
  const strength = input.strength?.trim() || null;
  const instructions = input.instructions?.trim() || null;
  const parsedSchedule = scheduleSchema.safeParse(input.schedule);

  if (!name || !doseText || !parsedSchedule.success) {
    return { ok: false, errorCode: 'VALIDATION_ERROR' };
  }

  const supabase =
    deps.supabase ??
    (getSupabaseClient() as unknown as RxStorageSupabaseLike & Pick<SupabaseClient, 'from'>);
  const trackMedAdded = deps.trackMedAddedFromPhoto ?? defaultTrackMedAddedFromPhoto;

  try {
    const res = await supabase
      .from('medications')
      .insert({
        circle_id: input.circleId,
        name,
        strength,
        dose_text: doseText,
        schedule: parsedSchedule.data,
        instructions,
        active: true,
        source: 'photo',
      })
      .select('*');

    if (res.error) {
      return { ok: false, errorCode: 'SAVE_FAILED' };
    }

    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length === 0) {
      return { ok: false, errorCode: 'SAVE_FAILED' };
    }

    const medication = medicationFromRow(medicationRowSchema.parse(rows[0]));
    trackMedAdded();
    await loadTodaySnapshot(deps);

    // Best-effort cleanup of the prescription photo after save; never block save if delete fails.
    try {
      await deletePrescriptionPhoto({
        supabase,
        imagePath: input.imagePath,
      });
    } catch {
      // Leftover photos are cleaned up after 24 hours by cleanup-prescription-photos.
    }

    return { ok: true, medication };
  } catch {
    return { ok: false, errorCode: 'SAVE_FAILED' };
  }
}

export async function discardScannedMedication(
  input: { imagePath: string | null },
  deps: ScanDeps = {},
): Promise<void> {
  if (!input.imagePath) return;
  const supabase =
    deps.supabase ??
    (getSupabaseClient() as unknown as RxStorageSupabaseLike & Pick<SupabaseClient, 'from'>);
  try {
    await deletePrescriptionPhoto({
      supabase,
      imagePath: input.imagePath,
    });
  } catch {
    // Ignore delete failure on discard; hourly cleanup job removes leftover objects.
  }
}

export async function loadScanContext(
  deps: ScanDeps = {},
): Promise<{ circleId: string; memberRole: MemberRole }> {
  const mocks = loadCareCircleMocks(deps.env);
  if (mocks) {
    return { circleId: mocks.circle.id, memberRole: 'owner' };
  }
  const supabase =
    deps.supabase ??
    (getSupabaseClient() as unknown as RxStorageSupabaseLike & Pick<SupabaseClient, 'from'>);
  try {
    const userId = deps.getUserId
      ? await deps.getUserId()
      : ((await getSupabaseClient().auth.getSession()).data.session?.user.id ?? null);
    const circlesRes = await supabase
      .from('circles')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(1);
    const circleRows = Array.isArray(circlesRes.data) ? circlesRes.data : [];
    if (circleRows.length === 0) {
      return { circleId: '', memberRole: 'viewer' };
    }
    const rawCircle = { ...(circleRows[0] as Record<string, unknown>) };
    if (typeof rawCircle.created_at === 'string') {
      const d = new Date(rawCircle.created_at);
      if (!Number.isNaN(d.getTime())) rawCircle.created_at = d.toISOString();
    }
    const circle = circleRowSchema.parse(rawCircle);
    const roleRes = await supabase
      .from('circle_members')
      .select('role')
      .eq('circle_id', circle.id)
      .eq('user_id', userId ?? '00000000-0000-0000-0000-000000000000');
    const memberRows = Array.isArray(roleRes.data) ? roleRes.data : [];
    const firstRole = (memberRows[0] as { role?: unknown } | undefined)?.role;
    const parsedRole = memberRoleSchema.safeParse(firstRole);
    return {
      circleId: circle.id,
      memberRole: parsedRole.success ? parsedRole.data : 'viewer',
    };
  } catch {
    return { circleId: '', memberRole: 'viewer' };
  }
}

export interface PrescriptionScanScreenProps {
  circleId?: string;
  memberRole?: MemberRole;
  deps?: ScanDeps;
  onNavigateSignIn?: () => void;
  onNavigateManualEntry?: () => void;
  onSaved?: (medication: Medication) => void;
}

export function PrescriptionScanScreen({
  circleId: initialCircleId,
  memberRole: initialMemberRole,
  deps,
  onNavigateSignIn,
  onNavigateManualEntry,
  onSaved,
}: PrescriptionScanScreenProps) {
  const { colors, radii, spacing, typography } = useTheme();
  const [circleId, setCircleId] = useState(initialCircleId ?? '');
  const [memberRole, setMemberRole] = useState<MemberRole>(initialMemberRole ?? 'viewer');
  const [isScanning, setIsScanning] = useState(false);
  const [lastPhoto, setLastPhoto] = useState<PickedPrescriptionPhoto | null>(null);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExtractPrescriptionOutput | null>(null);
  const [errorCode, setErrorCode] = useState<
    AiErrorCode | 'UPLOAD_FAILED' | 'FORBIDDEN_ROLE' | null
  >(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [paywallVisible, setPaywallVisible] = useState(false);

  // Editable draft fields
  const [name, setName] = useState('');
  const [strength, setStrength] = useState('');
  const [doseText, setDoseText] = useState('');
  const [timesText, setTimesText] = useState('08:00');
  const [instructions, setInstructions] = useState('');

  useEffect(() => {
    if (initialCircleId !== undefined && initialMemberRole !== undefined) {
      setCircleId(initialCircleId);
      setMemberRole(initialMemberRole);
      return;
    }
    let cancelled = false;
    void (async () => {
      const ctx = await loadScanContext(deps);
      if (cancelled) return;
      if (initialCircleId === undefined) setCircleId(ctx.circleId);
      if (initialMemberRole === undefined) setMemberRole(ctx.memberRole);
    })();
    return () => {
      cancelled = true;
    };
  }, [deps, initialCircleId, initialMemberRole]);

  const applyDraft = useCallback((extracted: ExtractPrescriptionOutput) => {
    setDraft(extracted);
    setName(extracted.name);
    setStrength(extracted.strength ?? '');
    setDoseText(extracted.doseText);
    setTimesText(
      extracted.schedule.kind === 'as_needed' ? '' : extracted.schedule.times.join(', '),
    );
    setInstructions(extracted.instructions ?? '');
  }, []);

  const runScanWithPhoto = useCallback(
    async (photo: PickedPrescriptionPhoto, existingPath?: string | null) => {
      setIsScanning(true);
      setErrorCode(null);
      setSaveFailed(false);
      setLastPhoto(photo);

      const res = await scanPrescriptionPhoto(
        {
          circleId,
          memberRole,
          photo,
          existingImagePath: existingPath ?? null,
        },
        deps,
      );

      setIsScanning(false);
      setImagePath(res.imagePath);

      if (res.ok) {
        applyDraft(res.draft);
        return;
      }

      if (res.errorCode === 'UNAUTHENTICATED') {
        onNavigateSignIn?.();
        return;
      }

      setErrorCode(res.errorCode);
    },
    [applyDraft, circleId, deps, memberRole, onNavigateSignIn],
  );

  const handleCapture = useCallback(
    async (mode: 'take' | 'pick') => {
      if (memberRole === 'viewer' || isScanning) return;
      const picker = deps?.photoPicker;
      if (!picker) return;
      const options: PrescriptionPhotoCaptureOptions = {
        maxDimensionPx: MAX_SCAN_IMAGE_DIMENSION_PX,
        jpegQuality: SCAN_JPEG_QUALITY,
      };
      const picked =
        mode === 'take' ? await picker.takePhoto(options) : await picker.pickPhoto(options);
      if (!picked) return;
      await runScanWithPhoto(picked, null);
    },
    [deps?.photoPicker, isScanning, memberRole, runScanWithPhoto],
  );

  const handleDiscard = useCallback(async () => {
    const pathToDelete = imagePath;
    setDraft(null);
    setImagePath(null);
    setErrorCode(null);
    setSaveFailed(false);
    await discardScannedMedication({ imagePath: pathToDelete }, deps);
  }, [deps, imagePath]);

  const handleConfirmSave = useCallback(async () => {
    if (!draft || !imagePath) return;
    setSaveFailed(false);

    const times = timesText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    let nextSchedule: MedicationSchedule = draft.schedule;
    if (draft.schedule.kind === 'daily') {
      nextSchedule = { kind: 'daily', times };
    } else if (draft.schedule.kind === 'weekly') {
      nextSchedule = { kind: 'weekly', days: draft.schedule.days, times };
    } else if (draft.schedule.kind === 'every_n_days') {
      nextSchedule = { kind: 'every_n_days', n: draft.schedule.n, times };
    }

    const res = await confirmAndSaveScannedMedication(
      {
        circleId,
        memberRole,
        imagePath,
        name,
        strength: strength.trim() || null,
        doseText,
        schedule: nextSchedule,
        instructions: instructions.trim() || null,
      },
      deps,
    );

    if (!res.ok) {
      setSaveFailed(true);
      return;
    }

    setDraft(null);
    setImagePath(null);
    onSaved?.(res.medication);
  }, [
    circleId,
    deps,
    doseText,
    draft,
    imagePath,
    instructions,
    memberRole,
    name,
    onSaved,
    strength,
    timesText,
  ]);

  const canScan = memberRole === 'owner' || memberRole === 'helper';

  const isLowConfidence = (score?: number): boolean =>
    typeof score === 'number' && score < LOW_CONFIDENCE_THRESHOLD;

  return (
    <ScrollView
      testID="meds-scan-screen"
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
      <Header title={en.medsScan.title} subtitle={en.medsScan.subtitle} />

      {!canScan ? (
        <Card>
          <Text
            testID="scan-viewer-restricted"
            style={{
              color: colors.textSecondary,
              fontSize: typography.body.fontSize,
              lineHeight: typography.body.lineHeight,
            }}
          >
            {en.medsScan.viewerRestricted}
          </Text>
        </Card>
      ) : null}

      {canScan && !draft && !isScanning ? (
        <View style={[styles.captureRow, { gap: spacing.sm }]}>
          <View testID="scan-take-photo-button" style={styles.flexButton}>
            <Button
              label={en.medsScan.takePhotoCta}
              accessibilityLabel={en.medsScan.takePhotoCta}
              onPress={() => {
                void handleCapture('take');
              }}
            />
          </View>
          <View testID="scan-pick-photo-button" style={styles.flexButton}>
            <Button
              variant="secondary"
              label={en.medsScan.pickPhotoCta}
              accessibilityLabel={en.medsScan.pickPhotoCta}
              onPress={() => {
                void handleCapture('pick');
              }}
            />
          </View>
        </View>
      ) : null}

      {isScanning ? (
        <View testID="scan-loading" style={[styles.statusRow, { gap: spacing.sm }]}>
          <ActivityIndicator color={colors.primary} />
          <Text
            style={{
              color: colors.textPrimary,
              fontSize: typography.body.fontSize,
              lineHeight: typography.body.lineHeight,
            }}
          >
            {en.medsScan.scanning}
          </Text>
        </View>
      ) : null}

      {errorCode === 'QUOTA_EXCEEDED' ? (
        <Card>
          <View testID="scan-error-quota" style={{ gap: spacing.sm }}>
            <Text
              style={{
                color: colors.danger,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.medsScan.errorQuotaTitle}
            </Text>
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              {en.medsScan.errorQuotaMessage}
            </Text>
            <View testID="scan-quota-paywall-button">
              <Button
                label={en.medsScan.upgradeCta}
                accessibilityLabel={en.medsScan.upgradeCta}
                onPress={() => setPaywallVisible(true)}
              />
            </View>
          </View>
        </Card>
      ) : null}

      {errorCode === 'INPUT_INVALID' || errorCode === 'UPLOAD_FAILED' ? (
        <Card>
          <View testID="scan-error-input-invalid" style={{ gap: spacing.sm }}>
            <Text
              style={{
                color: colors.danger,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.medsScan.errorInputInvalidTitle}
            </Text>
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              {en.medsScan.errorInputInvalidMessage}
            </Text>
            <View testID="scan-retake-button">
              <Button
                label={en.medsScan.retakeCta}
                accessibilityLabel={en.medsScan.retakeCta}
                onPress={() => {
                  setErrorCode(null);
                  void handleCapture('take');
                }}
              />
            </View>
          </View>
        </Card>
      ) : null}

      {errorCode === 'SCHEMA_INVALID' ? (
        <Card>
          <View testID="scan-error-schema-invalid" style={{ gap: spacing.sm }}>
            <Text
              style={{
                color: colors.danger,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.medsScan.errorSchemaInvalidTitle}
            </Text>
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              {en.medsScan.errorSchemaInvalidMessage}
            </Text>
            <View testID="scan-manual-entry-button">
              <Button
                label={en.medsScan.manualEntryCta}
                accessibilityLabel={en.medsScan.manualEntryCta}
                onPress={() => {
                  void handleDiscard();
                  onNavigateManualEntry?.();
                }}
              />
            </View>
          </View>
        </Card>
      ) : null}

      {errorCode === 'PROVIDER_ERROR' ? (
        <Card>
          <View testID="scan-error-provider" style={{ gap: spacing.sm }}>
            <Text
              style={{
                color: colors.danger,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.medsScan.errorProviderTitle}
            </Text>
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              {en.medsScan.errorProviderMessage}
            </Text>
            <View testID="scan-retry-button">
              <Button
                label={en.medsScan.retryCta}
                accessibilityLabel={en.medsScan.retryCta}
                onPress={() => {
                  if (lastPhoto) {
                    void runScanWithPhoto(lastPhoto, imagePath);
                  }
                }}
              />
            </View>
          </View>
        </Card>
      ) : null}

      {saveFailed ? (
        <Card>
          <View testID="scan-not-saved-notice" style={{ gap: spacing.xs }}>
            <Text
              style={{
                color: colors.danger,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.medsScan.notSavedTitle}
            </Text>
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              {en.medsScan.notSavedMessage}
            </Text>
          </View>
        </Card>
      ) : null}

      {draft ? (
        <Card>
          <View testID="scan-draft-review" style={{ gap: spacing.sm }}>
            <Text
              style={{
                color: colors.textPrimary,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.medsScan.reviewHeading}
            </Text>
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              {en.medsScan.reviewSubheading}
            </Text>

            <View style={{ gap: spacing.xs }}>
              <View style={styles.fieldHeader}>
                <Text style={{ color: colors.textPrimary }}>{en.medsScan.nameLabel}</Text>
                {isLowConfidence(draft.fieldConfidence.name) ? (
                  <Text
                    testID="scan-low-confidence-name"
                    style={{
                      color: colors.onWarningSurface,
                      backgroundColor: colors.warningSurface,
                    }}
                  >
                    {en.medsScan.lowConfidenceBadge}
                  </Text>
                ) : null}
              </View>
              <TextInput
                testID="scan-draft-name-input"
                accessibilityLabel={en.medsScan.nameLabel}
                value={name}
                onChangeText={setName}
                style={[
                  styles.input,
                  {
                    backgroundColor: isLowConfidence(draft.fieldConfidence.name)
                      ? colors.warningSurface
                      : colors.surface,
                    borderColor: colors.border,
                    borderRadius: radii.md,
                    color: colors.textPrimary,
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.sm,
                  },
                ]}
              />
            </View>

            <View style={{ gap: spacing.xs }}>
              <View style={styles.fieldHeader}>
                <Text style={{ color: colors.textPrimary }}>{en.medsScan.strengthLabel}</Text>
                {isLowConfidence(draft.fieldConfidence.strength) ? (
                  <Text
                    testID="scan-low-confidence-strength"
                    style={{
                      color: colors.onWarningSurface,
                      backgroundColor: colors.warningSurface,
                    }}
                  >
                    {en.medsScan.lowConfidenceBadge}
                  </Text>
                ) : null}
              </View>
              <TextInput
                testID="scan-draft-strength-input"
                accessibilityLabel={en.medsScan.strengthLabel}
                value={strength}
                onChangeText={setStrength}
                style={[
                  styles.input,
                  {
                    backgroundColor: isLowConfidence(draft.fieldConfidence.strength)
                      ? colors.warningSurface
                      : colors.surface,
                    borderColor: colors.border,
                    borderRadius: radii.md,
                    color: colors.textPrimary,
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.sm,
                  },
                ]}
              />
            </View>

            <View style={{ gap: spacing.xs }}>
              <View style={styles.fieldHeader}>
                <Text style={{ color: colors.textPrimary }}>{en.medsScan.doseTextLabel}</Text>
                {isLowConfidence(draft.fieldConfidence.doseText) ? (
                  <Text
                    testID="scan-low-confidence-doseText"
                    style={{
                      color: colors.onWarningSurface,
                      backgroundColor: colors.warningSurface,
                    }}
                  >
                    {en.medsScan.lowConfidenceBadge}
                  </Text>
                ) : null}
              </View>
              <TextInput
                testID="scan-draft-dose-text-input"
                accessibilityLabel={en.medsScan.doseTextLabel}
                value={doseText}
                onChangeText={setDoseText}
                style={[
                  styles.input,
                  {
                    backgroundColor: isLowConfidence(draft.fieldConfidence.doseText)
                      ? colors.warningSurface
                      : colors.surface,
                    borderColor: colors.border,
                    borderRadius: radii.md,
                    color: colors.textPrimary,
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.sm,
                  },
                ]}
              />
            </View>

            {draft.schedule.kind !== 'as_needed' ? (
              <View style={{ gap: spacing.xs }}>
                <View style={styles.fieldHeader}>
                  <Text style={{ color: colors.textPrimary }}>{en.medsScan.scheduleLabel}</Text>
                  {isLowConfidence(draft.fieldConfidence.schedule) ? (
                    <Text
                      testID="scan-low-confidence-schedule"
                      style={{
                        color: colors.onWarningSurface,
                        backgroundColor: colors.warningSurface,
                      }}
                    >
                      {en.medsScan.lowConfidenceBadge}
                    </Text>
                  ) : null}
                </View>
                <TextInput
                  testID="scan-draft-schedule-times-input"
                  accessibilityLabel={en.medsScan.scheduleLabel}
                  value={timesText}
                  onChangeText={setTimesText}
                  style={[
                    styles.input,
                    {
                      backgroundColor: isLowConfidence(draft.fieldConfidence.schedule)
                        ? colors.warningSurface
                        : colors.surface,
                      borderColor: colors.border,
                      borderRadius: radii.md,
                      color: colors.textPrimary,
                      paddingHorizontal: spacing.md,
                      paddingVertical: spacing.sm,
                    },
                  ]}
                />
              </View>
            ) : null}

            <View style={{ gap: spacing.xs }}>
              <View style={styles.fieldHeader}>
                <Text style={{ color: colors.textPrimary }}>{en.medsScan.instructionsLabel}</Text>
                {isLowConfidence(draft.fieldConfidence.instructions) ? (
                  <Text
                    testID="scan-low-confidence-instructions"
                    style={{
                      color: colors.onWarningSurface,
                      backgroundColor: colors.warningSurface,
                    }}
                  >
                    {en.medsScan.lowConfidenceBadge}
                  </Text>
                ) : null}
              </View>
              <TextInput
                testID="scan-draft-instructions-input"
                accessibilityLabel={en.medsScan.instructionsLabel}
                value={instructions}
                onChangeText={setInstructions}
                style={[
                  styles.input,
                  {
                    backgroundColor: isLowConfidence(draft.fieldConfidence.instructions)
                      ? colors.warningSurface
                      : colors.surface,
                    borderColor: colors.border,
                    borderRadius: radii.md,
                    color: colors.textPrimary,
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.sm,
                  },
                ]}
              />
            </View>

            <Text
              testID="scan-draft-raw-text"
              style={{
                color: colors.textSecondary,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              {`${en.medsScan.rawTextLabel}: ${draft.rawText}`}
            </Text>

            <View style={[styles.captureRow, { gap: spacing.sm }]}>
              <View testID="scan-save-button" style={styles.flexButton}>
                <Button
                  label={en.medsScan.saveCta}
                  accessibilityLabel={en.medsScan.saveCta}
                  onPress={() => {
                    void handleConfirmSave();
                  }}
                />
              </View>
              <View testID="scan-discard-button" style={styles.flexButton}>
                <Button
                  variant="secondary"
                  label={en.medsScan.discardCta}
                  accessibilityLabel={en.medsScan.discardCta}
                  onPress={() => {
                    void handleDiscard();
                  }}
                />
              </View>
            </View>
          </View>
        </Card>
      ) : null}

      <Text
        testID="scan-not-medical-advice"
        style={{
          color: colors.textMuted,
          fontSize: typography.caption.fontSize,
          lineHeight: typography.caption.lineHeight,
        }}
      >
        {en.common.notMedicalAdvice}
      </Text>

      <PaywallSheet visible={paywallVisible} onClose={() => setPaywallVisible(false)} />
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
  captureRow: {
    flexDirection: 'row',
  },
  flexButton: {
    flex: 1,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  fieldHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  input: {
    minHeight: MIN_TOUCH_TARGET_PT,
    minWidth: MIN_TOUCH_TARGET_PT,
    borderWidth: 1,
  },
});
