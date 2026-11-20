// Claude's review of CC-10 (20 Nov 2026). index_test.ts drives the handler with an in-memory `state`
// that replaces the real code path, so it never checks what the deployed function does. These tests
// run the real path (no `state`): the JWT check against Auth, the delete_own_account RPC with the
// service key, and the Storage API calls, with a fake `fetch` standing in for Supabase.
import { createDeleteAccountHandler } from './handler.ts';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
};

const SUPABASE_URL = 'https://example-ref.supabase.co';
const SERVICE_KEY = 'service-role-key-for-tests';
const USER_ID = 'cc100000-0000-4000-8000-0000000000aa';
const SOLO_CIRCLE = 'cc10c1c1-0000-4000-8000-000000000001';
const OTHER_CIRCLE = 'cc10c1c1-0000-4000-8000-000000000002';

type Call = { method: string; path: string; body: unknown; auth: string | null };

function fakeSupabase(opts: {
  rpcStatus?: number;
  rpcBody?: unknown;
  files?: Record<string, string[]>;
  failList?: boolean;
}) {
  const calls: Call[] = [];
  const files: Record<string, string[]> = structuredClone(opts.files ?? {});
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const headers = new Headers(init?.headers);
    calls.push({ method, path: url.pathname, body, auth: headers.get('authorization') });

    if (url.pathname === '/auth/v1/user') {
      return headers.get('authorization') === 'Bearer good-user-jwt'
        ? Response.json({ id: USER_ID })
        : new Response('{}', { status: 401 });
    }
    if (url.pathname === '/rest/v1/rpc/delete_own_account') {
      const status = opts.rpcStatus ?? 200;
      return status === 200
        ? Response.json(opts.rpcBody ?? { ok: true, deletedCircleIds: [] })
        : new Response(JSON.stringify(opts.rpcBody ?? {}), { status });
    }
    const list = /^\/storage\/v1\/object\/list\/([^/]+)$/.exec(url.pathname);
    if (list && method === 'POST') {
      if (opts.failList) return new Response('{}', { status: 500 });
      const bucket = list[1]!;
      const prefix = String((body as { prefix?: string }).prefix ?? '');
      const names = (files[bucket] ?? [])
        .filter((p) => p.startsWith(`${prefix}/`))
        .map((p) => ({ name: p.slice(prefix.length + 1) }));
      return Response.json(names);
    }
    const del = /^\/storage\/v1\/object\/([^/]+)$/.exec(url.pathname);
    if (del && method === 'DELETE') {
      const bucket = del[1]!;
      const prefixes = (body as { prefixes: string[] }).prefixes;
      files[bucket] = (files[bucket] ?? []).filter((p) => !prefixes.includes(p));
      return Response.json([]);
    }
    if (url.pathname.startsWith('/auth/v1/admin/users/') && method === 'DELETE') {
      return Response.json({});
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls, files };
}

const env = (key: string): string | undefined =>
  ({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, SUPABASE_ANON_KEY: 'anon' })[key];

