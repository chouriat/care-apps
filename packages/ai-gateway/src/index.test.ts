import { z } from 'zod';
import { AI_GATEWAY_PATH, createAiGatewayClient } from './index';

const REQ_ID = '22222222-2222-4222-8222-222222222222';
const outputSchema = z.object({ name: z.string(), doseText: z.string() });
const sampleReq = { task: 'carecircle.extractPrescription' as const, input: {}, requestId: REQ_ID };

const makeClient = (token: string | null, responseJson: unknown = {}, status = 200) =>
  createAiGatewayClient({
    baseUrl: 'https://example.supabase.co',
    getAccessToken: () => token,
    fetchImpl: async () => ({ status, json: async () => responseJson }),
  });

describe('ai-gateway client', () => {
  it('points to /functions/v1/ai and validates typed success envelopes', async () => {
    expect(AI_GATEWAY_PATH).toBe('/functions/v1/ai');
    const out = { name: 'Metformin', doseText: '1 tablet' };
    const payload = { ok: true, output: out, model: 'fake/extract-prescription-v1', latencyMs: 42 };
    expect(await makeClient('jwt-token', payload).call(sampleReq, outputSchema)).toEqual(payload);
  });

  it('returns UNAUTHENTICATED without token and SCHEMA_INVALID on malformed output', async () => {
    const unauth = { code: 'UNAUTHENTICATED', retryable: false };
    const invalid = { code: 'SCHEMA_INVALID', retryable: false };
    expect(await makeClient(null).call(sampleReq, outputSchema)).toEqual({
      ok: false,
      error: expect.objectContaining(unauth),
    });
    const bad = { ok: true, output: { bad: 1 }, model: 'fake/v1', latencyMs: 5 };
    expect(await makeClient('jwt-token', bad).call(sampleReq, outputSchema)).toEqual({
      ok: false,
      error: expect.objectContaining(invalid),
    });
  });

  it('maps a 401 from the Supabase gateway to UNAUTHENTICATED and a 5xx to PROVIDER_ERROR', async () => {
    const gateway401 = { code: 401, message: 'Invalid JWT' };
    const r401 = await makeClient('expired', gateway401, 401).call(sampleReq, outputSchema);
    expect(r401).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'UNAUTHENTICATED' }),
    });
    const r502 = await makeClient('jwt-token', null, 502).call(sampleReq, outputSchema);
    expect(r502).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'PROVIDER_ERROR', retryable: true }),
    });
  });
});
