import { FAKE_SUMMARIZE_VISIT_OUTPUT } from '@carecircle/ai-gateway';
import {
  AAC_M4A_RECORDING_OPTIONS,
  MAX_VISIT_AUDIO_BYTES,
  MAX_VISIT_RECORDING_MS,
  VISIT_AUDIO_BUCKET,
  VisitAudioPermissionError,
  buildVisitAudioPath,
  startVisitAudioRecording,
  summarizeVisit,
  uploadVisitAudio,
  type CapturedVisitRecording,
  type VisitAudioRecorderModules,
  type VisitStorageSupabaseLike,
} from './features/visit';

const CIRCLE_ID = 'c1c00001-0000-4000-8000-000000000001';
const AUDIO_ID = '11111111-1111-4111-8111-111111111111';
const MED_ID = 'c1200001-0000-4000-8000-000000000001';
const REQ_ID = '22222222-2222-4222-8222-222222222222';

describe('CC-5a Visit audio recorder, Storage upload, and AI gateway client', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('configures AAC in .m4a and automatically stops recording at 10 minutes (600,000 ms)', async () => {
    jest.useFakeTimers();

    expect(MAX_VISIT_RECORDING_MS).toBe(600_000);
    expect(AAC_M4A_RECORDING_OPTIONS.extension).toBe('.m4a');
    expect(AAC_M4A_RECORDING_OPTIONS.android.audioEncoder).toBe('aac');
    expect(AAC_M4A_RECORDING_OPTIONS.android.outputFormat).toBe('mpeg4');

    let nativeStoppedCount = 0;
    const deletedLocalUris: string[] = [];
    const sampleBytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

    const modules: VisitAudioRecorderModules = {
      requestPermission: async () => true,
      startNativeRecording: async () => ({
        stopAndGetFile: async () => {
          nativeStoppedCount += 1;
          return {
            uri: 'file:///cache/visit-recording.m4a',
            durationMs: 600_000,
          };
        },
      }),
      readBytes: async () => sampleBytes,
      deleteLocal: (uri) => {
        deletedLocalUris.push(uri);
      },
    };

    const autoStoppedEvents: CapturedVisitRecording[] = [];
    const session = await startVisitAudioRecording({
      modules,
      onAutoStop: (rec) => autoStoppedEvents.push(rec),
    });

    // At 9m59s, still recording
    jest.advanceTimersByTime(599_000);
    expect(nativeStoppedCount).toBe(0);

    // At 10m00s, stops by itself
    jest.advanceTimersByTime(1_000);
    const result = await session.stop();

    expect(nativeStoppedCount).toBe(1);
    expect(result.autoStopped).toBe(true);
    expect(result.durationMs).toBe(600_000);
    expect(result.contentType).toBe('audio/m4a');
    expect(autoStoppedEvents).toHaveLength(1);
  });

  it('uploads AAC .m4a to visit-audio/{circleId}/{uuid}.m4a and deletes the local file after upload (and on upload failure)', async () => {
    const uploadedCalls: Array<{
      bucket: string;
      path: string;
      size: number;
      contentType: string;
    }> = [];
    const deletedLocalUris: string[] = [];
    const sampleBytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

    const modules: VisitAudioRecorderModules = {
      requestPermission: async () => true,
      startNativeRecording: async () => ({
        stopAndGetFile: async () => ({
          uri: 'file:///cache/visit-local-1.m4a',
          durationMs: 42_000,
        }),
      }),
      readBytes: async () => sampleBytes,
      deleteLocal: (uri) => {
        deletedLocalUris.push(uri);
      },
    };

    const fakeSupabase: VisitStorageSupabaseLike = {
      storage: {
        from: (bucket) => ({
          upload: async (path, body, options) => {
            uploadedCalls.push({
              bucket,
              path,
              size: body.byteLength,
              contentType: options.contentType,
            });
            return { data: { path }, error: null };
          },
          remove: async () => ({ data: [], error: null }),
        }),
      },
    };

    const session = await startVisitAudioRecording({ modules });
    const uploaded = await session.uploadAndDeleteLocal({
      supabase: fakeSupabase,
      circleId: CIRCLE_ID,
      audioId: AUDIO_ID,
    });

    expect(uploaded.audioPath).toBe(`${CIRCLE_ID}/${AUDIO_ID}.m4a`);
    expect(uploaded.autoStopped).toBe(false);
    expect(uploadedCalls).toEqual([
      {
        bucket: VISIT_AUDIO_BUCKET,
        path: `${CIRCLE_ID}/${AUDIO_ID}.m4a`,
        size: sampleBytes.byteLength,
        contentType: 'audio/m4a',
      },
    ]);
    expect(deletedLocalUris).toEqual(['file:///cache/visit-local-1.m4a']);

    // Also deletes the local file if Storage upload fails
    const failingSupabase: VisitStorageSupabaseLike = {
      storage: {
        from: () => ({
          upload: async () => ({ data: null, error: { message: 'Storage offline' } }),
          remove: async () => ({ data: [], error: null }),
        }),
      },
    };
    const session2 = await startVisitAudioRecording({ modules });
    await expect(
      session2.uploadAndDeleteLocal({
        supabase: failingSupabase,
        circleId: CIRCLE_ID,
        audioId: AUDIO_ID,
      }),
    ).rejects.toThrow('Storage offline');
    expect(deletedLocalUris).toHaveLength(2);
  });

  it('rejects microphone permission denial, oversized >10 MB audio, and invalid paths', async () => {
    await expect(
      startVisitAudioRecording({
        modules: {
          requestPermission: async () => false,
          startNativeRecording: async () => {
            throw new Error('should not start');
          },
          readBytes: async () => new Uint8Array(),
          deleteLocal: () => undefined,
        },
      }),
    ).rejects.toBeInstanceOf(VisitAudioPermissionError);

    expect(() => buildVisitAudioPath('not-a-uuid', AUDIO_ID)).toThrow();

    const dummySupabase: VisitStorageSupabaseLike = {
      storage: {
        from: () => ({
          upload: async (path) => ({ data: { path }, error: null }),
          remove: async () => ({ data: [], error: null }),
        }),
      },
    };

    await expect(
      uploadVisitAudio({
        supabase: dummySupabase,
        circleId: CIRCLE_ID,
        audioId: AUDIO_ID,
        bytes: new Uint8Array(MAX_VISIT_AUDIO_BYTES + 1),
      }),
    ).rejects.toThrow(/10 MB/);
  });

  it('calls the AI gateway through packages/ai-gateway/client.ts for both text and uploaded audio', async () => {
    const gatewayRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const removedPaths: string[] = [];
    const deletedLocal: string[] = [];

    const fakeSupabase: VisitStorageSupabaseLike = {
      storage: {
        from: () => ({
          upload: async (path) => ({ data: { path }, error: null }),
          remove: async (paths) => {
            removedPaths.push(...paths);
            return { data: paths.map((name) => ({ name })), error: null };
          },
        }),
      },
    };

    const fetchImpl = async (
      url: string,
      init: { method: string; body: string; headers: Record<string, string> },
    ) => {
      gatewayRequests.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return {
        status: 200,
        json: async () => ({
          ok: true,
          output: FAKE_SUMMARIZE_VISIT_OUTPUT,
          model: 'anthropic/claude-sonnet-5-5',
          latencyMs: 320,
        }),
      };
    };

    // 1. Text call
    const textRes = await summarizeVisit(
      {
        circleId: CIRCLE_ID,
        text: 'Doctor said blood pressure is stable.',
        knownMeds: [{ id: MED_ID, name: 'Aspirin', strength: '81 mg' }],
      },
      {
        supabase: fakeSupabase,
        baseUrl: 'https://example.supabase.co',
        getAccessToken: () => 'jwt-token',
        fetchImpl,
        requestId: REQ_ID,
      },
    );

    expect(textRes.ok).toBe(true);
    expect(gatewayRequests[0]?.url).toBe('https://example.supabase.co/functions/v1/ai');
    expect(gatewayRequests[0]?.body).toEqual({
      requestId: REQ_ID,
      task: 'carecircle.summarizeVisit',
      input: {
        circleId: CIRCLE_ID,
        text: 'Doctor said blood pressure is stable.',
        knownMeds: [{ id: MED_ID, name: 'Aspirin', strength: '81 mg' }],
      },
    });

    // 2. Audio call: uploads to visit-audio, deletes local file immediately after upload, calls gateway, and cleans up
    const audioRes = await summarizeVisit(
      {
        circleId: CIRCLE_ID,
        audioBytes: new Uint8Array([1, 2, 3, 4]),
        localUri: 'file:///cache/visit-2.m4a',
        knownMeds: [{ id: MED_ID, name: 'Aspirin', strength: '81 mg' }],
      },
      {
        supabase: fakeSupabase,
        baseUrl: 'https://example.supabase.co',
        getAccessToken: () => 'jwt-token',
        fetchImpl,
        requestId: REQ_ID,
        audioId: AUDIO_ID,
        deleteLocalFile: (uri) => deletedLocal.push(uri),
      },
    );

    expect(audioRes.ok).toBe(true);
    expect(deletedLocal).toEqual(['file:///cache/visit-2.m4a']);
    expect(gatewayRequests[1]?.body).toEqual({
      requestId: REQ_ID,
      task: 'carecircle.summarizeVisit',
      input: {
        circleId: CIRCLE_ID,
        audioPath: `${CIRCLE_ID}/${AUDIO_ID}.m4a`,
        knownMeds: [{ id: MED_ID, name: 'Aspirin', strength: '81 mg' }],
      },
    });
    expect(removedPaths).toEqual([`${CIRCLE_ID}/${AUDIO_ID}.m4a`]);
  });
});
