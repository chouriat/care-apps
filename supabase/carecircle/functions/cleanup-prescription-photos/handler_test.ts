// CC-4a pre-work [safety 1/2]: the daily clean-up of prescription photos.
// Supabase refuses `delete from storage.objects` in SQL, and a SQL delete would leave the file itself in
// the bucket anyway. So the clean-up is an Edge Function, run once a day by pg_cron + pg_net:
// 1. Only a caller presenting the service role key (`Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`,
//    compared in constant time, like send-push) may run it. Anything else: 401 and no other request.
// 2. It asks the database which photos are older than 24 hours:
//    POST `${SUPABASE_URL}/rest/v1/rpc/list_expired_prescription_photos` (service role key), which returns
//    a JSON array of object names (see tests/rx_storage_rls.test.sql).
// 3. It deletes exactly those names through the Storage API, in one call:
//    DELETE `${SUPABASE_URL}/storage/v1/object/prescription-photos` with body `{ "prefixes": [names] }`.
//    Names that are not `<uuid>/<uuid>.jpg` are never sent. Nothing listed: no Storage call.
// 4. Answers `{ ok: true, deleted: <number Storage reports deleted> }`, or a 5xx with `ok: false` when the
//    list or the delete fails (so a failed run shows up in the cron history).
//
// The module is loaded at run time so this tests-only PR type-checks before handler.ts exists.

type CleanupDeps = {
  fetchImpl?: typeof fetch;
  getEnv?: (key: string) => string | undefined;
};
type CleanupModule = {
  createCleanupPrescriptionPhotosHandler: (
    deps?: CleanupDeps,
  ) => (req: Request) => Promise<Response>;
};

const loadModule = async (): Promise<CleanupModule> => {
  const path = './handler.ts';
  return (await import(path)) as CleanupModule;
};

const SUPABASE_URL = 'https://example.supabase.co';
const SERVICE_KEY = 'service-role-key';
const EXPIRED = [
  'cc4ac002-0000-4000-8000-000000000002/99999999-9999-4999-8999-999999999999.jpg',
  'cc4ac001-0000-4000-8000-000000000001/77777777-7777-4777-8777-777777777777.jpg',
];

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
};

type Seen = { url: string; method: string; body: string; auth: string };

