import type { ExtractPrescriptionOutput } from '@carecircle/ai-gateway/schemas/carecircle/extractPrescription';
import * as Core from '@carecircle/core';
import * as UI from '@carecircle/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import en from '../i18n/en.json';
import {
  MAX_SCAN_IMAGE_DIMENSION_PX,
  PrescriptionScanScreen,
  SCAN_JPEG_QUALITY,
  confirmAndSaveScannedMedication,
  preparePrescriptionPhotoForUpload,
  scanPrescriptionPhoto,
  type PickedPrescriptionPhoto,
  type ScanDeps,
} from './features/meds/scan';
import { resetTodayState } from './features/today/api';

const CIRCLE_ID = 'c1c00001-0000-4000-8000-000000000001';
const PHOTO_ID = '11111111-1111-4111-8111-111111111111';
const EXPECTED_IMAGE_PATH = `${CIRCLE_ID}/${PHOTO_ID}.jpg`;

function makeJpegBytes(size = 2048): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

const SAMPLE_EXTRACTED: ExtractPrescriptionOutput = {
  name: 'Metformin',
  strength: '500 mg',
  doseText: '1 tablet',
  schedule: { kind: 'daily', times: ['08:00', '20:00'] },
  instructions: 'Take with food',
  fieldConfidence: {
    name: 0.96,
    strength: 0.92,
    // Low confidence (< 0.8) on doseText and schedule
    doseText: 0.65,
    schedule: 0.72,
    instructions: 0.88,
  },
  rawText: 'Metformin 500mg - 1 tab BID with meals',
};

