import {
  createCleanupLogExportsHandler,
  createCleanupPrescriptionPhotosHandler,
} from './handler.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

Deno.test(
  'cleanup-prescription-photos: bucket="log-exports" lists expired PDFs via list_expired_log_exports and deletes only valid <circle_id>/<uuid>.pdf paths',
  async () => {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const handler = createCleanupPrescriptionPhotosHandler({
      getEnv: (key) => {
        if (key === 'SUPABASE_SERVICE_ROLE_KEY') return 'svc-key-secret';
        if (key === 'SUPABASE_URL') return 'https://example.supabase.co';
        return undefined;
      },
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? init.body : '';
        calls.push({ url, method, body });

        if (url.endsWith('/rest/v1/rpc/list_expired_log_exports')) {
          return new Response(
            JSON.stringify([
              'cc7c0001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.pdf',
              'cc7c0001-0000-4000-8000-000000000001/not-a-pdf.txt',
              '../traversal.pdf',
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('/storage/v1/object/log-exports') && method === 'DELETE') {
          return new Response(JSON.stringify([{ name: 'deleted' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('unexpected', { status: 500 });
      },
    });

    const res = await handler(
      new Request('http://localhost/functions/v1/cleanup-prescription-photos', {
        method: 'POST',
        headers: {
          authorization: 'Bearer svc-key-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ bucket: 'log-exports' }),
      }),
    );
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = (await res.json()) as { ok: boolean; deleted: number };
    assert(body.ok === true && body.deleted === 1, `unexpected body ${JSON.stringify(body)}`);
    assert(calls.length === 2, `expected 2 fetch calls, got ${calls.length}`);
    assert(
      calls[1]?.body ===
        JSON.stringify({
          prefixes: [
            'cc7c0001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.pdf',
          ],
        }),
      `unexpected delete payload: ${calls[1]?.body}`,
    );
  },
);

Deno.test('createCleanupLogExportsHandler: rejects unauthorized callers with 401', async () => {
  const handler = createCleanupLogExportsHandler({
    getEnv: (key) => (key === 'SUPABASE_SERVICE_ROLE_KEY' ? 'svc-key-secret' : undefined),
  });
  const res = await handler(
    new Request('http://localhost/functions/v1/cleanup-log-exports', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-key' },
    }),
  );
  assert(res.status === 401, `expected 401, got ${res.status}`);
});
