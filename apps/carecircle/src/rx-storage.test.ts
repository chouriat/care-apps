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

// A buffer that starts like a real JPEG file (FF D8 FF).
function jpegBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

type Call = { kind: 'upload' | 'remove'; bucket: string; arg: unknown };

function fakeSupabase(opts: { uploadError?: string; removeError?: string } = {}) {
  const calls: Call[] = [];
  const supabase: RxStorageSupabaseLike = {
    storage: {
      from: (bucket) => ({
        upload: async (path) => {
          calls.push({ kind: 'upload', bucket, arg: path });
          return opts.uploadError
            ? { data: null, error: { message: opts.uploadError } }
            : { data: { path }, error: null };
        },
        remove: async (paths) => {
          calls.push({ kind: 'remove', bucket, arg: paths });
          return opts.removeError
            ? { data: null, error: { message: opts.removeError } }
            : { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
  };
  return { supabase, calls };
}

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
        bytes: jpegBytes(1024),
        contentType: 'image/png',
      }),
    ).rejects.toThrow(/image\/jpeg/i);

    await expect(
      uploadPrescriptionPhoto({
        supabase,
        circleId: CIRCLE_ID,
        photoId: PHOTO_ID,
        bytes: jpegBytes(MAX_PRESCRIPTION_PHOTO_BYTES + 1),
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow(/2 MB|size/i);

    expect(uploadCalls).toHaveLength(0);

    const res = await uploadPrescriptionPhoto({
      supabase,
      circleId: CIRCLE_ID,
      photoId: PHOTO_ID,
      bytes: jpegBytes(4096),
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

  it('only builds lowercase <uuid>/<uuid>.jpg paths (the Storage policy refuses anything else)', () => {
    const { buildPrescriptionPhotoPath } = loadRxStorageModule();
    const lower = `${CIRCLE_ID}/${PHOTO_ID}.jpg`;
    // Either refuse the uppercase id, or turn it into the lowercase path. Never an uppercase path.
    const outcome = (circleId: string, photoId: string): string => {
      try {
        return buildPrescriptionPhotoPath(circleId, photoId);
      } catch (e) {
        return /circleId|photoId/i.test(String(e)) ? 'refused' : `wrong error: ${String(e)}`;
      }
    };
    expect([lower, 'refused']).toContain(outcome(CIRCLE_ID.toUpperCase(), PHOTO_ID));
    expect([lower, 'refused']).toContain(outcome(CIRCLE_ID, PHOTO_ID.toUpperCase()));
    expect(() => buildPrescriptionPhotoPath(`../${CIRCLE_ID}`, PHOTO_ID)).toThrow(/circleId/i);
    expect(() => buildPrescriptionPhotoPath(CIRCLE_ID, `${PHOTO_ID}.jpg`)).toThrow(/photoId/i);
  });

  it('refuses bytes that are not a JPEG file even when contentType says image/jpeg', async () => {
    const { uploadPrescriptionPhoto } = loadRxStorageModule();
    const { supabase, calls } = fakeSupabase();
    const png = new Uint8Array(1024);
    png.set([0x89, 0x50, 0x4e, 0x47]);
    await expect(
      uploadPrescriptionPhoto({
        supabase,
        circleId: CIRCLE_ID,
        photoId: PHOTO_ID,
        bytes: png,
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow(/jpeg/i);
    expect(calls).toHaveLength(0);
  });

  it('a Storage upload error is thrown, never reported as an uploaded imagePath', async () => {
    const { uploadPrescriptionPhoto } = loadRxStorageModule();
    const { supabase, calls } = fakeSupabase({
      uploadError: 'new row violates row-level security policy',
    });
    await expect(
      uploadPrescriptionPhoto({
        supabase,
        circleId: CIRCLE_ID,
        photoId: PHOTO_ID,
        bytes: jpegBytes(2048),
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([
      { kind: 'upload', bucket: 'prescription-photos', arg: `${CIRCLE_ID}/${PHOTO_ID}.jpg` },
    ]);
  });

  it('delete: a Storage error is thrown (the caller decides), and a bad imagePath never reaches Storage', async () => {
    const { deletePrescriptionPhoto } = loadRxStorageModule();

    const failing = fakeSupabase({ removeError: 'network down' });
    await expect(
      deletePrescriptionPhoto({
        supabase: failing.supabase,
        imagePath: `${CIRCLE_ID}/${PHOTO_ID}.jpg`,
      }),
    ).rejects.toThrow();

    const { supabase, calls } = fakeSupabase();
    for (const bad of [
      '',
      `${CIRCLE_ID}`,
      `${CIRCLE_ID}/`,
      `${CIRCLE_ID}/${PHOTO_ID}.png`,
      `${CIRCLE_ID}/nested/${PHOTO_ID}.jpg`,
      `../${CIRCLE_ID}/${PHOTO_ID}.jpg`,
    ]) {
      await expect(deletePrescriptionPhoto({ supabase, imagePath: bad })).rejects.toThrow(
        /imagePath/i,
      );
    }
    expect(calls).toHaveLength(0);
  });
});
