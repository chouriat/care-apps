interface RxStorageClientBucket {
  upload: (
    path: string,
    body: Uint8Array | ArrayBuffer,
    options: { contentType: string; upsert: boolean },
  ) => Promise<{ data: { path: string } | null; error: { message: string } | null }>;
  remove: (
    paths: string[],
  ) => Promise<{ data: Array<{ name: string }> | null; error: { message: string } | null }>;
}

interface RxStorageSupabaseLike {
  storage: {
    from: (bucket: string) => RxStorageClientBucket;
  };
}

interface RxStorageModule {
  PRESCRIPTION_PHOTOS_BUCKET: string;
  MAX_PRESCRIPTION_PHOTO_BYTES: number;
  buildPrescriptionPhotoPath: (circleId: string, photoId: string) => string;
  uploadPrescriptionPhoto: (opts: {
    supabase: RxStorageSupabaseLike;
    circleId: string;
    photoId: string;
    bytes: Uint8Array;
    contentType: string;
  }) => Promise<{ imagePath: string }>;
  deletePrescriptionPhoto: (opts: {
    supabase: RxStorageSupabaseLike;
    imagePath: string;
  }) => Promise<void>;
}

function loadRxStorageModule(): RxStorageModule {
  // Loaded at runtime so the [safety 1/2] tests-only PR typechecks before features/meds/rx-storage.ts exists.
  return jest.requireActual<RxStorageModule>('./features/meds/rx-storage');
}

const CIRCLE_ID = 'cc4ac001-0000-4000-8000-000000000001';
const PHOTO_ID = '11111111-1111-4111-8111-111111111111';

describe('Prescription photo Storage helpers (apps/carecircle/src/features/meds/rx-storage.ts)', () => {
  it('enforces bucket name prescription-photos, 2 MB limit, and <circle_id>/<uuid>.jpg path format', () => {
    const { PRESCRIPTION_PHOTOS_BUCKET, MAX_PRESCRIPTION_PHOTO_BYTES, buildPrescriptionPhotoPath } =
      loadRxStorageModule();

    expect(PRESCRIPTION_PHOTOS_BUCKET).toBe('prescription-photos');
    expect(MAX_PRESCRIPTION_PHOTO_BYTES).toBe(2 * 1024 * 1024);
    expect(buildPrescriptionPhotoPath(CIRCLE_ID, PHOTO_ID)).toBe(`${CIRCLE_ID}/${PHOTO_ID}.jpg`);

    expect(() => buildPrescriptionPhotoPath('not-a-uuid', PHOTO_ID)).toThrow(/circleId/i);
    expect(() => buildPrescriptionPhotoPath(CIRCLE_ID, 'not-a-uuid')).toThrow(/photoId/i);
  });

  it('uploads JPEG <= 2 MB with upsert: false and rejects non-JPEG or > 2 MB files before calling Storage', async () => {
    const { uploadPrescriptionPhoto, MAX_PRESCRIPTION_PHOTO_BYTES } = loadRxStorageModule();

    const uploadCalls: Array<{
      bucket: string;
      path: string;
      size: number;
      options: { contentType: string; upsert: boolean };
    }> = [];

    const supabase: RxStorageSupabaseLike = {
      storage: {
        from: (bucket) => ({
          upload: async (path, body, options) => {
            const size = body instanceof Uint8Array ? body.byteLength : body.byteLength;
            uploadCalls.push({ bucket, path, size, options });
            return { data: { path }, error: null };
          },
          remove: async () => ({ data: [], error: null }),
        }),
      },
    };

    await expect(
      uploadPrescriptionPhoto({
        supabase,
        circleId: CIRCLE_ID,
        photoId: PHOTO_ID,
        bytes: new Uint8Array(1024),
        contentType: 'image/png',
      }),
    ).rejects.toThrow(/image\/jpeg/i);

    await expect(
      uploadPrescriptionPhoto({
        supabase,
        circleId: CIRCLE_ID,
        photoId: PHOTO_ID,
        bytes: new Uint8Array(MAX_PRESCRIPTION_PHOTO_BYTES + 1),
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow(/2 MB|size/i);

    expect(uploadCalls).toHaveLength(0);

    const res = await uploadPrescriptionPhoto({
      supabase,
      circleId: CIRCLE_ID,
      photoId: PHOTO_ID,
      bytes: new Uint8Array(4096),
      contentType: 'image/jpeg',
    });

    expect(res).toEqual({ imagePath: `${CIRCLE_ID}/${PHOTO_ID}.jpg` });
    expect(uploadCalls).toEqual([
      {
        bucket: 'prescription-photos',
        path: `${CIRCLE_ID}/${PHOTO_ID}.jpg`,
        size: 4096,
        options: { contentType: 'image/jpeg', upsert: false },
      },
    ]);
  });

  it('deletes the prescription photo from prescription-photos when medicine is saved or draft is discarded', async () => {
    const { deletePrescriptionPhoto } = loadRxStorageModule();

    const removeCalls: Array<{ bucket: string; paths: string[] }> = [];
    const supabase: RxStorageSupabaseLike = {
      storage: {
        from: (bucket) => ({
          upload: async (path) => ({ data: { path }, error: null }),
          remove: async (paths) => {
            removeCalls.push({ bucket, paths });
            return { data: paths.map((name) => ({ name })), error: null };
          },
        }),
      },
    };

    const imagePath = `${CIRCLE_ID}/${PHOTO_ID}.jpg`;
    await deletePrescriptionPhoto({ supabase, imagePath });

    expect(removeCalls).toEqual([
      {
        bucket: 'prescription-photos',
        paths: [imagePath],
      },
    ]);

    await expect(
      deletePrescriptionPhoto({ supabase, imagePath: 'invalid-path.jpg' }),
    ).rejects.toThrow(/imagePath/i);
  });
});
