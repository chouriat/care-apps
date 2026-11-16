import { createAiGatewayHandler, type AiCallLogRow, type AiGatewayDeps } from './handler.ts';
import { FAKE_FIXTURES, visitSchema, type AiProvider, type AiProviderRequest } from './routes.ts';
import type { CircleOwnerLookupStore, EntitlementRow } from '../_shared/entitlements.ts';

const CIRCLE_A = 'cc5ac001-0000-4000-8000-000000000001';
const CIRCLE_B = 'cc5ac002-0000-4000-8000-000000000002';

const OWNER_A = 'cc5a0001-0000-4000-8000-000000000001';
const HELPER_A = 'cc5a0002-0000-4000-8000-000000000002';
const VIEWER_A = 'cc5a0003-0000-4000-8000-000000000003';
const OWNER_B = 'cc5a0004-0000-4000-8000-000000000004';
const OUTSIDER = 'cc5a0005-0000-4000-8000-000000000005';

const MED_A1 = 'c1200001-0000-4000-8000-000000000001';
const MED_A2 = 'c1200002-0000-4000-8000-000000000002';
const MED_B1 = 'c2200001-0000-4000-8000-000000000001';

const AUDIO_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUDIO_PATH_A = `${CIRCLE_A}/${AUDIO_UUID}.m4a`;
const AUDIO_PATH_B = `${CIRCLE_B}/${AUDIO_UUID}.m4a`;
const REQ_ID = '55555555-5555-4555-8555-555555555555';

const SAMPLE_AUDIO_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

interface FakeVisitEnvOptions {
  callerId?: string;
  circleAPlan?: 'family' | 'free' | 'expired';
  circleBPlan?: 'family' | 'free';
  sttTranscript?: string;
  sttFails?: boolean;
  summaryFails?: boolean;
  audioBytes?: Uint8Array | null;
  audioContentType?: string;
}

