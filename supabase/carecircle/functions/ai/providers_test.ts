import { createAiGatewayHandler, type AiCallLogRow, type AiGatewayDeps } from './handler.ts';
import {
  FAKE_FIXTURES,
  routes,
  type AiProvider,
  type AiRouteConfig,
  type AiTaskName,
} from './routes.ts';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '99999999-9999-4999-8999-999999999999';
const REQ_ID = '22222222-2222-4222-8222-222222222222';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
};

type ProviderName = 'fake' | 'anthropic' | 'gemini';

type PricedRoute = Omit<AiRouteConfig, 'provider'> & {
  provider: ProviderName;
  inputMicrocentsPer1k?: number;
  outputMicrocentsPer1k?: number;
  costCurrency?: string;
};

type ExtendedLogRow = AiCallLogRow & {
  estimated_cost_microcents?: number;
  cost_currency?: string;
};

type ExtendedDeps = Omit<AiGatewayDeps, 'providers' | 'logCall'> & {
  providers?: Partial<Record<ProviderName, AiProvider>>;
  logCall?: (row: ExtendedLogRow) => Promise<void>;
  countRecentCalls?: (userId: string, sinceIso: string) => Promise<number>;
  routeOverrides?: Partial<Record<AiTaskName, Partial<PricedRoute>>>;
  fetchImpl?: typeof fetch;
  getEnv?: (key: string) => string | undefined;
};

type TestEnvelope = {
  ok: boolean;
  output?: { name?: string; summary?: string };
  model?: string;
  latencyMs?: number;
  error?: { code: string; message: string; retryable: boolean };
};

