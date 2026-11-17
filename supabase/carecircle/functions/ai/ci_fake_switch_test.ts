import { createAiGatewayHandler } from './handler.ts';
import { FAKE_FIXTURES, type AiProvider } from './routes.ts';

const RX_IMAGE_PATH =
  'cc4ac001-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.jpg';
const REQ_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function runWithEnv(env: Record<string, string | undefined>): Promise<string> {
  let calledProvider = 'none';
  const makeStub = (name: string): AiProvider => ({
    generate: async (req) => {
      calledProvider = name;
      return { output: FAKE_FIXTURES[req.task], inputTokens: 10, outputTokens: 10 };
    },
  });

  const handler = createAiGatewayHandler({
    verifyJwt: async () => ({ userId: USER_ID }),
    countRecentCalls: async () => 0,
    logCall: async () => {},
    checkPrescriptionCircleAccess: async () => true,
    readPrescriptionPhoto: async () => ({
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      contentType: 'image/jpeg',
    }),
    getEnv: (key) => env[key],
    providers: {
      fake: makeStub('fake'),
      gemini: makeStub('gemini'),
      anthropic: makeStub('anthropic'),
    },
  });

  const res = await handler(
    new Request('http://localhost/functions/v1/ai', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-jwt',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        task: 'carecircle.extractPrescription',
        input: { imagePath: RX_IMAGE_PATH },
        requestId: REQ_ID,
      }),
    }),
  );
  const body = (await res.json()) as { ok: boolean };
  assert(body.ok === true, `expected ok: true, got ${JSON.stringify(body)}`);
  return calledProvider;
}

Deno.test(
  'CARECIRCLE_CI_FAKE_AI switch: turns on ONLY when CARECIRCLE_CI_FAKE_AI=1 AND SUPABASE_URL is http://kong:8000 or http://127.0.0.1:54321',
  async () => {
    for (const localUrl of [
      'http://kong:8000',
      'http://kong:8000/',
      'http://127.0.0.1:54321',
      'http://127.0.0.1:54321/',
    ]) {
      const used = await runWithEnv({
        CARECIRCLE_CI_FAKE_AI: '1',
        SUPABASE_URL: localUrl,
      });
      assert(
        used === 'fake',
        `expected fake provider for ${localUrl} + CARECIRCLE_CI_FAKE_AI=1, got ${used}`,
      );
    }
  },
);

Deno.test(
  'CARECIRCLE_CI_FAKE_AI switch: stays OFF when only one variable is set or when SUPABASE_URL is a hosted https://<ref>.supabase.co URL',
  async () => {
    const offCases: Array<[string, Record<string, string | undefined>]> = [
      ['only CARECIRCLE_CI_FAKE_AI=1 (no SUPABASE_URL)', { CARECIRCLE_CI_FAKE_AI: '1' }],
      [
        'only SUPABASE_URL=http://kong:8000 (no CARECIRCLE_CI_FAKE_AI)',
        { SUPABASE_URL: 'http://kong:8000' },
      ],
      [
        'CARECIRCLE_CI_FAKE_AI=true instead of 1',
        { CARECIRCLE_CI_FAKE_AI: 'true', SUPABASE_URL: 'http://kong:8000' },
      ],
      [
        'CARECIRCLE_CI_FAKE_AI=0',
        { CARECIRCLE_CI_FAKE_AI: '0', SUPABASE_URL: 'http://127.0.0.1:54321' },
      ],
      [
        'hosted https://<ref>.supabase.co URL with CARECIRCLE_CI_FAKE_AI=1',
        {
          CARECIRCLE_CI_FAKE_AI: '1',
          SUPABASE_URL: 'https://jsnwxprllkeipeachfjx.supabase.co',
        },
      ],
      [
        'custom https domain with CARECIRCLE_CI_FAKE_AI=1',
        {
          CARECIRCLE_CI_FAKE_AI: '1',
          SUPABASE_URL: 'https://api.carecircle.example.com',
        },
      ],
    ];

    for (const [label, env] of offCases) {
      const used = await runWithEnv(env);
      assert(
        used === 'gemini',
        `${label}: expected real gemini route provider (never fake), got ${used}`,
      );
    }
  },
);