const run = async (opts: {
  auth?: string | null;
  method?: string;
  listed?: unknown;
  listStatus?: number;
  deleteStatus?: number;
}) => {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    seen.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? init.body : '',
      auth: headers.get('authorization') ?? '',
    });
    if (url === `${SUPABASE_URL}/rest/v1/rpc/list_expired_prescription_photos`) {
      const status = opts.listStatus ?? 200;
      return status === 200
        ? Response.json(opts.listed ?? EXPIRED)
        : new Response('boom', { status });
    }
    if (url === `${SUPABASE_URL}/storage/v1/object/prescription-photos`) {
      const status = opts.deleteStatus ?? 200;
      if (status !== 200) return new Response('boom', { status });
      const { prefixes } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        prefixes: string[];
      };
      return Response.json(prefixes.map((name) => ({ name })));
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  const { createCleanupPrescriptionPhotosHandler } = await loadModule();
  const handler = createCleanupPrescriptionPhotosHandler({
    fetchImpl,
    getEnv: (key) =>
      key === 'SUPABASE_URL'
        ? SUPABASE_URL
        : key === 'SUPABASE_SERVICE_ROLE_KEY'
          ? SERVICE_KEY
          : undefined,
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const auth = opts.auth === undefined ? `Bearer ${SERVICE_KEY}` : opts.auth;
  if (auth !== null) headers.authorization = auth;
  const res = await handler(
    new Request('http://localhost/functions/v1/cleanup-prescription-photos', {
      method: opts.method ?? 'POST',
      headers,
      body: (opts.method ?? 'POST') === 'POST' ? '{}' : undefined,
    }),
  );
  const body = (await res.json().catch(() => null)) as { ok?: boolean; deleted?: number } | null;
  return { res, body, seen };
};

Deno.test('cleanup refuses callers without the service role key and makes no request', async () => {
  for (const auth of [null, 'Bearer user-jwt', `Bearer ${SERVICE_KEY}x`, SERVICE_KEY, 'Bearer ']) {
    const { res, seen } = await run({ auth });
    assert(
      res.status === 401,
      `expected 401 for authorization ${JSON.stringify(auth)}, got ${res.status}`,
    );
    assert(seen.length === 0, `no request may be made for authorization ${JSON.stringify(auth)}`);
  }
  const get = await run({ method: 'GET' });
  assert(
    get.res.status === 405 && get.seen.length === 0,
    'GET is refused with 405 and makes no request',
  );
});

Deno.test(
  'cleanup deletes exactly the listed expired photos through the Storage API, with the service key',
  async () => {
    const { res, body, seen } = await run({});
    assert(
      res.status === 200 && body?.ok === true && body.deleted === 2,
      `expected ok and deleted 2, got ${res.status} ${JSON.stringify(body)}`,
    );
    assert(
      seen.length === 2,
      `expected exactly 2 requests (list, delete), got ${seen.map((s) => s.url).join(', ')}`,
    );
    assert(
      seen[0].url.endsWith('/rest/v1/rpc/list_expired_prescription_photos') &&
        seen[0].method === 'POST',
      'first: list RPC',
    );
    assert(
      seen[1].url === `${SUPABASE_URL}/storage/v1/object/prescription-photos` &&
        seen[1].method === 'DELETE',
      `second: Storage API delete on prescription-photos, got ${seen[1].method} ${seen[1].url}`,
    );
    const sent = JSON.parse(seen[1].body) as { prefixes?: string[] };
    assert(
      JSON.stringify([...(sent.prefixes ?? [])].sort()) === JSON.stringify([...EXPIRED].sort()),
      `Storage delete must name exactly the listed photos, got ${seen[1].body}`,
    );
    assert(
      seen.every((s) => s.auth === `Bearer ${SERVICE_KEY}`),
      'both requests use the service role key',
    );
  },
);

Deno.test(
  'cleanup never sends a name that is not <uuid>/<uuid>.jpg, and skips Storage when nothing is left',
  async () => {
    const odd = [
      '',
      'cc4ac001-0000-4000-8000-000000000001',
      'cc4ac001-0000-4000-8000-000000000001/',
      '../x.jpg',
      'other/thing.png',
    ];
    const mixed = await run({ listed: [...odd, EXPIRED[0]] });
    const del = mixed.seen.find((s) => s.method === 'DELETE');
    assert(!!del, 'the valid name is still deleted');
    assert(
      JSON.stringify((JSON.parse(del!.body) as { prefixes: string[] }).prefixes) ===
        JSON.stringify([EXPIRED[0]]),
      `only the valid name may be sent, got ${del!.body}`,
    );

    const none = await run({ listed: odd });
    assert(
      none.body?.ok === true && none.body.deleted === 0,
      `expected ok with deleted 0, got ${JSON.stringify(none.body)}`,
    );
    assert(
      !none.seen.some((s) => s.method === 'DELETE'),
      'no Storage call when nothing valid is listed',
    );

    const empty = await run({ listed: [] });
    assert(empty.body?.ok === true && empty.body.deleted === 0, 'empty list: ok, deleted 0');
    assert(empty.seen.length === 1, 'empty list: only the list request');
  },
);

Deno.test('cleanup reports failure with a 5xx when listing or deleting fails', async () => {
  const listFail = await run({ listStatus: 500 });
  assert(
    listFail.res.status >= 500 && listFail.body?.ok === false,
    `list failure must be 5xx ok:false, got ${listFail.res.status}`,
  );
  assert(
    !listFail.seen.some((s) => s.method === 'DELETE'),
    'no Storage delete when the list failed',
  );

  const delFail = await run({ deleteStatus: 500 });
  assert(
    delFail.res.status >= 500 && delFail.body?.ok === false,
    `delete failure must be 5xx ok:false, got ${delFail.res.status}`,
  );
});
