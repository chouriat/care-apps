export const VISIT_AUDIO_BUCKET = 'visit-audio';
export const MAX_VISIT_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_VISIT_RECORDING_MS = 10 * 60 * 1000;

const LOWERCASE_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VISIT_AUDIO_PATH_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.m4a$/;

export interface VisitStorageClientBucket {
  upload: (
    path: string,
    body: Uint8Array | ArrayBuffer,
    options: { contentType: string; upsert: boolean },
  ) => Promise<{ data: { path: string } | null; error: { message: string } | null }>;
  remove: (
    paths: string[],
  ) => Promise<{ data: Array<{ name: string }> | null; error: { message: string } | null }>;
}

export interface VisitStorageSupabaseLike {
  storage: {
    from: (bucket: string) => VisitStorageClientBucket;
  };
}

type UuidSources = {
  crypto?: { randomUUID?: () => string };
  expo?: { uuidv4?: () => string };
};

export function createVisitAudioId(
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
    throw new Error('No UUID generator available for the visit audio id');
  }
  const lower = id.toLowerCase();
  if (!LOWERCASE_UUID_REGEX.test(lower)) {
    throw new Error('UUID generator returned an invalid visit audio id');
  }
  return lower;
}

export function buildVisitAudioPath(
  circleId: string,
  audioId: string = createVisitAudioId(),
): string {
  const normalizedCircle = circleId.toLowerCase();
  const normalizedAudio = audioId.toLowerCase();
  if (!LOWERCASE_UUID_REGEX.test(normalizedCircle)) {
    throw new Error('Invalid circleId: must be a lowercase UUID');
  }
  if (!LOWERCASE_UUID_REGEX.test(normalizedAudio)) {
    throw new Error('Invalid audioId: must be a lowercase UUID');
  }
  return `${normalizedCircle}/${normalizedAudio}.m4a`;
}

export async function uploadVisitAudio(opts: {
  supabase: VisitStorageSupabaseLike;
  circleId: string;
  audioId?: string;
  bytes: Uint8Array;
  contentType?: 'audio/m4a' | 'audio/mp4';
}): Promise<{ audioPath: string }> {
  const audioPath = buildVisitAudioPath(opts.circleId, opts.audioId ?? createVisitAudioId());
  const contentType = opts.contentType ?? 'audio/m4a';

  if (contentType !== 'audio/m4a' && contentType !== 'audio/mp4') {
    throw new Error('Visit audio contentType must be audio/m4a or audio/mp4');
  }

  if (opts.bytes.byteLength === 0 || opts.bytes.byteLength > MAX_VISIT_AUDIO_BYTES) {
    throw new Error('Visit audio size must be between 1 byte and 10 MB');
  }

  const { error } = await opts.supabase.storage
    .from(VISIT_AUDIO_BUCKET)
    .upload(audioPath, opts.bytes, {
      contentType,
      upsert: false,
    });

  if (error) {
    throw new Error(error.message || 'Failed to upload visit audio');
  }

  return { audioPath };
}

export async function deleteVisitAudioObject(opts: {
  supabase: VisitStorageSupabaseLike;
  audioPath: string;
}): Promise<void> {
  if (!VISIT_AUDIO_PATH_REGEX.test(opts.audioPath)) {
    throw new Error('Invalid audioPath: must match <circle_id>/<uuid>.m4a');
  }

  const { error } = await opts.supabase.storage.from(VISIT_AUDIO_BUCKET).remove([opts.audioPath]);

  if (error) {
    throw new Error(error.message || 'Failed to delete visit audio');
  }
}