function createFakeVisitEnv(opts: FakeVisitEnvOptions = {}) {
  const callerId = opts.callerId ?? OWNER_A;
  const circleAPlan = opts.circleAPlan ?? 'family';
  const circleBPlan = opts.circleBPlan ?? 'family';
  const sttTranscript =
    opts.sttTranscript ??
    'Doctor said blood pressure is stable. Book a blood test in two weeks and stop Aspirin.';

  const events: string[] = [];
  const deletedAudioPaths: string[] = [];
  const sttRequests: AiProviderRequest[] = [];
  const summaryRequests: AiProviderRequest[] = [];
  const aiCalls: AiCallLogRow[] = [];

  const members = [
    { circle_id: CIRCLE_A, user_id: OWNER_A, role: 'owner' as const },
    { circle_id: CIRCLE_A, user_id: HELPER_A, role: 'helper' as const },
    { circle_id: CIRCLE_A, user_id: VIEWER_A, role: 'viewer' as const },
    { circle_id: CIRCLE_B, user_id: OWNER_B, role: 'owner' as const },
  ];

  const medsByCircle: Record<string, string[]> = {
    [CIRCLE_A]: [MED_A1, MED_A2],
    [CIRCLE_B]: [MED_B1],
  };

  const entitlementStore: CircleOwnerLookupStore = {
    async getCircleOwnerUserId(circleId: string) {
      events.push(`ownerLookup:${circleId}`);
      const owner = members.find((m) => m.circle_id === circleId && m.role === 'owner');
      return { data: owner?.user_id ?? null, error: null };
    },
    async getEntitlement(userId: string) {
      events.push(`entitlement:${userId}`);
      const plan =
        userId === OWNER_A ? circleAPlan : userId === OWNER_B ? circleBPlan : ('free' as const);
      if (plan === 'free') {
        return { data: null, error: null };
      }
      const row: EntitlementRow = {
        user_id: userId,
        entitlement: 'carecircle_family',
        active: true,
        expires_at: plan === 'expired' ? '2026-01-01T00:00:00.000Z' : '2027-01-01T00:00:00.000Z',
      };
      return { data: row, error: null };
    },
  };

  const geminiProvider: AiProvider = {
    generate: async (req) => {
      events.push('provider:gemini');
      sttRequests.push(req);
      if (opts.sttFails) {
        throw new Error('STT provider failure');
      }
      return {
        output: { transcript: sttTranscript },
        inputTokens: 120,
        outputTokens: 45,
      };
    },
  };

  const anthropicProvider: AiProvider = {
    generate: async (req) => {
      events.push('provider:anthropic');
      summaryRequests.push(req);
      if (opts.summaryFails) {
        throw new Error('Summary provider failure');
      }
      return {
        output: FAKE_FIXTURES['carecircle.summarizeVisit'],
        inputTokens: 210,
        outputTokens: 95,
      };
    },
  };

  const handler = createAiGatewayHandler({
    verifyJwt: async () => ({ userId: callerId }),
    countRecentCalls: async () => 0,
    logCall: async (row) => {
      aiCalls.push(row);
    },
    now: () => Date.parse('2026-11-16T12:00:00.000Z'),
    checkPrescriptionCircleAccess: async ({ userId, circleId }) => {
      events.push(`access:${circleId}:${userId}`);
      return members.some(
        (m) =>
          m.circle_id === circleId &&
          m.user_id === userId &&
          (m.role === 'owner' || m.role === 'helper'),
      );
    },
    checkCircleMedicationIds: async ({ circleId, medicationIds }) => {
      events.push(`meds:${circleId}:${medicationIds.join(',')}`);
      const allowed = new Set(medsByCircle[circleId] ?? []);
      return medicationIds.every((id) => allowed.has(id));
    },
    entitlementStore,
    readVisitAudio: async ({ audioPath }) => {
      events.push(`audio:read:${audioPath}`);
      if (opts.audioBytes === null) return null;
      return {
        bytes: opts.audioBytes ?? SAMPLE_AUDIO_BYTES,
        contentType: opts.audioContentType ?? 'audio/m4a',
      };
    },
    deleteVisitAudio: async ({ audioPath }) => {
      events.push(`audio:delete:${audioPath}`);
      deletedAudioPaths.push(audioPath);
    },
    providers: {
      gemini: geminiProvider,
      anthropic: anthropicProvider,
    },
  } as AiGatewayDeps);

  const callSummarizeVisit = async (input: Record<string, unknown>) => {
    const res = await handler(
      new Request('http://localhost/functions/v1/ai', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-jwt',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          task: 'carecircle.summarizeVisit',
          input,
          requestId: REQ_ID,
        }),
      }),
    );
    const body = (await res.json()) as {
      ok: boolean;
      output?: unknown;
      error?: { code: string; message: string; retryable: boolean };
    };
    return { status: res.status, body };
  };

  return {
    callSummarizeVisit,
    events,
    deletedAudioPaths,
    sttRequests,
    summaryRequests,
    aiCalls,
  };
}

