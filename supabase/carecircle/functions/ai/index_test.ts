import {
  createAiGatewayHandler as createRealAiGatewayHandler,
  type AiCallLogRow,
  type AiGatewayDeps,
} from './handler.ts';
import { FAKE_FIXTURES, type AiProvider, type AiTaskName } from './routes.ts';

// CC-4a: extractPrescription now checks circle access and reads the photo from Storage before calling a
// provider (tests in rx_storage_auth_test.ts). These older tests are about routing, logging and providers,
// so by default they run with an allowed caller and a small JPEG; a test can still pass its own hooks.
const RX_IMAGE_PATH =
  'cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg';
const createAiGatewayHandler = (deps: AiGatewayDeps = {}) =>
  createRealAiGatewayHandler({
    checkPrescriptionCircleAccess: async () => true,
    readPrescriptionPhoto: async () => ({
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      contentType: 'image/jpeg',
    }),
    ...deps,
  } as AiGatewayDeps);

const USER_ID = '11111111-1111-4111-8111-111111111111';
const REQ_ID = '22222222-2222-4222-8222-222222222222';
const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
};

type TestEnvelope = Record<'ok', boolean> &
  Partial<Record<'model', string> & Record<'latencyMs', number>> & {
    output?: { name?: string };
    error?: Record<'code', string> & { retryable: boolean };
  };

const sequenceProvider = (outputs: unknown[], attempts: number[]): AiProvider => ({
  generate: async (req) => {
    attempts.push(req.attempt);
    return { output: outputs[req.attempt - 1] ?? outputs[0], inputTokens: 10, outputTokens: 15 };
  },
});

const FAKE_ROUTE_OVERRIDES = {
  'carecircle.extractPrescription': {
    provider: 'fake' as const,
    model: 'fake/extract-prescription-v1',
  },
  'carecircle.summarizeVisit': {
    provider: 'fake' as const,
    model: 'fake/summarize-visit-v1',
  },
};

async function invoke(opts: {
  task?: AiTaskName;
  input?: Record<string, unknown>;
  token?: string;
  outputs?: unknown[];
  verifyJwt?: (token: string) => Promise<{ userId: string } | null>;
  logCall?: (row: AiCallLogRow) => Promise<void>;
}) {
  const aiCalls: AiCallLogRow[] = [];
  const attempts: number[] = [];
  const providers = opts.outputs ? { fake: sequenceProvider(opts.outputs, attempts) } : undefined;
  const deps = {
    verifyJwt: opts.verifyJwt ?? (async () => ({ userId: USER_ID })),
    logCall: opts.logCall ?? (async (row: AiCallLogRow) => void aiCalls.push(row)),
    providers,
    routeOverrides: FAKE_ROUTE_OVERRIDES,
    // F-2b adds a per-user quota check; these tests are about the fake provider, not quota.
    countRecentCalls: async () => 0,
  };
  const handler = createAiGatewayHandler(deps as AiGatewayDeps);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const task = opts.task ?? 'carecircle.extractPrescription';
  const input = opts.input ?? { imagePath: RX_IMAGE_PATH };
  const body = JSON.stringify({ task, input, requestId: REQ_ID });
  const req = new Request('http://localhost/functions/v1/ai', { method: 'POST', headers, body });
  const res = await handler(req);
  return { body: (await res.json()) as TestEnvelope, aiCalls, attempts };
}

Deno.test('valid fake output returns ok: true and logs row in ai_calls', async () => {
  const { body, aiCalls } = await invoke({ input: { imagePath: RX_IMAGE_PATH }, token: 'jwt' });
  assert(body.ok === true && body.output?.name === 'Metformin', 'expected valid fake output');
  assert(body.model === 'fake/extract-prescription-v1' && typeof body.latencyMs === 'number', 'ok');
  assert(aiCalls.length === 1 && aiCalls[0].validation_ok === true, 'logged 1 valid ai_calls row');
  const loggedJson = JSON.stringify(aiCalls[0]);
  assert(!loggedJson.includes(RX_IMAGE_PATH) && !loggedJson.includes('Metformin'), 'no content');
});

Deno.test('invalid output once retries once and returns ok: true', async () => {
  const valid = FAKE_FIXTURES['carecircle.extractPrescription'];
  const { body, aiCalls, attempts } = await invoke({ token: 'jwt', outputs: [{ bad: 1 }, valid] });
  assert(body.ok === true && attempts.length === 2 && aiCalls.length === 1, 'retry succeeded');
});

Deno.test('invalid output twice returns SCHEMA_INVALID and logs failure', async () => {
  const task = 'carecircle.summarizeVisit' as const;
  const outputs = [{ wrongShape: 1 }, { wrongShape: 2 }];
  const { body, aiCalls, attempts } = await invoke({
    task,
    input: { text: 'Private visit transcript' },
    token: 'jwt',
    outputs,
  });
  assert(body.ok === false && body.error?.code === 'SCHEMA_INVALID', 'SCHEMA_INVALID');
  assert(body.error?.retryable === false && attempts.length === 2, 'retried once');
  assert(aiCalls.length === 1 && aiCalls[0].error_code === 'SCHEMA_INVALID', 'logged failure');
  assert(!JSON.stringify(aiCalls[0]).includes('Private visit transcript'), 'no input text logged');
});

Deno.test('no JWT returns UNAUTHENTICATED', async () => {
  const { body, aiCalls } = await invoke({});
  assert(!body.ok && body.error?.code === 'UNAUTHENTICATED' && aiCalls.length === 0, '401');
});

Deno.test(
  'a token the auth server rejects returns UNAUTHENTICATED and calls no provider',
  async () => {
    const verifyJwt = async (token: string) => (token === 'good' ? { userId: USER_ID } : null);
    const { body, aiCalls, attempts } = await invoke({
      token: 'expired',
      verifyJwt,
      outputs: [{}],
    });
    assert(!body.ok && body.error?.code === 'UNAUTHENTICATED', 'rejected token');
    assert(aiCalls.length === 0 && attempts.length === 0, 'no provider call, no log row');
  },
);

Deno.test('a failed ai_calls insert does not turn a success into an error', async () => {
  const logCall = () => Promise.reject(new Error('db down'));
  const { body } = await invoke({ token: 'jwt', logCall });
  assert(body.ok === true, 'still ok: true');
});
