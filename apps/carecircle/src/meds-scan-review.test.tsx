// Added in the PR #34 review (CC-4a photo scan screen). Each test here failed on Gemini's version.
import type { ExtractPrescriptionOutput } from '@carecircle/ai-gateway/schemas/carecircle/extractPrescription';
import * as UI from '@carecircle/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import en from '../i18n/en.json';
import {
  FALLBACK_JPEG_QUALITIES,
  PrescriptionPhotoPermissionError,
  createExpoPrescriptionPhotoPicker,
  targetResize,
  type ExpoPhotoPickerModules,
} from './features/meds/photo-picker';
import { MAX_PRESCRIPTION_PHOTO_BYTES } from './features/meds/rx-storage';
import {
  PrescriptionScanScreen,
  confirmAndSaveScannedMedication,
  type PickedPrescriptionPhoto,
  type ScanDeps,
} from './features/meds/scan';
import * as TodayApi from './features/today/api';
import { resetTodayState } from './features/today/api';

// The real adapter is replaced only where a test says so (see "uses the phone's camera").
const mockDefaultPicker = {
  takePhoto: jest.fn<Promise<PickedPrescriptionPhoto | null>, [unknown]>(),
  pickPhoto: jest.fn<Promise<PickedPrescriptionPhoto | null>, [unknown]>(),
};
jest.mock('./features/meds/photo-picker', () => {
  const actual = jest.requireActual('./features/meds/photo-picker');
  return {
    ...actual,
    createExpoPrescriptionPhotoPicker: (modules?: unknown) =>
      modules ? actual.createExpoPrescriptionPhotoPicker(modules) : mockDefaultPicker,
  };
});

const CIRCLE_ID = 'c1c00001-0000-4000-8000-000000000001';

function jpeg(size = 2048): PickedPrescriptionPhoto {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return { bytes, width: 1200, height: 900, contentType: 'image/jpeg' };
}

const DRAFT: ExtractPrescriptionOutput = {
  name: 'Metformin',
  strength: '500 mg',
  doseText: '1 tablet',
  schedule: { kind: 'daily', times: ['08:00', '20:00'] },
  instructions: 'Take with food',
  fieldConfidence: { name: 0.96, strength: 0.92, doseText: 0.95, schedule: 0.9, instructions: 0.9 },
  rawText: 'Metformin 500mg 1 tab BID',
};

function backend(opts: { uploadFails?: number; insertDelayMs?: number } = {}) {
  let uploadFailuresLeft = opts.uploadFails ?? 0;
  const uploads: string[] = [];
  const removes: string[] = [];
  const inserts: Array<Record<string, unknown>> = [];
  const supabase = {
    storage: {
      from: () => ({
        upload: async (path: string) => {
          uploads.push(path);
          if (uploadFailuresLeft > 0) {
            uploadFailuresLeft -= 1;
            throw new TypeError('Network request failed');
          }
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          removes.push(...paths);
          return { data: [], error: null };
        },
      }),
    },
    from: () => ({
      insert: (values: Record<string, unknown>) => {
        inserts.push(values);
        return {
          select: async () => {
            if (opts.insertDelayMs) await new Promise((r) => setTimeout(r, opts.insertDelayMs));
            return {
              data: [
                {
                  id: `c1200099-0000-4000-8000-00000000000${inserts.length}`,
                  circle_id: values.circle_id,
                  name: values.name,
                  strength: values.strength ?? null,
                  dose_text: values.dose_text,
                  schedule: values.schedule,
                  instructions: values.instructions ?? null,
                  start_date: '2026-11-16',
                  end_date: null,
                  active: true,
                  source: values.source,
                },
              ],
              error: null,
            };
          },
        };
      },
    }),
  };
  return { supabase: supabase as never, uploads, removes, inserts };
}

function scanDeps(
  b: ReturnType<typeof backend>,
  draft: ExtractPrescriptionOutput = DRAFT,
  extra: Partial<ScanDeps> = {},
): ScanDeps {
  return {
    supabase: b.supabase,
    photoPicker: { takePhoto: async () => jpeg(), pickPhoto: async () => jpeg() },
    callExtractPrescription: async () => ({ ok: true, output: draft, model: 'fake', latencyMs: 1 }),
    trackMedAddedFromPhoto: () => undefined,
    ...extra,
  };
}