Deno.test(
  'CC-5a: text and audio inputs both return a schema-valid draft; summary provider receives only the transcript (never audio) and audio is deleted after success',
  async () => {
    const knownMeds = [{ id: MED_A1, name: 'Aspirin', strength: '81 mg' }];

    // 1. Typed text input (by helper in a Family-plan circle)
    const textEnv = createFakeVisitEnv({ callerId: HELPER_A, circleAPlan: 'family' });
    const textRes = await textEnv.callSummarizeVisit({
      circleId: CIRCLE_A,
      text: 'Doctor said blood pressure is stable and stop Aspirin.',
      knownMeds,
    });
    assert(
      textRes.body.ok === true,
      `expected ok: true for text, got ${JSON.stringify(textRes.body)}`,
    );
    assert(
      visitSchema.safeParse(textRes.body.output).success,
      'text output validates against visitSchema',
    );
    assert(textEnv.sttRequests.length === 0, 'text input does not call speech-to-text');
    assert(textEnv.summaryRequests.length === 1, 'text input calls summary provider once');

    // 2. Recorded audio input: speech-to-text first, then summary (which sees only transcript, never audio)
    const customTranscript =
      'Unique-spoken-transcript-marker-98765: stop Aspirin, book blood test.';
    const audioEnv = createFakeVisitEnv({
      callerId: OWNER_A,
      circleAPlan: 'family',
      sttTranscript: customTranscript,
    });
    const audioRes = await audioEnv.callSummarizeVisit({
      circleId: CIRCLE_A,
      audioPath: AUDIO_PATH_A,
      knownMeds,
    });
    assert(
      audioRes.body.ok === true,
      `expected ok: true for audio, got ${JSON.stringify(audioRes.body)}`,
    );
    assert(
      visitSchema.safeParse(audioRes.body.output).success,
      'audio output validates against visitSchema',
    );
    assert(audioEnv.sttRequests.length === 1, 'speech-to-text provider called once');
    assert(
      audioEnv.sttRequests[0]!.audio?.mimeType === 'audio/m4a' &&
        audioEnv.sttRequests[0]!.audio.bytes.byteLength === SAMPLE_AUDIO_BYTES.byteLength,
      'speech-to-text provider receives audio bytes',
    );
    assert(audioEnv.summaryRequests.length === 1, 'summary provider called once');
    const summaryReq = audioEnv.summaryRequests[0]!;
    assert(summaryReq.audio === undefined, 'summary provider must NEVER receive audio bytes');
    assert(
      summaryReq.input.audioPath === undefined,
      'summary provider input must not contain audioPath',
    );
    assert(
      summaryReq.input.text === customTranscript,
      `summary provider must receive the transcribed text, got ${JSON.stringify(summaryReq.input)}`,
    );
    assert(
      JSON.stringify(audioEnv.deletedAudioPaths) === JSON.stringify([AUDIO_PATH_A]),
      'visit audio object is deleted after successful transcription',
    );

    // Nothing from the transcript or summary appears in ai_calls
    assert(audioEnv.aiCalls.length === 1, 'one ai_calls row logged');
    const serializedLog = JSON.stringify(audioEnv.aiCalls[0]);
    assert(
      !serializedLog.includes(customTranscript) &&
        !serializedLog.includes('Unique-spoken-transcript-marker-98765') &&
        !serializedLog.includes('Blood pressure is stable'),
      'nothing from transcript or summary appears in ai_calls',
    );
  },
);

Deno.test(
  'CC-5a: free or expired plan returns QUOTA_EXCEEDED before reading audio or calling any provider',
  async () => {
    for (const plan of ['free', 'expired'] as const) {
      const env = createFakeVisitEnv({ callerId: OWNER_A, circleAPlan: plan });
      const res = await env.callSummarizeVisit({
        circleId: CIRCLE_A,
        audioPath: AUDIO_PATH_A,
        knownMeds: [{ id: MED_A1, name: 'Aspirin', strength: '81 mg' }],
      });
      assert(
        res.body.ok === false && res.body.error?.code === 'QUOTA_EXCEEDED',
        `expected QUOTA_EXCEEDED for ${plan} circle, got ${JSON.stringify(res.body)}`,
      );
      assert(
        !env.events.some((e) => e.startsWith('audio:read') || e.startsWith('provider:')),
        `${plan} circle must not read audio or call any provider, got ${env.events.join(', ')}`,
      );
    }
  },
);

