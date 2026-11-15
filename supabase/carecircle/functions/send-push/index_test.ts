import { createSendPushHandler, type SendPushDeps, type StoredPushToken } from './handler.ts';

const USER_1 = '11111111-1111-4111-8111-111111111111';
const USER_2 = '22222222-2222-4222-8222-222222222222';
const SERVICE_KEY = 'test-service-role-secret-key';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
};

async function invokeSendPush(
  deps: SendPushDeps,
  opts: {
    authHeader?: string;
    body?: unknown;
  } = {},
) {
  const handler = createSendPushHandler({
    getEnv: (key) =>
      key === 'SUPABASE_SERVICE_ROLE_KEY'
        ? SERVICE_KEY
        : key === 'SUPABASE_URL'
          ? 'http://supabase.local'
          : undefined,
    ...deps,
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.authHeader !== undefined) {
    headers.authorization = opts.authHeader;
  } else {
    headers.authorization = `Bearer ${SERVICE_KEY}`;
  }
  const req = new Request('http://localhost/functions/v1/send-push', {
    method: 'POST',
    headers,
    body: JSON.stringify(
      opts.body ?? {
        userIds: [USER_1, USER_2],
        title: 'Missed Dose Alert',
        body: 'Morning medication was not logged.',
        data: { circleId: USER_1 },
      },
    ),
  });
  const res = await handler(req);
  return {
    status: res.status,
    json: (await res.json()) as {
      ok: boolean;
      sent?: number;
      pruned?: number;
      error?: { code: string; message: string };
    },
  };
}

Deno.test('send-push rejects missing or non-service-role authorization', async () => {
  let calledFetch = false;
  const fetchImpl: typeof fetch = async () => {
    calledFetch = true;
    return Response.json({});
  };

  for (const authHeader of ['', 'Bearer wrong-token', 'Bearer anon-jwt']) {
    const res = await invokeSendPush({ fetchImpl }, { authHeader });
    assert(
      res.status === 401 && res.json.ok === false && res.json.error?.code === 'UNAUTHENTICATED',
      `expected 401 UNAUTHENTICATED for "${authHeader}", got ${res.status}`,
    );
  }
  assert(!calledFetch, 'unauthorized requests must never query tokens or call Expo push');
});

Deno.test('send-push validates payload and deduplicates userIds before sending', async () => {
  const badRes = await invokeSendPush(
    {},
    {
      body: { userIds: ['not-a-uuid'], title: 'Hi', body: 'Body' },
    },
  );
  assert(
    badRes.status === 400 && badRes.json.error?.code === 'INPUT_INVALID',
    'non-UUID userIds must return 400 INPUT_INVALID',
  );

  let queriedUserIds: string[] = [];
  let sentBatch: Array<Record<string, unknown>> = [];
  const prunedList: string[] = [];

  const res = await invokeSendPush(
    {
      loadTokens: async (ids) => {
        queriedUserIds = ids;
        const rows: StoredPushToken[] = [
          { user_id: USER_1, token: 'ExponentPushToken[token-1]', platform: 'ios' },
          { user_id: USER_2, token: 'ExponentPushToken[token-2]', platform: 'android' },
        ];
        return rows;
      },
      pruneTokens: async (tokens) => {
        prunedList.push(...tokens);
      },
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        assert(url === 'https://exp.host/--/api/v2/push/send', `unexpected URL ${url}`);
        sentBatch = JSON.parse(typeof init?.body === 'string' ? init.body : '[]');
        return Response.json({
          data: [
            { status: 'ok', id: 'receipt-1' },
            { status: 'error', details: { error: 'DeviceNotRegistered' } },
          ],
        });
      },
    },
    {
      body: {
        userIds: [USER_1, USER_2, USER_1],
        title: 'Missed Dose Alert',
        body: 'Metformin 500 mg is overdue.',
        data: { type: 'missed_dose' },
      },
    },
  );

  assert(
    queriedUserIds.length === 2 && queriedUserIds[0] === USER_1 && queriedUserIds[1] === USER_2,
    'send-push must deduplicate userIds before querying push_tokens',
  );
  assert(
    sentBatch.length === 2 &&
      sentBatch[0]?.to === 'ExponentPushToken[token-1]' &&
      sentBatch[0]?.title === 'Missed Dose Alert' &&
      sentBatch[0]?.body === 'Metformin 500 mg is overdue.' &&
      sentBatch[0]?.sound === 'default' &&
      (sentBatch[0]?.data as Record<string, unknown> | undefined)?.type === 'missed_dose' &&
      sentBatch[1]?.to === 'ExponentPushToken[token-2]',
    'send-push must send one Expo message per unique device token with title, body, sound, and data',
  );
  assert(
    res.status === 200 && res.json.ok === true && res.json.sent === 1 && res.json.pruned === 1,
    `expected sent=1 and pruned=1, got ${JSON.stringify(res.json)}`,
  );
  assert(
    prunedList.length === 1 && prunedList[0] === 'ExponentPushToken[token-2]',
    'DeviceNotRegistered token must be pruned from push_tokens',
  );
});