function createFakeScanBackend(opts: { removeThrows?: boolean } = {}) {
  const uploads: Array<{ bucket: string; path: string; size: number; contentType: string }> = [];
  const removes: Array<{ bucket: string; paths: string[] }> = [];
  const insertedMeds: Array<Record<string, unknown>> = [];

  const supabase = {
    storage: {
      from: (bucket: string) => ({
        upload: async (
          path: string,
          body: Uint8Array | ArrayBuffer,
          options: { contentType: string; upsert: boolean },
        ) => {
          const size = body instanceof Uint8Array ? body.byteLength : body.byteLength;
          uploads.push({ bucket, path, size, contentType: options.contentType });
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          removes.push({ bucket, paths });
          if (opts.removeThrows) {
            return { data: null, error: { message: 'Storage delete network failure' } };
          }
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
    from: (table: string) => ({
      insert: (values: Record<string, unknown>) => {
        insertedMeds.push({ table, ...values });
        const created = {
          id: 'c1200099-0000-4000-8000-000000000001',
          circle_id: values.circle_id,
          name: values.name,
          strength: values.strength ?? null,
          dose_text: values.dose_text,
          schedule: values.schedule,
          instructions: values.instructions ?? null,
          start_date: '2026-11-15',
          end_date: null,
          active: true,
          source: values.source,
        };
        return {
          select: async () => ({ data: [created], error: null }),
        };
      },
      select: () => ({
        order: () => ({
          limit: async () => ({ data: [], error: null }),
        }),
        eq: () => ({
          eq: async () => ({ data: [{ role: 'owner' }], error: null }),
        }),
      }),
    }),
  };

  return { supabase: supabase as never, uploads, removes, insertedMeds };
}

beforeEach(() => {
  resetTodayState();
  delete process.env.MOCKS;
  delete process.env.EXPO_PUBLIC_MOCKS;
});

describe('CC-4a Prescription photo scan screen (/meds/scan)', () => {
  it('converts and shrinks photos > 1600 px or non-JPEG to <= 1600 px JPEG 0.8 <= 2 MB before upload', async () => {
    const rawPhoto: PickedPrescriptionPhoto = {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      width: 3200,
      height: 2400,
      contentType: 'image/png',
    };

    const resizeCalls: Array<{ maxDimensionPx: number; jpegQuality: number }> = [];
    const prepared = await preparePrescriptionPhotoForUpload(rawPhoto, async (_photo, options) => {
      resizeCalls.push(options);
      return {
        bytes: makeJpegBytes(1500),
        width: 1600,
        height: 1200,
        contentType: 'image/jpeg',
      };
    });

    expect(resizeCalls).toEqual([
      { maxDimensionPx: MAX_SCAN_IMAGE_DIMENSION_PX, jpegQuality: SCAN_JPEG_QUALITY },
    ]);
    expect(prepared.contentType).toBe('image/jpeg');
    expect(prepared.bytes.byteLength).toBe(1500);
  });

  it('uploads via uploadPrescriptionPhoto, extracts draft, highlights low-confidence (< 0.8) fields, renders common.notMedicalAdvice, and saves only after confirmation', async () => {
    const backend = createFakeScanBackend();
    const tracked: Array<Record<string, unknown>> = [];
    const onSaved = jest.fn();

    const deps: ScanDeps = {
      supabase: backend.supabase,
      photoId: PHOTO_ID,
      photoPicker: {
        takePhoto: async () => ({
          bytes: makeJpegBytes(2048),
          width: 1200,
          height: 900,
          contentType: 'image/jpeg',
        }),
        pickPhoto: async () => null,
      },
      callExtractPrescription: async ({ imagePath }) => {
        expect(imagePath).toBe(EXPECTED_IMAGE_PATH);
        return {
          ok: true,
          output: SAMPLE_EXTRACTED,
          model: 'claude-haiku-4-5',
          latencyMs: 420,
        };
      },
      trackMedAddedFromPhoto: () => {
        const props = Core.validateAnalyticsEvent('cc_med_added', { source: 'photo' });
        tracked.push(props);
      },
    };

    await render(
      <UI.ThemeProvider>
        <PrescriptionScanScreen
          circleId={CIRCLE_ID}
          memberRole="owner"
          deps={deps}
          onSaved={onSaved}
        />
      </UI.ThemeProvider>,
    );

    expect(screen.getByTestId('scan-not-medical-advice')).toBeTruthy();
    expect(screen.getByText(en.common.notMedicalAdvice)).toBeTruthy();

    await fireEvent.press(within(screen.getByTestId('scan-take-photo-button')).getByRole('button'));

    await waitFor(() => expect(screen.getByTestId('scan-draft-review')).toBeTruthy());

    // Uploaded through rx-storage to prescription-photos/<circle_id>/<uuid>.jpg
    expect(backend.uploads).toEqual([
      {
        bucket: 'prescription-photos',
        path: EXPECTED_IMAGE_PATH,
        size: 2048,
        contentType: 'image/jpeg',
      },
    ]);

    // Nothing saved to medications before caregiver confirms
    expect(backend.insertedMeds).toHaveLength(0);
    expect(tracked).toHaveLength(0);

    // Low-confidence badges shown ONLY for fields < 0.8 (doseText = 0.65, schedule = 0.72)
    expect(screen.queryByTestId('scan-low-confidence-name')).toBeNull();
    expect(screen.queryByTestId('scan-low-confidence-strength')).toBeNull();
    expect(screen.getByTestId('scan-low-confidence-doseText')).toBeTruthy();
    expect(screen.getByTestId('scan-low-confidence-schedule')).toBeTruthy();
    expect(screen.queryByTestId('scan-low-confidence-instructions')).toBeNull();

    // Caregiver edits low-confidence doseText before confirming
    await fireEvent.changeText(
      screen.getByTestId('scan-draft-dose-text-input'),
      '1 tablet twice daily',
    );
    await fireEvent.press(within(screen.getByTestId('scan-save-button')).getByRole('button'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(backend.insertedMeds).toHaveLength(1);
    expect(backend.insertedMeds[0]).toMatchObject({
      circle_id: CIRCLE_ID,
      name: 'Metformin',
      strength: '500 mg',
      dose_text: '1 tablet twice daily',
      source: 'photo',
    });

    // Analytics fired with { source: 'photo' } only, and photo deleted via deletePrescriptionPhoto
    expect(tracked).toEqual([{ source: 'photo' }]);
    expect(JSON.stringify(tracked)).not.toContain('Metformin');
    expect(backend.removes).toEqual([
      {
        bucket: 'prescription-photos',
        paths: [EXPECTED_IMAGE_PATH],
      },
    ]);
  });

  it('does not block medication save if deletePrescriptionPhoto fails, and deletes photo when draft is discarded', async () => {
    const failingDeleteBackend = createFakeScanBackend({ removeThrows: true });

    const saveRes = await confirmAndSaveScannedMedication(
      {
        circleId: CIRCLE_ID,
        memberRole: 'helper',
        imagePath: EXPECTED_IMAGE_PATH,
        name: 'Metformin',
        strength: '500 mg',
        doseText: '1 tablet',
        schedule: { kind: 'daily', times: ['08:00'] },
        instructions: null,
      },
      {
        supabase: failingDeleteBackend.supabase,
        trackMedAddedFromPhoto: () => undefined,
      },
    );

    expect(saveRes.ok).toBe(true);
    expect(failingDeleteBackend.removes).toEqual([
      { bucket: 'prescription-photos', paths: [EXPECTED_IMAGE_PATH] },
    ]);

    // Discard flow also calls deletePrescriptionPhoto
    const discardBackend = createFakeScanBackend();
    const deps: ScanDeps = {
      supabase: discardBackend.supabase,
      photoId: PHOTO_ID,
      photoPicker: {
        takePhoto: async () => ({
          bytes: makeJpegBytes(1024),
          width: 800,
          height: 600,
          contentType: 'image/jpeg',
        }),
        pickPhoto: async () => null,
      },
      callExtractPrescription: async () => ({
        ok: true,
        output: SAMPLE_EXTRACTED,
        model: 'claude-haiku-4-5',
        latencyMs: 200,
      }),
    };

    await render(
      <UI.ThemeProvider>
        <PrescriptionScanScreen circleId={CIRCLE_ID} memberRole="helper" deps={deps} />
      </UI.ThemeProvider>,
    );

    await fireEvent.press(within(screen.getByTestId('scan-take-photo-button')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('scan-draft-review')).toBeTruthy());

    await fireEvent.press(within(screen.getByTestId('scan-discard-button')).getByRole('button'));
    await waitFor(() => expect(screen.queryByTestId('scan-draft-review')).toBeNull());
    expect(discardBackend.removes).toEqual([
      { bucket: 'prescription-photos', paths: [EXPECTED_IMAGE_PATH] },
    ]);
  });

  it('hides scan buttons from a viewer and refuses viewer calls', async () => {
    const backend = createFakeScanBackend();

    await render(
      <UI.ThemeProvider>
        <PrescriptionScanScreen
          circleId={CIRCLE_ID}
          memberRole="viewer"
          deps={{ supabase: backend.supabase }}
        />
      </UI.ThemeProvider>,
    );

    expect(screen.getByTestId('scan-viewer-restricted')).toBeTruthy();
    expect(screen.queryByTestId('scan-take-photo-button')).toBeNull();
    expect(screen.queryByTestId('scan-pick-photo-button')).toBeNull();

    const scanRes = await scanPrescriptionPhoto(
      {
        circleId: CIRCLE_ID,
        memberRole: 'viewer',
        photo: {
          bytes: makeJpegBytes(1024),
          width: 800,
          height: 600,
          contentType: 'image/jpeg',
        },
      },
      { supabase: backend.supabase },
    );
    expect(scanRes).toEqual({ ok: false, imagePath: null, errorCode: 'FORBIDDEN_ROLE' });
    expect(backend.uploads).toHaveLength(0);
  });

  it('handles every AI gateway error code: UNAUTHENTICATED, QUOTA_EXCEEDED, INPUT_INVALID, SCHEMA_INVALID, and PROVIDER_ERROR', async () => {
    const backend = createFakeScanBackend();
    const onNavigateSignIn = jest.fn();
    const onNavigateManualEntry = jest.fn();

    let nextGatewayCode: Core.MemberRole | string = 'UNAUTHENTICATED';
    let callCount = 0;

    const deps: ScanDeps = {
      supabase: backend.supabase,
      photoId: PHOTO_ID,
      photoPicker: {
        takePhoto: async () => ({
          bytes: makeJpegBytes(1024),
          width: 800,
          height: 600,
          contentType: 'image/jpeg',
        }),
        pickPhoto: async () => null,
      },
      callExtractPrescription: async () => {
        callCount += 1;
        if (nextGatewayCode === 'OK') {
          return {
            ok: true,
            output: SAMPLE_EXTRACTED,
            model: 'claude-haiku-4-5',
            latencyMs: 100,
          };
        }
        return {
          ok: false,
          error: {
            code: nextGatewayCode as never,
            message: `Error ${nextGatewayCode}`,
            retryable: nextGatewayCode === 'PROVIDER_ERROR',
          },
        };
      },
    };

    await render(
      <UI.ThemeProvider>
        <PrescriptionScanScreen
          circleId={CIRCLE_ID}
          memberRole="owner"
          deps={deps}
          onNavigateSignIn={onNavigateSignIn}
          onNavigateManualEntry={onNavigateManualEntry}
        />
      </UI.ThemeProvider>,
    );

    // 1. UNAUTHENTICATED -> navigates to sign-in
    await fireEvent.press(within(screen.getByTestId('scan-take-photo-button')).getByRole('button'));
    await waitFor(() => expect(onNavigateSignIn).toHaveBeenCalledTimes(1));

    // 2. QUOTA_EXCEEDED -> shows quota error and upgrade button
    nextGatewayCode = 'QUOTA_EXCEEDED';
    await fireEvent.press(within(screen.getByTestId('scan-take-photo-button')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('scan-error-quota')).toBeTruthy());
    expect(screen.getByTestId('scan-quota-paywall-button')).toBeTruthy();

    // 3. INPUT_INVALID -> shows retake button
    nextGatewayCode = 'INPUT_INVALID';
    await fireEvent.press(within(screen.getByTestId('scan-take-photo-button')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('scan-error-input-invalid')).toBeTruthy());
    expect(screen.getByTestId('scan-retake-button')).toBeTruthy();

    // 4. SCHEMA_INVALID -> shows manual entry button
    nextGatewayCode = 'SCHEMA_INVALID';
    await fireEvent.press(within(screen.getByTestId('scan-take-photo-button')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('scan-error-schema-invalid')).toBeTruthy());
    await fireEvent.press(
      within(screen.getByTestId('scan-manual-entry-button')).getByRole('button'),
    );
    expect(onNavigateManualEntry).toHaveBeenCalledTimes(1);

    // 5. PROVIDER_ERROR -> shows retry button and succeeds when retried without re-uploading
    nextGatewayCode = 'PROVIDER_ERROR';
    await fireEvent.press(within(screen.getByTestId('scan-take-photo-button')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('scan-error-provider')).toBeTruthy());
    const uploadsBeforeRetry = backend.uploads.length;

    nextGatewayCode = 'OK';
    await fireEvent.press(within(screen.getByTestId('scan-retry-button')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('scan-draft-review')).toBeTruthy());
    expect(backend.uploads.length).toBe(uploadsBeforeRetry);
    expect(callCount).toBe(6);
  });

  it('edits schedule kind (weekly, every_n_days, as_needed) and shows field-specific validation errors instead of generic "Not saved"', async () => {
    const backend = createFakeScanBackend();
    const onSaved = jest.fn();

    const deps: ScanDeps = {
      supabase: backend.supabase,
      photoId: PHOTO_ID,
      photoPicker: {
        takePhoto: async () => ({
          bytes: makeJpegBytes(1024),
          width: 800,
          height: 600,
          contentType: 'image/jpeg',
        }),
        pickPhoto: async () => null,
      },
      callExtractPrescription: async () => ({
        ok: true,
        output: SAMPLE_EXTRACTED,
        model: 'claude-haiku-4-5',
        latencyMs: 120,
      }),
      trackMedAddedFromPhoto: () => undefined,
    };

    await render(
      <UI.ThemeProvider>
        <PrescriptionScanScreen
          circleId={CIRCLE_ID}
          memberRole="owner"
          deps={deps}
          onSaved={onSaved}
        />
      </UI.ThemeProvider>,
    );

    await fireEvent.press(within(screen.getByTestId('scan-take-photo-button')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('scan-draft-review')).toBeTruthy());

    // Enter invalid time ("8am"): shows specific times error, NOT "Not saved", and does not call server
    await fireEvent.changeText(screen.getByTestId('scan-draft-schedule-times-input'), '8am');
    await fireEvent.press(within(screen.getByTestId('scan-save-button')).getByRole('button'));

    expect(screen.getByTestId('scan-field-validation-error')).toHaveTextContent(
      en.medsScan.invalidTimesMessage,
    );
    expect(screen.queryByTestId('scan-not-saved-notice')).toBeNull();
    expect(backend.insertedMeds).toHaveLength(0);

    // Switch to weekly and enter invalid day ("monday"): shows specific days error
    await fireEvent.press(
      within(screen.getByTestId('scan-schedule-kind-weekly')).getByRole('button'),
    );
    await fireEvent.changeText(screen.getByTestId('scan-draft-schedule-times-input'), '09:00');
    await fireEvent.changeText(screen.getByTestId('scan-draft-schedule-days-input'), 'monday');
    await fireEvent.press(within(screen.getByTestId('scan-save-button')).getByRole('button'));

    expect(screen.getByTestId('scan-field-validation-error')).toHaveTextContent(
      en.medsScan.invalidDaysMessage,
    );
    expect(backend.insertedMeds).toHaveLength(0);

    // Switch to every_n_days with valid n=3 and time=09:00 and save
    await fireEvent.press(
      within(screen.getByTestId('scan-schedule-kind-every_n_days')).getByRole('button'),
    );
    await fireEvent.changeText(screen.getByTestId('scan-draft-schedule-interval-input'), '3');
    expect(screen.getByTestId('scan-draft-schedule-summary')).toHaveTextContent('Every 3 days');

    await fireEvent.press(within(screen.getByTestId('scan-save-button')).getByRole('button'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(backend.insertedMeds[0]?.schedule).toEqual({
      kind: 'every_n_days',
      n: 3,
      times: ['09:00'],
    });
    expect(backend.insertedMeds[0]).not.toHaveProperty('start_date');
  });

  it('skips Supabase Storage upload and delete when MOCKS=1 and returns the mock draft', async () => {
    const onSaved = jest.fn();
    const deps: ScanDeps = {
      env: { MOCKS: '1' },
      photoId: PHOTO_ID,
      photoPicker: {
        takePhoto: async () => ({
          bytes: makeJpegBytes(1024),
          width: 800,
          height: 600,
          contentType: 'image/jpeg',
        }),
        pickPhoto: async () => null,
      },
      trackMedAddedFromPhoto: () => undefined,
    };

    await render(
      <UI.ThemeProvider>
        <PrescriptionScanScreen
          circleId={CIRCLE_ID}
          memberRole="owner"
          deps={deps}
          onSaved={onSaved}
        />
      </UI.ThemeProvider>,
    );

    await fireEvent.press(within(screen.getByTestId('scan-take-photo-button')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('scan-draft-review')).toBeTruthy());

    await fireEvent.press(within(screen.getByTestId('scan-save-button')).getByRole('button'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.calls[0]?.[0]).toMatchObject({
      name: 'Metformin',
      source: 'photo',
    });
  });
});