Deno.test(
  'CC-5a: viewer, non-member, another circle owner, missing circleId with text, circleId mismatch with audioPath, and foreign knownMeds id all return INPUT_INVALID',
  async () => {
    const knownMeds = [{ id: MED_A1, name: 'Aspirin', strength: '81 mg' }];

    // 1. Viewer of Circle A
    const viewerEnv = createFakeVisitEnv({ callerId: VIEWER_A, circleAPlan: 'family' });
    const viewerRes = await viewerEnv.callSummarizeVisit({
      circleId: CIRCLE_A,
      text: 'Doctor visit note',
      knownMeds,
    });
    assert(
      viewerRes.body.ok === false && viewerRes.body.error?.code === 'INPUT_INVALID',
      `viewer must get INPUT_INVALID, got ${JSON.stringify(viewerRes.body)}`,
    );
    assert(viewerEnv.summaryRequests.length === 0, 'viewer calls no provider');

    // 2. Non-member (outsider)
    const outsiderEnv = createFakeVisitEnv({ callerId: OUTSIDER, circleAPlan: 'family' });
    const outsiderRes = await outsiderEnv.callSummarizeVisit({
      circleId: CIRCLE_A,
      text: 'Doctor visit note',
      knownMeds,
    });
    assert(
      outsiderRes.body.ok === false && outsiderRes.body.error?.code === 'INPUT_INVALID',
      `non-member must get INPUT_INVALID, got ${JSON.stringify(outsiderRes.body)}`,
    );

    // 3. Audio from another circle's path (Circle A owner trying to read Circle B's audioPath)
    const crossAudioEnv = createFakeVisitEnv({ callerId: OWNER_A, circleAPlan: 'family' });
    const crossAudioRes = await crossAudioEnv.callSummarizeVisit({
      audioPath: AUDIO_PATH_B,
      knownMeds: [],
    });
    assert(
      crossAudioRes.body.ok === false && crossAudioRes.body.error?.code === 'INPUT_INVALID',
      `audio from another circle must be refused with INPUT_INVALID, got ${JSON.stringify(crossAudioRes.body)}`,
    );
    assert(
      !crossAudioEnv.events.some((e) => e.startsWith('audio:read')),
      'other circle audio is never read from Storage',
    );

    // 4. circleId does not match the circle in audioPath
    const mismatchEnv = createFakeVisitEnv({ callerId: OWNER_A, circleAPlan: 'family' });
    const mismatchRes = await mismatchEnv.callSummarizeVisit({
      circleId: CIRCLE_B,
      audioPath: AUDIO_PATH_A,
      knownMeds: [],
    });
    assert(
      mismatchRes.body.ok === false && mismatchRes.body.error?.code === 'INPUT_INVALID',
      `circleId mismatch with audioPath must return INPUT_INVALID, got ${JSON.stringify(mismatchRes.body)}`,
    );

    // 5. Missing circleId when only text is provided
    const missingCircleEnv = createFakeVisitEnv({ callerId: OWNER_A, circleAPlan: 'family' });
    const missingCircleRes = await missingCircleEnv.callSummarizeVisit({
      text: 'Typed visit note without circleId',
      knownMeds: [],
    });
    assert(
      missingCircleRes.body.ok === false && missingCircleRes.body.error?.code === 'INPUT_INVALID',
      `missing circleId with text must return INPUT_INVALID, got ${JSON.stringify(missingCircleRes.body)}`,
    );

    // 6. Foreign knownMeds id (MED_B1 belongs to Circle B, not Circle A)
    const foreignMedEnv = createFakeVisitEnv({ callerId: OWNER_A, circleAPlan: 'family' });
    const foreignMedRes = await foreignMedEnv.callSummarizeVisit({
      circleId: CIRCLE_A,
      text: 'Doctor visit note',
      knownMeds: [{ id: MED_B1, name: 'Other Circle Med', strength: '10 mg' }],
    });
    assert(
      foreignMedRes.body.ok === false && foreignMedRes.body.error?.code === 'INPUT_INVALID',
      `foreign knownMeds id must return INPUT_INVALID, got ${JSON.stringify(foreignMedRes.body)}`,
    );
    assert(foreignMedEnv.summaryRequests.length === 0, 'foreign knownMeds calls no provider');
  },
);

Deno.test('CC-5a: visit audio object is deleted even when transcription fails', async () => {
  const failEnv = createFakeVisitEnv({
    callerId: OWNER_A,
    circleAPlan: 'family',
    sttFails: true,
  });
  const res = await failEnv.callSummarizeVisit({
    circleId: CIRCLE_A,
    audioPath: AUDIO_PATH_A,
    knownMeds: [],
  });
  assert(
    res.body.ok === false && res.body.error?.code === 'PROVIDER_ERROR',
    `expected PROVIDER_ERROR when transcription fails, got ${JSON.stringify(res.body)}`,
  );
  assert(
    JSON.stringify(failEnv.deletedAudioPaths) === JSON.stringify([AUDIO_PATH_A]),
    'visit audio object is still deleted when transcription fails',
  );
  assert(
    failEnv.summaryRequests.length === 0,
    'summary provider is not called when transcription fails',
  );
});
