import {
  createCleanupPrescriptionPhotosHandler,
  createCleanupVisitAudioHandler,
} from './handler.ts';

const SUPABASE_URL = 'https://example.supabase.co';
const SERVICE_KEY = 'service-role-secret-for-visit-audio-cleanup-test';

const EXPIRED_AUDIO = [
  'cc5ac002-0000-4000-8000-000000000002/99999999-9999-4999-8999-999999999999.m4a',
  'cc5ac001-0000-4000-8000-000000000001/77777777-7777-4777-8777-777777777777.m4a',
];

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
};

type SeenRequest = { url: string; method: string; auth: string | null; body: string };

Deno.test(
  'cleanup-visit-audio deletes expired visit-audio objects (<uuid>/<uuid>.m4a) via Storage API and ignores invalid names',
  async () => {
    const seen: SeenRequest[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? init.body : '';
      seen.push({ url, method, auth: headers.get('authorization'), body });

      if (url.endsWith('/rest/v1/rpc/list_expired_visit_audio') && method === 'POST') {
        return Response.json([
          ...EXPIRED_AUDIO,
          'bad-path.wav',
          'cc5ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg',
        ]);
      }
      if (url.endsWith('/storage/v1/object/visit-audio') && method === 'DELETE') {
        const { prefixes } = JSON.parse(body || '{"prefixes":[]}') as { prefixes: string[] };
        return Response.json(prefixes.map((name) => ({ name })));
      }
      throw new Error(`Unexpected fetch ${url}`);
    };

    const handler = createCleanupVisitAudioHandler({
      fetchImpl,
      getEnv: (key) =>
        key === 'SUPABASE_URL'
          ? SUPABASE_URL
          : key === 'SUPABASE_SERVICE_ROLE_KEY'
            ? SERVICE_KEY
            : undefined,
    });

    const res = await handler(
      new Request('http://localhost/functions/v1/cleanup-visit-audio', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SERVICE_KEY}`,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    );
    const body = (await res.json()) as { ok: boolean; deleted: number };
    assert(res.status === 200 && body.ok === true && body.deleted === 2, 'deleted 2 audio files');
    assert(seen.length === 2, 'expected 2 requests (RPC list + Storage delete)');
    const delBody = JSON.parse(seen[1]!.body) as { prefixes: string[] };
    assert(
      JSON.stringify(delBody.prefixes) === JSON.stringify(EXPIRED_AUDIO),
      `expected only valid .m4a paths to be deleted, got ${seen[1]!.body}`,
    );
  },
);

Deno.test(
  'cleanup-prescription-photos with {"includeVisitAudio":true} cleans both prescription-photos and visit-audio',
  async () => {
    const seen: SeenRequest[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? init.body : '';
      seen.push({ url, method, auth: headers.get('authorization'), body });

      if (url.endsWith('/rest/v1/rpc/list_expired_prescription_photos')) {
        return Response.json([
          'cc4ac001-0000-4000-8000-000000000001/77777777-7777-4777-8777-777777777777.jpg',
        ]);
      }
      if (url.endsWith('/storage/v1/object/prescription-photos') && method === 'DELETE') {
        return Response.json([{ name: 'deleted.jpg' }]);
      }
      if (url.endsWith('/rest/v1/rpc/list_expired_visit_audio')) {
        return Response.json(EXPIRED_AUDIO);
      }
      if (url.endsWith('/storage/v1/object/visit-audio') && method === 'DELETE') {
        return Response.json(EXPIRED_AUDIO.map((name) => ({ name })));
      }
      throw new Error(`Unexpected fetch ${url}`);
    };

    const handler = createCleanupPrescriptionPhotosHandler({
      fetchImpl,
      getEnv: (key) =>
        key === 'SUPABASE_URL'
          ? SUPABASE_URL
          : key === 'SUPABASE_SERVICE_ROLE_KEY'
            ? SERVICE_KEY
            : undefined,
    });

    const res = await handler(
      new Request('http://localhost/functions/v1/cleanup-prescription-photos', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SERVICE_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ includeVisitAudio: true }),
      }),
    );
    const body = (await res.json()) as {
      ok: boolean;
      deleted: number;
      deletedPhotos: number;
      deletedVisitAudio: number;
    };
    assert(
      res.status === 200 &&
        body.ok === true &&
        body.deleted === 3 &&
        body.deletedPhotos === 1 &&
        body.deletedVisitAudio === 2,
      `expected 1 photo + 2 visit audio deleted, got ${JSON.stringify(body)}`,
    );
  },
);