async function postAi(
  deps: ExtendedDeps,
  opts: {
    task?: AiTaskName;
    input?: Record<string, unknown>;
    token?: string;
    useDefaultCounter?: boolean;
  } = {},
): Promise<TestEnvelope> {
  const mergedDeps: ExtendedDeps = {
    verifyJwt: async () => ({ userId: USER_A }),
    logCall: async () => {},
    ...(opts.useDefaultCounter ? {} : { countRecentCalls: async () => 0 }),
    ...deps,
  };
  const handler = createAiGatewayHandler(mergedDeps as AiGatewayDeps);
  const task = opts.task ?? 'carecircle.extractPrescription';
  const input = opts.input ?? { imagePath: 'rx.jpg' };
  const req = new Request('http://localhost/functions/v1/ai', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.token ?? 'valid-jwt'}`,
    },
    body: JSON.stringify({ task, input, requestId: REQ_ID }),
  });
  const res = await handler(req);
  return (await res.json()) as TestEnvelope;
}

Deno.test('routes dispatch to configured real providers instead of hardcoded fake', async () => {
  const rxRoute = routes['carecircle.extractPrescription'] as PricedRoute;
  const visitRoute = routes['carecircle.summarizeVisit'] as PricedRoute;

  assert(
    rxRoute.provider === 'anthropic' || rxRoute.provider === 'gemini',
    `expected extractPrescription provider to be anthropic or gemini, got ${rxRoute.provider}`,
  );
  assert(
    visitRoute.provider === 'anthropic' || visitRoute.provider === 'gemini',
    `expected summarizeVisit provider to be anthropic or gemini, got ${visitRoute.provider}`,
  );
  assert(
    !rxRoute.model.startsWith('fake/') && !visitRoute.model.startsWith('fake/'),
    'routes must configure real provider model names instead of fake/*',
  );
  const configuredProviders = new Set<ProviderName>([rxRoute.provider, visitRoute.provider]);
  assert(
    configuredProviders.has('anthropic') && configuredProviders.has('gemini'),
    'routes.ts must configure both anthropic and gemini across tasks',
  );

  const called: ProviderName[] = [];
  const makeStub = (name: ProviderName): AiProvider => ({
    generate: async (req) => {
      called.push(name);
      return { output: FAKE_FIXTURES[req.task], inputTokens: 50, outputTokens: 25 };
    },
  });

  const deps: ExtendedDeps = {
    providers: {
      fake: makeStub('fake'),
      anthropic: makeStub('anthropic'),
      gemini: makeStub('gemini'),
    },
  };

  const rxBody = await postAi(deps, { task: 'carecircle.extractPrescription' });
  assert(rxBody.ok === true, 'extractPrescription should succeed');
  assert(
    called.length === 1 && called[0] === rxRoute.provider,
    `expected extractPrescription to call ${rxRoute.provider}, got ${called.join(',')}`,
  );

  const visitBody = await postAi(deps, { task: 'carecircle.summarizeVisit' });
  assert(visitBody.ok === true, 'summarizeVisit should succeed');
  assert(
    called.length === 2 && called[1] === visitRoute.provider,
    `expected summarizeVisit to call ${visitRoute.provider}, got ${called.join(',')}`,
  );
  assert(!called.includes('fake'), 'real routes must never dispatch to fake provider');
});

Deno.test('same test prompt runs on both anthropic and gemini adapters and validates', async () => {
  const rxFixtureJson = JSON.stringify(FAKE_FIXTURES['carecircle.extractPrescription']);
  const seenRequests: Array<{ url: string; authHeader: string; bodyText: string }> = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    if (url.includes('api.anthropic.com')) {
      seenRequests.push({ url, authHeader: headers.get('x-api-key') ?? '', bodyText });
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: rxFixtureJson }],
          usage: { input_tokens: 120, output_tokens: 60 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      seenRequests.push({ url, authHeader: headers.get('x-goog-api-key') ?? '', bodyText });
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: rxFixtureJson }] } }],
          usageMetadata: { promptTokenCount: 110, candidatesTokenCount: 55 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const loggedRows: ExtendedLogRow[] = [];
  const getEnv = (key: string): string | undefined => {
    if (key === 'ANTHROPIC_API_KEY') return 'test-anthropic-secret-placeholder';
    if (key === 'GEMINI_API_KEY') return 'test-gemini-secret-placeholder';
    return undefined;
  };

  for (const [provider, model] of [
    ['anthropic', 'anthropic/claude-sonnet-4-20250514'],
    ['gemini', 'gemini/gemini-2.5-flash'],
  ] as const) {
    const body = await postAi(
      {
        logCall: async (row) => void loggedRows.push(row),
        fetchImpl: mockFetch,
        getEnv,
        routeOverrides: { 'carecircle.extractPrescription': { provider, model } },
      },
      { task: 'carecircle.extractPrescription', input: { imagePath: 'same-prompt.jpg' } },
    );
    assert(
      body.ok === true && body.output?.name === 'Metformin',
      `${provider} adapter must return schema-valid output for the test prompt`,
    );
  }

  assert(seenRequests.length === 2, 'both provider HTTP endpoints must be called');
  assert(
    seenRequests[0]?.url.includes('api.anthropic.com') &&
      seenRequests[0]?.authHeader === 'test-anthropic-secret-placeholder' &&
      seenRequests[0]?.bodyText.includes('same-prompt.jpg'),
    'anthropic adapter must send x-api-key and prompt input to api.anthropic.com',
  );
  assert(
    seenRequests[1]?.url.includes('generativelanguage.googleapis.com') &&
      seenRequests[1]?.authHeader === 'test-gemini-secret-placeholder' &&
      seenRequests[1]?.bodyText.includes('same-prompt.jpg'),
    'gemini adapter must send x-goog-api-key and prompt input to generativelanguage.googleapis.com',
  );
  assert(
    loggedRows.length === 2 &&
      loggedRows[0]?.input_tokens === 120 &&
      loggedRows[1]?.input_tokens === 110 &&
      !JSON.stringify(loggedRows).includes('same-prompt.jpg'),
    'both adapters must log token counts without logging prompt content',
  );

  // Missing API key secret must return PROVIDER_ERROR without making an HTTP call.
  const noKeyBody = await postAi({
    fetchImpl: mockFetch,
    getEnv: () => undefined,
    routeOverrides: { 'carecircle.extractPrescription': { provider: 'anthropic' } },
  });
  assert(
    noKeyBody.ok === false && noKeyBody.error?.code === 'PROVIDER_ERROR',
    'missing provider secret must return PROVIDER_ERROR',
  );
});

Deno.test(
  'live providers validate same prompt when ANTHROPIC_API_KEY and GEMINI_API_KEY are set',
  async () => {
    const canReadEnv =
      Deno.permissions.querySync({ name: 'env', variable: 'ANTHROPIC_API_KEY' }).state ===
        'granted' &&
      Deno.permissions.querySync({ name: 'env', variable: 'GEMINI_API_KEY' }).state === 'granted';
    const anthropicKey = canReadEnv ? Deno.env.get('ANTHROPIC_API_KEY') : undefined;
    const geminiKey = canReadEnv ? Deno.env.get('GEMINI_API_KEY') : undefined;
    if (!anthropicKey || !geminiKey) {
      console.info(
        'Skipping live provider test: set ANTHROPIC_API_KEY and GEMINI_API_KEY to run against live Claude and Gemini APIs.',
      );
      return;
    }

    const promptInput = {
      text: 'Doctor said blood pressure is stable. Stop Aspirin and book a blood test in two weeks.',
      knownMeds: [{ id: REQ_ID, name: 'Aspirin', strength: '81 mg' }],
    };

    for (const [provider, model] of [
      ['anthropic', 'anthropic/claude-sonnet-4-20250514'],
      ['gemini', 'gemini/gemini-2.5-flash'],
    ] as const) {
      const body = await postAi(
        { routeOverrides: { 'carecircle.summarizeVisit': { provider, model } } },
        { task: 'carecircle.summarizeVisit', input: promptInput },
      );
      assert(
        body.ok === true &&
          typeof body.output?.summary === 'string' &&
          body.output.summary.length > 0,
        `live ${provider} call must return schema-valid visit summary`,
      );
    }
  },
);

Deno.test(
  'rate limit: call 60 in an hour succeeds, call 61 returns QUOTA_EXCEEDED, other user unaffected',
  async () => {
    const clockNow = 1_760_000_000_000;
    const callHistory: Array<{ userId: string; createdAtMs: number }> = [];

    for (let i = 0; i < 5; i += 1) {
      callHistory.push({ userId: USER_A, createdAtMs: clockNow - 3_600_000 - (i + 1) * 1_000 });
    }
    for (let i = 0; i < 59; i += 1) {
      callHistory.push({ userId: USER_A, createdAtMs: clockNow - 60_000 + i * 100 });
    }

    let providerCalls = 0;
    const stubProvider: AiProvider = {
      generate: async (req) => {
        providerCalls += 1;
        return { output: FAKE_FIXTURES[req.task], inputTokens: 10, outputTokens: 10 };
      },
    };

    const depsForUser = (userId: string): ExtendedDeps => ({
      now: () => clockNow,
      verifyJwt: async () => ({ userId }),
      countRecentCalls: async (uid, sinceIso) => {
        const sinceMs = Date.parse(sinceIso);
        return callHistory.filter((entry) => entry.userId === uid && entry.createdAtMs >= sinceMs)
          .length;
      },
      logCall: async (row) => {
        callHistory.push({ userId: row.user_id, createdAtMs: clockNow });
      },
      providers: { fake: stubProvider, anthropic: stubProvider, gemini: stubProvider },
    });

    const call60 = await postAi(depsForUser(USER_A));
    assert(call60.ok === true && providerCalls === 1, 'call 60 within the hour must succeed');

    const call61 = await postAi(depsForUser(USER_A));
    assert(
      call61.ok === false &&
        call61.error?.code === 'QUOTA_EXCEEDED' &&
        call61.error?.retryable === false &&
        providerCalls === 1,
      `call 61 must return non-retryable QUOTA_EXCEEDED without calling provider, got ${JSON.stringify(call61)}`,
    );

    const otherUserCall = await postAi(depsForUser(USER_B));
    assert(
      otherUserCall.ok === true && providerCalls === 2,
      'another user must not be affected by USER_A quota',
    );

    // Also verify default server-side counter queries ai_calls with user_id and 1-hour window.
    let countQueryUrl = '';
    const defaultCounterBody = await postAi(
      {
        now: () => clockNow,
        getEnv: (k) => (k === 'SUPABASE_URL' ? 'http://supabase.local' : 'service-role-token'),
        fetchImpl: async (input) => {
          countQueryUrl = typeof input === 'string' ? input : input.toString();
          return new Response('[]', { status: 200, headers: { 'content-range': '0-59/60' } });
        },
        providers: { fake: stubProvider, anthropic: stubProvider, gemini: stubProvider },
      },
      { useDefaultCounter: true },
    );
    const expectedSince = encodeURIComponent(new Date(clockNow - 3_600_000).toISOString());
    assert(
      countQueryUrl.includes('/rest/v1/ai_calls') &&
        countQueryUrl.includes(`user_id=eq.${USER_A}`) &&
        countQueryUrl.includes(`created_at=gte.${expectedSince}`) &&
        defaultCounterBody.error?.code === 'QUOTA_EXCEEDED',
      `default counter must query ai_calls by user_id and 1-hour window, got URL ${countQueryUrl}`,
    );
  },
);

Deno.test(
  'timeout: aborts hanging provider via AbortController and returns retryable PROVIDER_ERROR',
  async () => {
    assert(
      routes['carecircle.extractPrescription'].timeoutMs === 25_000 &&
        routes['carecircle.summarizeVisit'].timeoutMs === 25_000,
      'routes must configure a 25,000 ms timeout',
    );

    let receivedSignal = false;
    let signalAborted = false;
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        if (init?.signal) {
          receivedSignal = true;
          init.signal.addEventListener('abort', () => {
            signalAborted = true;
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
      });

    const loggedRows: ExtendedLogRow[] = [];
    const deps: ExtendedDeps = {
      logCall: async (row) => void loggedRows.push(row),
      fetchImpl: hangingFetch,
      getEnv: () => 'test-provider-key',
      routeOverrides: {
        'carecircle.extractPrescription': { provider: 'anthropic', timeoutMs: 25 },
      },
    };

    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutGuard = new Promise<never>((_resolve, reject) => {
      fallbackTimer = setTimeout(
        () => reject(new Error('Handler did not abort hanging provider within 500 ms')),
        500,
      );
    });

    try {
      const body = await Promise.race([postAi(deps), timeoutGuard]);
      assert(receivedSignal && signalAborted, 'handler must pass AbortSignal and abort on timeout');
      assert(
        body.ok === false &&
          body.error?.code === 'PROVIDER_ERROR' &&
          body.error?.retryable === true,
        `timeout must return retryable PROVIDER_ERROR, got ${JSON.stringify(body)}`,
      );
      assert(
        loggedRows.length === 1 &&
          loggedRows[0]?.validation_ok === false &&
          loggedRows[0]?.error_code === 'PROVIDER_ERROR',
        'timeout must log PROVIDER_ERROR in ai_calls',
      );
    } finally {
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    }
  },
);

Deno.test(
  'cost logging: computes integer microcents from token counts with USD currency',
  async () => {
    const rxRoute = routes['carecircle.extractPrescription'] as PricedRoute;
    assert(
      typeof rxRoute.inputMicrocentsPer1k === 'number' &&
        Number.isInteger(rxRoute.inputMicrocentsPer1k) &&
        rxRoute.inputMicrocentsPer1k > 0 &&
        typeof rxRoute.outputMicrocentsPer1k === 'number' &&
        Number.isInteger(rxRoute.outputMicrocentsPer1k) &&
        rxRoute.outputMicrocentsPer1k > 0,
      'route must define positive integer inputMicrocentsPer1k and outputMicrocentsPer1k',
    );

    const inputMicrocentsPer1k = 15_250;
    const outputMicrocentsPer1k = 60_750;
    const inputTokens = 3;
    const outputTokens = 1;
    // 3 * 15,250 + 1 * 60,750 = 106,500 thousandths -> 106.5 -> rounds to 107 integer microcents.
    const expectedMicrocents = Math.floor(
      (inputTokens * inputMicrocentsPer1k + outputTokens * outputMicrocentsPer1k + 500) / 1_000,
    );

    const loggedRows: ExtendedLogRow[] = [];
    const stubProvider: AiProvider = {
      generate: async (req) => ({
        output: FAKE_FIXTURES[req.task],
        inputTokens,
        outputTokens,
      }),
    };

    const body = await postAi({
      logCall: async (row) => void loggedRows.push(row),
      providers: { fake: stubProvider, anthropic: stubProvider, gemini: stubProvider },
      routeOverrides: {
        'carecircle.extractPrescription': { inputMicrocentsPer1k, outputMicrocentsPer1k },
      },
    });

    assert(body.ok === true && loggedRows.length === 1, 'call should succeed and log one row');
    const row = loggedRows[0];
    assert(
      row?.input_tokens === inputTokens && row?.output_tokens === outputTokens,
      'logged row must record exact input_tokens and output_tokens',
    );
    assert(
      typeof row?.estimated_cost_microcents === 'number' &&
        Number.isInteger(row.estimated_cost_microcents) &&
        row.estimated_cost_microcents === expectedMicrocents &&
        row?.cost_currency === 'USD',
      `expected integer estimated_cost_microcents=${expectedMicrocents} USD, got ${row?.estimated_cost_microcents} ${row?.cost_currency}`,
    );
  },
);

const SECRET_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: 'Anthropic API key', regex: /sk-ant-[a-zA-Z0-9_-]{10,}/ },
  { name: 'Google/Gemini API key', regex: /AIza[0-9A-Za-z_-]{20,}/ },
  {
    name: 'Hardcoded provider key assignment',
    regex: /(?:ANTHROPIC_API_KEY|GEMINI_API_KEY)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/,
  },
];

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const utf16Decoder = new TextDecoder('utf-16le', { fatal: false });

function scanBytesForSecrets(bytes: Uint8Array): string[] {
  const text = `${utf8Decoder.decode(bytes)}\n${utf16Decoder.decode(bytes)}`;
  const hits: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(text)) hits.push(pattern.name);
  }
  return hits;
}

async function collectFiles(dir: string, out: string[] = []): Promise<string[]> {
  const ignoredDirs = new Set(['.git', 'node_modules', '.turbo', '.expo', 'coverage']);
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (!ignoredDirs.has(entry.name)) await collectFiles(fullPath, out);
    } else if (entry.isFile) {
      out.push(fullPath);
    }
  }
  return out;
}

Deno.test(
  'key search: detects planted fake keys and finds zero API keys in repo or bundle',
  async () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const plantedAnthropic = ['sk-ant', 'api03', 'PlantedFakeKeyForTest123456'].join('-');
    const plantedGemini = ['AIza', 'SyPlantedFakeGeminiKeyForTest123456'].join('');
    const plantedEnv = ['ANTHROPIC_API_KEY', '="planted_secret_value_1234567890"'].join('');
    const simulatedHbcBytes = new Uint8Array([
      0xc6,
      0x1f,
      0xbc,
      0x03,
      0xff,
      ...encode(plantedAnthropic),
      0x00,
    ]);

    assert(
      scanBytesForSecrets(encode(plantedAnthropic)).includes('Anthropic API key') &&
        scanBytesForSecrets(encode(plantedGemini)).includes('Google/Gemini API key') &&
        scanBytesForSecrets(encode(plantedEnv)).includes('Hardcoded provider key assignment') &&
        scanBytesForSecrets(simulatedHbcBytes).includes('Anthropic API key'),
      'scanner must detect planted keys in source and binary bundle formats',
    );

    const repoRoot = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
    const files = await collectFiles(repoRoot);
    assert(files.length > 10, 'expected to scan repository files');

    const findings: string[] = [];
    for (const filePath of files) {
      if (/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf)$/i.test(filePath)) continue;
      const bytes = await Deno.readFile(filePath).catch(() => new Uint8Array());
      for (const hit of scanBytesForSecrets(bytes)) {
        findings.push(`${filePath}: ${hit}`);
      }
    }

    assert(findings.length === 0, `Found potential API keys:\n${findings.join('\n')}`);
  },
);
