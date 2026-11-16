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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import en from '../../../i18n/en.json';
import { getSupabaseClient, resolveSupabaseConfig } from '../auth/api';
import { loadCareCircleMocks } from '../mocks';
import { getAppObservability } from '../observability/api';
import { PaywallSheet } from '../paywall/components';
import { loadTodaySnapshot, type TodayDeps } from '../today/api';
import {
  PrescriptionPhotoPermissionError,
  createExpoPrescriptionPhotoPicker,
} from './photo-picker';
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
      errorCode: ScanErrorCode;
    };

/**
 * `PHOTO_INVALID`: the photo could not be turned into a JPEG of at most 1600 px and 2 MB (retake).
 * `UPLOAD_FAILED`: the upload itself failed, usually no network (try again with the same photo).
 * `PHOTO_PERMISSION_DENIED`: camera or library access refused.
 */
export type ScanErrorCode =
  | AiErrorCode
  | 'PHOTO_INVALID'
  | 'UPLOAD_FAILED'
  | 'FORBIDDEN_ROLE'
  | 'PHOTO_PERMISSION_DENIED';

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
    let prepared: Awaited<ReturnType<typeof preparePrescriptionPhotoForUpload>>;
    try {
      prepared = await preparePrescriptionPhotoForUpload(
        input.photo,
        deps.photoPicker?.resizeAndConvertToJpeg,
      );
    } catch {
      return { ok: false, imagePath: null, errorCode: 'PHOTO_INVALID' };
    }
    try {
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
  let savedMedication: Medication;

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
    savedMedication = medication;
  } catch {
    return { ok: false, errorCode: 'SAVE_FAILED' };
  }

  // The medicine is saved from here on. Nothing below may turn this into "Not saved": the person
  // would tap Save again and the circle would get the medicine (and every dose) twice.
  try {
    trackMedAdded();
  } catch {
    // Analytics never decides whether a medicine is saved.
  }

  // Best-effort cleanup of the prescription photo after save; never block save if delete fails.
  try {
    await deletePrescriptionPhoto({
      supabase,
      imagePath: input.imagePath,
    });
  } catch {
    // Leftover photos are removed within a day by cleanup-prescription-photos.
  }

  try {
    await loadTodaySnapshot(deps);
  } catch {
    // Today reloads itself when it opens.
  }

  return { ok: true, medication: savedMedication };
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
    // Ignore delete failure on discard; the daily clean-up job removes leftover photos.
  }
}