async function renderScreen(deps: ScanDeps, props: Record<string, unknown> = {}) {
  return render(
    <UI.ThemeProvider>
      <PrescriptionScanScreen circleId={CIRCLE_ID} memberRole="owner" deps={deps} {...props} />
    </UI.ThemeProvider>,
  );
}

async function press(testID: string) {
  await fireEvent.press(within(screen.getByTestId(testID)).getByRole('button'));
}

beforeEach(() => {
  resetTodayState();
  delete process.env.MOCKS;
  delete process.env.EXPO_PUBLIC_MOCKS;
  mockDefaultPicker.takePhoto.mockReset();
  mockDefaultPicker.pickPhoto.mockReset();
});

describe('PR #34 review: the real camera and library adapter', () => {
  function fakeModules(sizes: number[], picked = { uri: 'file:///cache/p.jpg', w: 4032, h: 3024 }) {
    const calls: Array<{ size: unknown; quality: number }> = [];
    const deleted: string[] = [];
    let n = 0;
    const modules: ExpoPhotoPickerModules = {
      launch: async () => ({ uri: picked.uri, width: picked.w, height: picked.h }),
      toJpeg: async (_uri, size, quality) => {
        calls.push({ size, quality });
        n += 1;
        return { uri: `file:///cache/out-${n}.jpg`, width: 1600, height: 1200 };
      },
      readBytes: async () => new Uint8Array(sizes[Math.min(n - 1, sizes.length - 1)] ?? 0),
      deleteLocal: (uri) => deleted.push(uri),
    };
    return { modules, calls, deleted };
  }
  const options = { maxDimensionPx: 1600, jpegQuality: 0.8 };

  it('resizes the long edge to 1600 px, JPEG 0.8, and lowers quality only when still over 2 MB', async () => {
    expect(targetResize(4032, 3024, 1600)).toEqual({ width: 1600 });
    expect(targetResize(3024, 4032, 1600)).toEqual({ height: 1600 });
    expect(targetResize(1600, 1200, 1600)).toBeNull();

    const ok = fakeModules([500_000]);
    const photo = await createExpoPrescriptionPhotoPicker(ok.modules).takePhoto(options);
    expect(photo?.contentType).toBe('image/jpeg');
    expect(photo?.bytes.byteLength).toBe(500_000);
    expect(ok.calls).toEqual([{ size: { width: 1600 }, quality: 0.8 }]);

    const big = fakeModules([MAX_PRESCRIPTION_PHOTO_BYTES + 1, MAX_PRESCRIPTION_PHOTO_BYTES]);
    const smaller = await createExpoPrescriptionPhotoPicker(big.modules).pickPhoto(options);
    expect(smaller?.bytes.byteLength).toBe(MAX_PRESCRIPTION_PHOTO_BYTES);
    expect(big.calls.map((c) => c.quality)).toEqual([0.8, FALLBACK_JPEG_QUALITIES[0]]);

    const huge = fakeModules([MAX_PRESCRIPTION_PHOTO_BYTES + 1]);
    await expect(
      createExpoPrescriptionPhotoPicker(huge.modules).takePhoto(options),
    ).rejects.toThrow('PHOTO_TOO_LARGE');
    expect(huge.calls).toHaveLength(1 + FALLBACK_JPEG_QUALITIES.length);
  });

  it('deletes every local copy of the photo once its bytes are read, and returns null on cancel', async () => {
    const m = fakeModules([MAX_PRESCRIPTION_PHOTO_BYTES + 1, 1000]);
    await createExpoPrescriptionPhotoPicker(m.modules).takePhoto(options);
    expect(m.deleted.sort()).toEqual(
      ['file:///cache/out-1.jpg', 'file:///cache/out-2.jpg', 'file:///cache/p.jpg'].sort(),
    );

    const cancelled = { ...m.modules, launch: async () => null };
    await expect(
      createExpoPrescriptionPhotoPicker(cancelled).pickPhoto(options),
    ).resolves.toBeNull();
  });

  it('uses the phone camera when the route passes no photoPicker (Gemini: buttons did nothing)', async () => {
    const b = backend();
    mockDefaultPicker.takePhoto.mockResolvedValue(jpeg());
    const deps = scanDeps(b);
    delete deps.photoPicker;
    await renderScreen(deps);
    await press('scan-take-photo-button');
    await waitFor(() => expect(screen.getByTestId('scan-draft-review')).toBeTruthy());
    expect(mockDefaultPicker.takePhoto).toHaveBeenCalledWith({
      maxDimensionPx: 1600,
      jpegQuality: 0.8,
    });
    expect(b.uploads).toHaveLength(1);
  });

  it('says so when camera access is refused', async () => {
    const b = backend();
    await renderScreen(
      scanDeps(b, DRAFT, {
        photoPicker: {
          takePhoto: async () => {
            throw new PrescriptionPhotoPermissionError();
          },
          pickPhoto: async () => null,
        },
      }),
    );
    await press('scan-take-photo-button');
    await waitFor(() => expect(screen.getByTestId('scan-error-permission')).toBeTruthy());
    expect(b.uploads).toHaveLength(0);
  });
});