Deno.test('send-push returns sent=0 without calling Expo when users have no tokens', async () => {
  let expoCalled = false;
  const res = await invokeSendPush({
    loadTokens: async () => [],
    fetchImpl: async () => {
      expoCalled = true;
      return Response.json({});
    },
  });
  assert(
    res.status === 200 && res.json.ok === true && res.json.sent === 0 && !expoCalled,
    'empty token list must return sent=0 without calling Expo',
  );
});

Deno.test(
  'send-push default PostgREST adapters query push_tokens, prune DeviceNotRegistered, and fail closed on DB/Expo errors',
  async () => {
    const calls: Array<{ url: string; method: string; auth: string; apikey: string }> = [];
    const handler = createSendPushHandler({
      getEnv: (key) => {
        if (key === 'SUPABASE_SERVICE_ROLE_KEY') return SERVICE_KEY;
        if (key === 'SUPABASE_URL') return 'http://supabase.local';
        if (key === 'EXPO_ACCESS_TOKEN') return 'expo-secret-token';
        return undefined;
      },
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        calls.push({
          url,
          method,
          auth: headers.get('authorization') ?? '',
          apikey: headers.get('apikey') ?? '',
        });

        if (url.startsWith('http://supabase.local/rest/v1/push_tokens?user_id=in.')) {
          return Response.json([
            { user_id: USER_1, token: 'ExponentPushToken[t1]', platform: 'ios' },
            { user_id: USER_2, token: 'ExponentPushToken[t1]', platform: 'ios' },
            { user_id: USER_2, token: 'ExponentPushToken[stale-t2]', platform: 'android' },
          ]);
        }
        if (url === 'https://exp.host/--/api/v2/push/send') {
          return Response.json({
            data: [
              { status: 'ok', id: 'r1' },
              { status: 'error', details: { error: 'DeviceNotRegistered' } },
            ],
          });
        }
        if (url.startsWith('http://supabase.local/rest/v1/push_tokens?token=eq.')) {
          return new Response(null, { status: 204 });
        }
        return new Response('Not found', { status: 404 });
      },
    });

    // Non-POST rejected with 405
    const getRes = await handler(
      new Request('http://localhost/functions/v1/send-push', { method: 'GET' }),
    );
    assert(getRes.status === 405, `expected 405 for GET, got ${getRes.status}`);

    // Full flow through default loadTokens + Expo + default pruneTokens
    const postRes = await handler(
      new Request('http://localhost/functions/v1/send-push', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SERVICE_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          userIds: [USER_1, USER_2],
          title: 'Dose Due',
          body: 'Check schedule',
        }),
      }),
    );
    const body = (await postRes.json()) as { ok: boolean; sent?: number; pruned?: number };
    assert(
      postRes.status === 200 && body.ok === true && body.sent === 1 && body.pruned === 1,
      `expected 200 ok with sent=1, pruned=1, got ${JSON.stringify(body)}`,
    );
    assert(calls.length === 3, `expected 3 HTTP calls (select, expo, delete), got ${calls.length}`);
    assert(
      calls[0]?.method === 'GET' &&
        calls[0]?.auth === `Bearer ${SERVICE_KEY}` &&
        calls[0]?.apikey === SERVICE_KEY &&
        calls[0]?.url.includes(`user_id=in.(${USER_1},${USER_2})`),
      `unexpected PostgREST SELECT call: ${JSON.stringify(calls[0])}`,
    );
    assert(
      calls[1]?.method === 'POST' && calls[1]?.auth === 'Bearer expo-secret-token',
      `expected EXPO_ACCESS_TOKEN header on Expo call: ${JSON.stringify(calls[1])}`,
    );
    assert(
      calls[2]?.method === 'DELETE' &&
        calls[2]?.auth === `Bearer ${SERVICE_KEY}` &&
        calls[2]?.url ===
          'http://supabase.local/rest/v1/push_tokens?token=eq.ExponentPushToken%5Bstale-t2%5D',
      `unexpected PostgREST DELETE call: ${JSON.stringify(calls[2])}`,
    );

    // PostgREST 500 fails closed with 503 PROVIDER_ERROR
    const dbFailRes = await invokeSendPush({
      fetchImpl: async () => new Response('db down', { status: 500 }),
    });
    assert(
      dbFailRes.status === 503 && dbFailRes.json.error?.code === 'PROVIDER_ERROR',
      `expected 503 PROVIDER_ERROR on PostgREST failure, got ${dbFailRes.status}`,
    );

    // Expo 500 fails with 502 PROVIDER_ERROR
    const expoFailRes = await invokeSendPush({
      loadTokens: async () => [
        { user_id: USER_1, token: 'ExponentPushToken[t1]', platform: 'ios' },
      ],
      fetchImpl: async () => new Response('expo down', { status: 500 }),
    });
    assert(
      expoFailRes.status === 502 && expoFailRes.json.error?.code === 'PROVIDER_ERROR',
      `expected 502 PROVIDER_ERROR on Expo HTTP failure, got ${expoFailRes.status}`,
    );
  },
);