const post = (handler: (req: Request) => Promise<Response>, token?: string) =>
  handler(
    new Request('http://localhost/functions/v1/delete-account', {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );

Deno.test(
  'real path: deletes every file of the deleted circle in all three buckets, and nothing else',
  async () => {
    const sb = fakeSupabase({
      rpcBody: { ok: true, deletedCircleIds: [SOLO_CIRCLE] },
      files: {
        'prescription-photos': [`${SOLO_CIRCLE}/a.jpg`, `${OTHER_CIRCLE}/keep.jpg`],
        'visit-audio': [`${SOLO_CIRCLE}/b.m4a`],
        'log-exports': [`${SOLO_CIRCLE}/c.pdf`, `${OTHER_CIRCLE}/keep.pdf`],
      },
    });
    const logs: Record<string, unknown>[] = [];
    const handler = createDeleteAccountHandler({
      fetchImpl: sb.fetchImpl,
      getEnv: env,
      logger: (e) => void logs.push(e),
    });
    const res = await post(handler, 'good-user-jwt');
    assert(res.status === 200, `expected 200, got ${res.status}`);

    const rpc = sb.calls.find((c) => c.path === '/rest/v1/rpc/delete_own_account');
    assert(rpc?.auth === `Bearer ${SERVICE_KEY}`, 'the RPC is called with the service key');
    assert(
      (rpc?.body as { p_target_user_id?: string }).p_target_user_id === USER_ID,
      'the RPC deletes the user from the verified JWT',
    );
    // Written out, not taken from the handler, so a bucket dropped from the handler fails here.
    for (const bucket of ['prescription-photos', 'visit-audio', 'log-exports']) {
      assert(
        !(sb.files[bucket] ?? []).some((p) => p.startsWith(`${SOLO_CIRCLE}/`)),
        `${bucket}: no file of the deleted circle is left, got ${JSON.stringify(sb.files[bucket])}`,
      );
    }
    assert(
      sb.files['prescription-photos']!.includes(`${OTHER_CIRCLE}/keep.jpg`) &&
        sb.files['log-exports']!.includes(`${OTHER_CIRCLE}/keep.pdf`),
      "another circle's files are never touched",
    );
    assert(
      logs.length === 1 && logs[0]!.storageFailures === 0,
      `one log line, no failures: ${JSON.stringify(logs)}`,
    );
  },
);

Deno.test('real path: OWNER_MUST_TRANSFER deletes no file and no auth user', async () => {
  const sb = fakeSupabase({
    rpcStatus: 400,
    rpcBody: { code: 'P0001', message: 'OWNER_MUST_TRANSFER' },
    files: { 'prescription-photos': [`${SOLO_CIRCLE}/a.jpg`] },
  });
  const handler = createDeleteAccountHandler({
    fetchImpl: sb.fetchImpl,
    getEnv: env,
    logger: () => {},
  });
  const res = await post(handler, 'good-user-jwt');
  const body = await res.json();
  assert(
    res.status === 409 && body.code === 'OWNER_MUST_TRANSFER',
    `got ${res.status} ${JSON.stringify(body)}`,
  );
  assert(
    !sb.calls.some((c) => c.method === 'DELETE'),
    `nothing is deleted, got ${JSON.stringify(sb.calls.map((c) => `${c.method} ${c.path}`))}`,
  );
});

Deno.test('real path: a missing or wrong JWT never reaches the database', async () => {
  for (const token of [undefined, 'forged-jwt']) {
    const sb = fakeSupabase({});
    const handler = createDeleteAccountHandler({
      fetchImpl: sb.fetchImpl,
      getEnv: env,
      logger: () => {},
    });
    const res = await post(handler, token);
    assert(res.status === 401, `expected 401 for ${token ?? 'no token'}, got ${res.status}`);
    assert(
      !sb.calls.some((c) => c.path.startsWith('/rest/') || c.path.startsWith('/storage/')),
      'no database or Storage call without a valid user',
    );
  }
});

Deno.test(
  'real path: a Storage failure still deletes the account and is counted in the log',
  async () => {
    const sb = fakeSupabase({
      rpcBody: { ok: true, deletedCircleIds: [SOLO_CIRCLE] },
      files: { 'visit-audio': [`${SOLO_CIRCLE}/b.m4a`] },
      failList: true,
    });
    const logs: Record<string, unknown>[] = [];
    const handler = createDeleteAccountHandler({
      fetchImpl: sb.fetchImpl,
      getEnv: env,
      logger: (e) => void logs.push(e),
    });
    const res = await post(handler, 'good-user-jwt');
    assert(res.status === 200, `the account is gone, so 200; got ${res.status}`);
    assert(
      logs[0]!.storageFailures === 3,
      `each failed bucket is counted, got ${JSON.stringify(logs)}`,
    );
  },
);