describe('PR #34 review: saving', () => {
  it('reports a save as saved even when refreshing Today fails afterwards (no "Not saved", no duplicate)', async () => {
    const b = backend();
    const refresh = jest
      .spyOn(TodayApi, 'loadTodaySnapshot')
      .mockRejectedValue(new Error('disk unavailable'));
    const res = await confirmAndSaveScannedMedication(
      {
        circleId: CIRCLE_ID,
        memberRole: 'owner',
        imagePath: `${CIRCLE_ID}/22222222-2222-4222-8222-222222222222.jpg`,
        name: 'Metformin',
        strength: null,
        doseText: '1 tablet',
        schedule: { kind: 'daily', times: ['08:00'] },
        instructions: null,
      },
      {
        ...scanDeps(b),
        trackMedAddedFromPhoto: () => {
          throw new Error('analytics down');
        },
      },
    );
    expect(refresh).toHaveBeenCalled();
    refresh.mockRestore();
    expect(res.ok).toBe(true);
    expect(b.inserts).toHaveLength(1);
    expect(b.removes).toEqual([`${CIRCLE_ID}/22222222-2222-4222-8222-222222222222.jpg`]);
  });

  it('saves once when Save is tapped twice quickly', async () => {
    const b = backend({ insertDelayMs: 30 });
    const onSaved = jest.fn();
    await renderScreen(scanDeps(b), { onSaved });
    await press('scan-take-photo-button');
    await waitFor(() => expect(screen.getByTestId('scan-draft-review')).toBeTruthy());
    const save = within(screen.getByTestId('scan-save-button')).getByRole('button');
    await act(async () => {
      fireEvent.press(save);
      fireEvent.press(save);
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(b.inserts).toHaveLength(1);
  });
});

describe('PR #34 review: what the person confirms', () => {
  it('shows an "as needed" schedule (no reminders) and flags it when its confidence is low', async () => {
    const b = backend();
    await renderScreen(
      scanDeps(b, {
        ...DRAFT,
        schedule: { kind: 'as_needed' },
        fieldConfidence: { ...DRAFT.fieldConfidence, schedule: 0.5 },
      }),
    );
    await press('scan-take-photo-button');
    await waitFor(() => expect(screen.getByTestId('scan-draft-review')).toBeTruthy());
    expect(screen.getByTestId('scan-draft-schedule-summary')).toHaveTextContent(
      en.medsScan.scheduleAsNeeded,
    );
    expect(screen.getByTestId('scan-low-confidence-schedule')).toBeTruthy();
  });

  it('shows the days of a weekly schedule', async () => {
    const b = backend();
    await renderScreen(
      scanDeps(b, {
        ...DRAFT,
        schedule: { kind: 'weekly', days: ['mon', 'thu'], times: ['09:00'] },
      }),
    );
    await press('scan-take-photo-button');
    await waitFor(() => expect(screen.getByTestId('scan-draft-review')).toBeTruthy());
    expect(screen.getByTestId('scan-draft-schedule-summary')).toHaveTextContent(
      'Every week on Mon, Thu',
    );
  });

  it('flags a field the AI gave no confidence score for', async () => {
    const b = backend();
    await renderScreen(scanDeps(b, { ...DRAFT, fieldConfidence: { name: 0.99 } }));
    await press('scan-take-photo-button');
    await waitFor(() => expect(screen.getByTestId('scan-draft-review')).toBeTruthy());
    expect(screen.queryByTestId('scan-low-confidence-name')).toBeNull();
    for (const field of ['strength', 'doseText', 'schedule', 'instructions']) {
      expect(screen.getByTestId(`scan-low-confidence-${field}`)).toBeTruthy();
    }
  });
});

describe('PR #34 review: errors and the photo in Storage', () => {
  it('a failed upload (offline) offers "try again" with the same photo, not "retake"', async () => {
    const b = backend({ uploadFails: 1 });
    await renderScreen(scanDeps(b));
    await press('scan-take-photo-button');
    await waitFor(() => expect(screen.getByTestId('scan-error-upload')).toBeTruthy());
    expect(screen.queryByTestId('scan-error-input-invalid')).toBeNull();
    await press('scan-upload-retry-button');
    await waitFor(() => expect(screen.getByTestId('scan-draft-review')).toBeTruthy());
    expect(b.uploads).toHaveLength(2);
  });

  it('a photo that cannot be made a 2 MB JPEG asks for a retake and uploads nothing', async () => {
    const b = backend();
    await renderScreen(
      scanDeps(b, DRAFT, {
        photoPicker: {
          takePhoto: async () => jpeg(MAX_PRESCRIPTION_PHOTO_BYTES + 1),
          pickPhoto: async () => null,
        },
      }),
    );
    await press('scan-take-photo-button');
    await waitFor(() => expect(screen.getByTestId('scan-error-input-invalid')).toBeTruthy());
    expect(b.uploads).toHaveLength(0);
  });

  it('deletes the old photo on retake, and the photo when the screen closes without saving', async () => {
    const b = backend();
    let calls = 0;
    const view = await renderScreen(
      scanDeps(b, DRAFT, {
        callExtractPrescription: async () => {
          calls += 1;
          return calls === 1
            ? { ok: false, error: { code: 'INPUT_INVALID', message: 'blurry', retryable: false } }
            : { ok: true, output: DRAFT, model: 'fake', latencyMs: 1 };
        },
      }),
    );
    await press('scan-take-photo-button');
    await waitFor(() => expect(screen.getByTestId('scan-retake-button')).toBeTruthy());
    await press('scan-retake-button');
    await waitFor(() => expect(screen.getByTestId('scan-draft-review')).toBeTruthy());
    expect(b.uploads).toHaveLength(2);
    expect(b.removes).toEqual([b.uploads[0]]);

    await act(async () => {
      view.unmount();
    });
    await waitFor(() => expect(b.removes).toEqual([b.uploads[0], b.uploads[1]]));
  });

  it('shows loading, then an error with retry, while the circle cannot be loaded; never the viewer text', async () => {
    let fail = true;
    const deps: ScanDeps = {
      ...scanDeps(backend()),
      getUserId: async () => 'u1',
      supabase: {
        storage: { from: () => ({}) },
        from: (table: string) => ({
          select: () =>
            table === 'circles'
              ? {
                  order: () => ({
                    limit: async () =>
                      fail
                        ? { data: null, error: { message: 'offline' } }
                        : {
                            data: [
                              {
                                id: CIRCLE_ID,
                                name: 'Mum',
                                care_recipient_name: 'Mum',
                                care_recipient_dob: null,
                                timezone: 'Europe/Paris',
                                created_by: 'a0000000-0000-4000-8000-000000000001',
                                created_at: '2026-11-01T00:00:00.000Z',
                              },
                            ],
                            error: null,
                          },
                  }),
                }
              : { eq: () => ({ eq: async () => ({ data: [{ role: 'helper' }], error: null }) }) },
        }),
      } as never,
    };
    await render(
      <UI.ThemeProvider>
        <PrescriptionScanScreen deps={deps} />
      </UI.ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('scan-context-error')).toBeTruthy());
    expect(screen.queryByTestId('scan-viewer-restricted')).toBeNull();
    expect(screen.queryByTestId('scan-take-photo-button')).toBeNull();
    fail = false;
    await press('scan-context-retry-button');
    await waitFor(() => expect(screen.getByTestId('scan-take-photo-button')).toBeTruthy());
  });
});