export async function loadScanContext(
  deps: ScanDeps = {},
): Promise<{ circleId: string; memberRole: MemberRole; status: 'ok' | 'no_circle' | 'error' }> {
  const mocks = loadCareCircleMocks(deps.env);
  if (mocks) {
    return { circleId: mocks.circle.id, memberRole: 'owner', status: 'ok' };
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
    if (circlesRes.error) {
      return { circleId: '', memberRole: 'viewer', status: 'error' };
    }
    if (circleRows.length === 0) {
      return { circleId: '', memberRole: 'viewer', status: 'no_circle' };
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
    if (roleRes.error) {
      return { circleId: '', memberRole: 'viewer', status: 'error' };
    }
    const memberRows = Array.isArray(roleRes.data) ? roleRes.data : [];
    const firstRole = (memberRows[0] as { role?: unknown } | undefined)?.role;
    const parsedRole = memberRoleSchema.safeParse(firstRole);
    return {
      circleId: circle.id,
      memberRole: parsedRole.success ? parsedRole.data : 'viewer',
      status: 'ok',
    };
  } catch {
    return { circleId: '', memberRole: 'viewer', status: 'error' };
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
  const [contextStatus, setContextStatus] = useState<'loading' | 'ok' | 'no_circle' | 'error'>(
    initialCircleId !== undefined && initialMemberRole !== undefined ? 'ok' : 'loading',
  );
  const [contextReloadKey, setContextReloadKey] = useState(0);
  const [isScanning, setIsScanning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  // The photo still in Storage for this screen, if any. Deleted when the screen closes without a
  // save (Taha's decision: the photo goes once the medicine is saved, or the draft is dropped).
  const imagePathRef = useRef<string | null>(null);
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const photoPicker = useMemo(
    () => deps?.photoPicker ?? createExpoPrescriptionPhotoPicker(),
    [deps?.photoPicker],
  );
  const [lastPhoto, setLastPhoto] = useState<PickedPrescriptionPhoto | null>(null);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExtractPrescriptionOutput | null>(null);
  const [errorCode, setErrorCode] = useState<ScanErrorCode | null>(null);
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
      setContextStatus('ok');
      return;
    }
    let cancelled = false;
    setContextStatus('loading');
    void (async () => {
      const ctx = await loadScanContext(deps);
      if (cancelled) return;
      if (initialCircleId === undefined) setCircleId(ctx.circleId);
      if (initialMemberRole === undefined) setMemberRole(ctx.memberRole);
      setContextStatus(ctx.status);
    })();
    return () => {
      cancelled = true;
    };
  }, [deps, initialCircleId, initialMemberRole, contextReloadKey]);

  const rememberImagePath = useCallback((path: string | null) => {
    imagePathRef.current = path;
    setImagePath(path);
  }, []);

  // Leaving the screen (back, sign-in, manual entry) with a photo still uploaded counts as a
  // discard. Best effort: the daily clean-up removes anything this misses.
  useEffect(
    () => () => {
      const leftover = imagePathRef.current;
      imagePathRef.current = null;
      if (leftover) void discardScannedMedication({ imagePath: leftover }, depsRef.current);
    },
    [],
  );

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

      // A new photo replaces the previous one: delete the previous one from Storage first.
      const previous = imagePathRef.current;
      if (!existingPath && previous) {
        rememberImagePath(null);
        void discardScannedMedication({ imagePath: previous }, deps);
      }

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
      rememberImagePath(res.imagePath);

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
    [applyDraft, circleId, deps, memberRole, onNavigateSignIn, rememberImagePath],
  );

  const handleCapture = useCallback(
    async (mode: 'take' | 'pick') => {
      if (memberRole === 'viewer' || isScanning) return;
      const options: PrescriptionPhotoCaptureOptions = {
        maxDimensionPx: MAX_SCAN_IMAGE_DIMENSION_PX,
        jpegQuality: SCAN_JPEG_QUALITY,
      };
      let picked: PickedPrescriptionPhoto | null;
      try {
        picked =
          mode === 'take'
            ? await photoPicker.takePhoto(options)
            : await photoPicker.pickPhoto(options);
      } catch (error) {
        setErrorCode(
          // Checked by message too: an Error subclass can lose its prototype once compiled.
          error instanceof PrescriptionPhotoPermissionError ||
            (error instanceof Error && error.message === 'PHOTO_PERMISSION_DENIED')
            ? 'PHOTO_PERMISSION_DENIED'
            : 'PHOTO_INVALID',
        );
        return;
      }
      if (!picked) return;
      await runScanWithPhoto(picked, null);
    },
    [isScanning, memberRole, photoPicker, runScanWithPhoto],
  );

  const handleDiscard = useCallback(async () => {
    const pathToDelete = imagePathRef.current;
    setDraft(null);
    rememberImagePath(null);
    setErrorCode(null);
    setSaveFailed(false);
    await discardScannedMedication({ imagePath: pathToDelete }, deps);
  }, [deps, rememberImagePath]);

  const handleConfirmSave = useCallback(async () => {
    if (!draft || !imagePath || savingRef.current) return;
    // One save at a time: a second tap while the first is in flight would add the medicine twice.
    savingRef.current = true;
    setIsSaving(true);
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

    savingRef.current = false;
    setIsSaving(false);

    if (!res.ok) {
      setSaveFailed(true);
      return;
    }

    setDraft(null);
    // Saved: confirmAndSaveScannedMedication already deleted the photo.
    rememberImagePath(null);
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
    rememberImagePath,
    strength,
    timesText,
  ]);

  const canScan = contextStatus === 'ok' && (memberRole === 'owner' || memberRole === 'helper');

  // A missing score counts as low: the prompt asks for a score on every field, so a missing one
  // means the model did not say how sure it is, and the person must check that field.
  const isLowConfidence = (score?: number): boolean =>
    typeof score !== 'number' || score < LOW_CONFIDENCE_THRESHOLD;

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

      {contextStatus === 'loading' ? (
        <View testID="scan-context-loading" style={[styles.statusRow, { gap: spacing.sm }]}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}

      {contextStatus === 'error' || contextStatus === 'no_circle' ? (
        <ScanNotice
          testID="scan-context-error"
          title={en.medsScan.contextErrorTitle}
          message={
            contextStatus === 'no_circle'
              ? en.medsScan.contextNoCircleMessage
              : en.medsScan.contextErrorMessage
          }
          actionTestID="scan-context-retry-button"
          actionLabel={en.medsScan.retryCta}
          onAction={() => setContextReloadKey((key) => key + 1)}
        />
      ) : null}

      {contextStatus === 'ok' && !canScan ? (
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

      {errorCode === 'UPLOAD_FAILED' ? (
        <ScanNotice
          testID="scan-error-upload"
          title={en.medsScan.errorUploadTitle}
          message={en.medsScan.errorUploadMessage}
          actionTestID="scan-upload-retry-button"
          actionLabel={en.medsScan.retryCta}
          onAction={() => {
            if (lastPhoto) void runScanWithPhoto(lastPhoto, null);
          }}
        />
      ) : null}

      {errorCode === 'PHOTO_PERMISSION_DENIED' ? (
        <ScanNotice
          testID="scan-error-permission"
          title={en.medsScan.errorPermissionTitle}
          message={en.medsScan.errorPermissionMessage}
        />
      ) : null}

      {errorCode === 'INPUT_INVALID' || errorCode === 'PHOTO_INVALID' ? (
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
              {/* The schedule kind, days and interval are saved as read: show them, so the person
                  confirms what is saved. "As needed" in particular creates no reminders at all. */}
              <Text
                testID="scan-draft-schedule-summary"
                style={{
                  color: colors.textPrimary,
                  backgroundColor: isLowConfidence(draft.fieldConfidence.schedule)
                    ? colors.warningSurface
                    : undefined,
                }}
              >
                {describeScheduleKind(draft.schedule)}
              </Text>
            </View>

            {draft.schedule.kind !== 'as_needed' ? (
              <View style={{ gap: spacing.xs }}>
                <Text style={{ color: colors.textPrimary }}>{en.medsScan.timesLabel}</Text>
                <TextInput
                  testID="scan-draft-schedule-times-input"
                  accessibilityLabel={en.medsScan.timesLabel}
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
                  label={isSaving ? en.medsScan.savingCta : en.medsScan.saveCta}
                  accessibilityLabel={en.medsScan.saveCta}
                  disabled={isSaving}
                  onPress={() => {
                    void handleConfirmSave();
                  }}
                />
              </View>
              <View testID="scan-discard-button" style={styles.flexButton}>
                <Button
                  variant="secondary"
                  disabled={isSaving}
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

const WEEKDAY_LABELS: Record<string, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

export function describeScheduleKind(schedule: MedicationSchedule): string {
  switch (schedule.kind) {
    case 'daily':
      return en.medsScan.scheduleDaily;
    case 'weekly':
      return en.medsScan.scheduleWeekly.replace(
        '{days}',
        schedule.days.map((day) => WEEKDAY_LABELS[day] ?? day).join(', '),
      );
    case 'every_n_days':
      return en.medsScan.scheduleEveryNDays.replace('{n}', String(schedule.n));
    case 'as_needed':
      return en.medsScan.scheduleAsNeeded;
  }
}

function ScanNotice(props: {
  testID: string;
  title: string;
  message: string;
  actionTestID?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const { colors, spacing, typography } = useTheme();
  return (
    <Card>
      <View testID={props.testID} style={{ gap: spacing.sm }}>
        <Text
          style={{
            color: colors.danger,
            fontSize: typography.subtitle.fontSize,
            lineHeight: typography.subtitle.lineHeight,
            fontWeight: typography.subtitle.fontWeight,
          }}
        >
          {props.title}
        </Text>
        <Text
          style={{
            color: colors.textSecondary,
            fontSize: typography.body.fontSize,
            lineHeight: typography.body.lineHeight,
          }}
        >
          {props.message}
        </Text>
        {props.actionTestID && props.actionLabel && props.onAction ? (
          <View testID={props.actionTestID}>
            <Button
              label={props.actionLabel}
              accessibilityLabel={props.actionLabel}
              onPress={props.onAction}
            />
          </View>
        ) : null}
      </View>
    </Card>
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
