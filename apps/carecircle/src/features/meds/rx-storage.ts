export const PRESCRIPTION_PHOTOS_BUCKET = 'prescription-photos';
export const MAX_PRESCRIPTION_PHOTO_BYTES = 2 * 1024 * 1024;

const LOWERCASE_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRESCRIPTION_PHOTO_PATH_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

export interface RxStorageClientBucket {
  upload: (
    path: string,
    body: Uint8Array | ArrayBuffer,
    options: { contentType: string; upsert: boolean },
  ) => Promise<{ data: { path: string } | null; error: { message: string } | null }>;
  remove: (
    paths: string[],
  ) => Promise<{ data: Array<{ name: string }> | null; error: { message: string } | null }>;
}

export interface RxStorageSupabaseLike {
  storage: {
    from: (bucket: string) => RxStorageClientBucket;
  };
}

type UuidSources = {
  crypto?: { randomUUID?: () => string };
  expo?: { uuidv4?: () => string };
};

// Hermes (the JavaScript engine on iOS and Android) has no `crypto.randomUUID`, so on a phone
// we use the UUID generator that every Expo app already has natively (`globalThis.expo.uuidv4`,
// from expo-modules-core). Jest and the web have `crypto.randomUUID`.
export function createPrescriptionPhotoId(
  sources: UuidSources = globalThis as unknown as UuidSources,
): string {
  const randomUUID = sources.crypto?.randomUUID;
  const id =
    typeof randomUUID === 'function'
      ? randomUUID.call(sources.crypto)
      : typeof sources.expo?.uuidv4 === 'function'
        ? sources.expo.uuidv4()
        : null;
  if (id === null) {
    throw new Error('No UUID generator available for the prescription photo id');
  }
  const lower = id.toLowerCase();
  if (!LOWERCASE_UUID_REGEX.test(lower)) {
    throw new Error('UUID generator returned an invalid prescription photo id');
  }
  return lower;
}

export function buildPrescriptionPhotoPath(
  circleId: string,
  photoId: string = createPrescriptionPhotoId(),
): string {
  if (!LOWERCASE_UUID_REGEX.test(circleId)) {
    throw new Error('Invalid circleId: must be a lowercase UUID');
  }
  if (!LOWERCASE_UUID_REGEX.test(photoId)) {
    throw new Error('Invalid photoId: must be a lowercase UUID');
  }
  return `${circleId}/${photoId}.jpg`;
}

function isJpegHeader(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export async function uploadPrescriptionPhoto(opts: {
  supabase: RxStorageSupabaseLike;
  circleId: string;
  photoId?: string;
  bytes: Uint8Array;
  contentType: string;
}): Promise<{ imagePath: string }> {
  const imagePath = buildPrescriptionPhotoPath(
    opts.circleId,
    opts.photoId ?? createPrescriptionPhotoId(),
  );

  if (opts.contentType.trim().toLowerCase() !== 'image/jpeg') {
    throw new Error('Prescription photo contentType must be image/jpeg');
  }

  if (opts.bytes.byteLength === 0 || opts.bytes.byteLength > MAX_PRESCRIPTION_PHOTO_BYTES) {
    throw new Error('Prescription photo size must be between 1 byte and 2 MB');
  }

  if (!isJpegHeader(opts.bytes)) {
    throw new Error('Prescription photo bytes must start with a valid JPEG header (FF D8 FF)');
  }

  const { error } = await opts.supabase.storage
    .from(PRESCRIPTION_PHOTOS_BUCKET)
    .upload(imagePath, opts.bytes, {
      contentType: 'image/jpeg',
      upsert: false,
    });

  if (error) {
    throw new Error(error.message || 'Failed to upload prescription photo');
  }

  return { imagePath };
}

export async function deletePrescriptionPhoto(opts: {
  supabase: RxStorageSupabaseLike;
  imagePath: string;
}): Promise<void> {
  if (!PRESCRIPTION_PHOTO_PATH_REGEX.test(opts.imagePath)) {
    throw new Error('Invalid imagePath: must match <circle_id>/<uuid>.jpg');
  }

  const { error } = await opts.supabase.storage
    .from(PRESCRIPTION_PHOTOS_BUCKET)
    .remove([opts.imagePath]);

  if (error) {
    throw new Error(error.message || 'Failed to delete prescription photo');
  }
}
