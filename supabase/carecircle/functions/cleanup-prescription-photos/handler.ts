export type CleanupPrescriptionPhotosDeps = {
  fetchImpl?: typeof fetch;
  getEnv?: (key: string) => string | undefined;
};

const VALID_PHOTO_NAME_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

const VALID_VISIT_AUDIO_NAME_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.m4a$/;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function extractBearerToken(headerValue: string | null): string | null {
  if (!headerValue) {
    return null;
  }
  const trimmed = headerValue.trim();
  const match = /^Bearer\s+/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const token = trimmed.slice(match[0].length);
  return token.length > 0 ? token : null;
}

async function cleanupBucket(opts: {
  fetchImpl: typeof fetch;
  supabaseUrl: string;
  authHeaders: Record<string, string>;
  rpcName: string;
  bucketId: string;
  validNameRegex: RegExp;
  label: string;
}): Promise<{ ok: true; deleted: number } | { ok: false; error: string }> {
  let listRes: Response;
  try {
    listRes = await opts.fetchImpl(`${opts.supabaseUrl}/rest/v1/rpc/${opts.rpcName}`, {
      method: 'POST',
      headers: opts.authHeaders,
      body: '{}',
    });
  } catch {
    return { ok: false, error: `Failed to list expired ${opts.label}` };
  }

  if (!listRes.ok) {
    return { ok: false, error: `Failed to list expired ${opts.label}` };
  }

  const listed = await listRes.json().catch(() => null);
  if (!Array.isArray(listed)) {
    return { ok: false, error: `Invalid response from ${opts.rpcName}` };
  }

  const prefixes = listed.filter(
    (item): item is string => typeof item === 'string' && opts.validNameRegex.test(item),
  );

  if (prefixes.length === 0) {
    return { ok: true, deleted: 0 };
  }

  let deleteRes: Response;
  try {
    deleteRes = await opts.fetchImpl(`${opts.supabaseUrl}/storage/v1/object/${opts.bucketId}`, {
      method: 'DELETE',
      headers: opts.authHeaders,
      body: JSON.stringify({ prefixes }),
    });
  } catch {
    return { ok: false, error: `Failed to delete expired ${opts.label}` };
  }

  if (!deleteRes.ok) {
    return { ok: false, error: `Failed to delete expired ${opts.label}` };
  }

  const deletedRows = await deleteRes.json().catch(() => null);
  const deleted = Array.isArray(deletedRows) ? deletedRows.length : prefixes.length;
  return { ok: true, deleted };
}

export function createCleanupVisitAudioHandler(deps: CleanupPrescriptionPhotosDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getEnv = deps.getEnv ?? ((key: string) => Deno.env.get(key));

  return async (req: Request): Promise<Response> => {
    if (req.method.toUpperCase() !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    const serviceKey = (getEnv('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
    const bearerToken = extractBearerToken(req.headers.get('authorization'));
    if (!serviceKey || !bearerToken || !constantTimeEquals(bearerToken, serviceKey)) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const supabaseUrl = (getEnv('SUPABASE_URL') ?? '').trim().replace(/\/+$/, '');
    if (!supabaseUrl) {
      return json({ ok: false, error: 'Missing SUPABASE_URL' }, 500);
    }

    const authHeaders = {
      authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'content-type': 'application/json',
    };

    const result = await cleanupBucket({
      fetchImpl,
      supabaseUrl,
      authHeaders,
      rpcName: 'list_expired_visit_audio',
      bucketId: 'visit-audio',
      validNameRegex: VALID_VISIT_AUDIO_NAME_REGEX,
      label: 'visit audio',
    });
    if (!result.ok) {
      return json({ ok: false, error: result.error }, 502);
    }
    return json({ ok: true, deleted: result.deleted }, 200);
  };
}

export function createCleanupPrescriptionPhotosHandler(deps: CleanupPrescriptionPhotosDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getEnv = deps.getEnv ?? ((key: string) => Deno.env.get(key));

  return async (req: Request): Promise<Response> => {
    if (req.method.toUpperCase() !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    const serviceKey = (getEnv('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
    const bearerToken = extractBearerToken(req.headers.get('authorization'));
    if (!serviceKey || !bearerToken || !constantTimeEquals(bearerToken, serviceKey)) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const supabaseUrl = (getEnv('SUPABASE_URL') ?? '').trim().replace(/\/+$/, '');
    if (!supabaseUrl) {
      return json({ ok: false, error: 'Missing SUPABASE_URL' }, 500);
    }

    let includeVisitAudio = false;
    let visitAudioOnly = false;
    try {
      const rawBody = await req.text();
      if (rawBody.trim().length > 0) {
        const parsed = JSON.parse(rawBody) as { includeVisitAudio?: unknown; bucket?: unknown };
        if (parsed && typeof parsed === 'object') {
          if (parsed.includeVisitAudio === true) includeVisitAudio = true;
          if (parsed.bucket === 'visit-audio') visitAudioOnly = true;
        }
      }
    } catch {
      // Default to prescription-photos only if body is empty or not JSON.
    }

    const authHeaders = {
      authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'content-type': 'application/json',
    };

    if (visitAudioOnly) {
      const audioRes = await cleanupBucket({
        fetchImpl,
        supabaseUrl,
        authHeaders,
        rpcName: 'list_expired_visit_audio',
        bucketId: 'visit-audio',
        validNameRegex: VALID_VISIT_AUDIO_NAME_REGEX,
        label: 'visit audio',
      });
      if (!audioRes.ok) return json({ ok: false, error: audioRes.error }, 502);
      return json({ ok: true, deleted: audioRes.deleted }, 200);
    }

    const photoRes = await cleanupBucket({
      fetchImpl,
      supabaseUrl,
      authHeaders,
      rpcName: 'list_expired_prescription_photos',
      bucketId: 'prescription-photos',
      validNameRegex: VALID_PHOTO_NAME_REGEX,
      label: 'prescription photos',
    });
    if (!photoRes.ok) {
      return json({ ok: false, error: photoRes.error }, 502);
    }

    if (!includeVisitAudio) {
      return json({ ok: true, deleted: photoRes.deleted }, 200);
    }

    const audioRes = await cleanupBucket({
      fetchImpl,
      supabaseUrl,
      authHeaders,
      rpcName: 'list_expired_visit_audio',
      bucketId: 'visit-audio',
      validNameRegex: VALID_VISIT_AUDIO_NAME_REGEX,
      label: 'visit audio',
    });
    if (!audioRes.ok) {
      return json({ ok: false, error: audioRes.error }, 502);
    }

    return json(
      {
        ok: true,
        deleted: photoRes.deleted + audioRes.deleted,
        deletedPhotos: photoRes.deleted,
        deletedVisitAudio: audioRes.deleted,
      },
      200,
    );
  };
}
