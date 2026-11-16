export type CleanupPrescriptionPhotosDeps = {
  fetchImpl?: typeof fetch;
  getEnv?: (key: string) => string | undefined;
};

const VALID_PHOTO_NAME_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

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

    const authHeaders = {
      authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'content-type': 'application/json',
    };

    let listRes: Response;
    try {
      listRes = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/list_expired_prescription_photos`, {
        method: 'POST',
        headers: authHeaders,
        body: '{}',
      });
    } catch {
      return json({ ok: false, error: 'Failed to list expired prescription photos' }, 502);
    }

    if (!listRes.ok) {
      return json({ ok: false, error: 'Failed to list expired prescription photos' }, 502);
    }

    const listed = await listRes.json().catch(() => null);
    if (!Array.isArray(listed)) {
      return json(
        { ok: false, error: 'Invalid response from list_expired_prescription_photos' },
        502,
      );
    }

    const prefixes = listed.filter(
      (item): item is string => typeof item === 'string' && VALID_PHOTO_NAME_REGEX.test(item),
    );

    if (prefixes.length === 0) {
      return json({ ok: true, deleted: 0 }, 200);
    }

    let deleteRes: Response;
    try {
      deleteRes = await fetchImpl(`${supabaseUrl}/storage/v1/object/prescription-photos`, {
        method: 'DELETE',
        headers: authHeaders,
        body: JSON.stringify({ prefixes }),
      });
    } catch {
      return json({ ok: false, error: 'Failed to delete expired prescription photos' }, 502);
    }

    if (!deleteRes.ok) {
      return json({ ok: false, error: 'Failed to delete expired prescription photos' }, 502);
    }

    const deletedRows = await deleteRes.json().catch(() => null);
    const deleted = Array.isArray(deletedRows) ? deletedRows.length : prefixes.length;
    return json({ ok: true, deleted }, 200);
  };
}
