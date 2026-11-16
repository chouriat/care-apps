import { File, Paths } from 'expo-file-system';
import { MAX_VISIT_RECORDING_MS, uploadVisitAudio, type VisitStorageSupabaseLike } from './storage';

/**
 * AAC in an `.m4a` (MPEG-4 audio) container, matching the `visit-audio` bucket rule
 * (`{circleId}/{uuid}.m4a`, `audio/m4a` or `audio/mp4`, max 10 MB / 10 minutes).
 * Note: Native microphone recording on iOS/Android uses Expo's audio module (`expo-audio` in
 * SDK 58) which requires an Expo development build when custom native permissions are configured.
 */
export const AAC_M4A_RECORDING_OPTIONS = {
  extension: '.m4a',
  sampleRate: 44_100,
  numberOfChannels: 1,
  bitRate: 64_000,
  android: {
    extension: '.m4a',
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  ios: {
    extension: '.m4a',
    outputFormat: 'aac ',
    audioQuality: 96,
  },
} as const;

export class VisitAudioPermissionError extends Error {
  constructor() {
    super('AUDIO_PERMISSION_DENIED');
    this.name = 'VisitAudioPermissionError';
  }
}

export interface RecordedVisitAudioFile {
  uri: string;
  durationMs: number;
}

export interface CapturedVisitRecording {
  uri: string;
  bytes: Uint8Array;
  durationMs: number;
  contentType: 'audio/m4a';
  autoStopped: boolean;
}

export interface VisitAudioRecorderModules {
  requestPermission: () => Promise<boolean>;
  startNativeRecording: (options: typeof AAC_M4A_RECORDING_OPTIONS) => Promise<{
    stopAndGetFile: () => Promise<RecordedVisitAudioFile>;
  }>;
  readBytes: (uri: string) => Promise<Uint8Array>;
  deleteLocal: (uri: string) => void;
}

interface DynamicExpoAudioModule {
  AudioModule?: {
    requestRecordingPermissionsAsync?: () => Promise<{ granted: boolean }>;
    AudioRecorder?: new (options: unknown) => {
      prepareToRecordAsync?: () => Promise<void>;
      record: () => void;
      stop: () => Promise<void>;
      uri?: string | null;
      currentTime?: number;
    };
  };
  requestRecordingPermissionsAsync?: () => Promise<{ granted: boolean }>;
}

async function loadExpoAudioModule(): Promise<DynamicExpoAudioModule> {
  const pkgName = 'expo-audio';
  return (await import(pkgName)) as DynamicExpoAudioModule;
}

const defaultRecorderModules: VisitAudioRecorderModules = {
  async requestPermission() {
    const mod = await loadExpoAudioModule();
    const reqFn =
      mod.AudioModule?.requestRecordingPermissionsAsync ?? mod.requestRecordingPermissionsAsync;
    if (typeof reqFn !== 'function') {
      throw new Error('Expo audio module is not available in this build');
    }
    const res = await reqFn();
    return Boolean(res?.granted);
  },
  async startNativeRecording(options) {
    const mod = await loadExpoAudioModule();
    const RecorderClass = mod.AudioModule?.AudioRecorder;
    if (!RecorderClass) {
      throw new Error('Expo AudioRecorder is not available in this build');
    }
    const startedAt = Date.now();
    const recorder = new RecorderClass(options);
    if (typeof recorder.prepareToRecordAsync === 'function') {
      await recorder.prepareToRecordAsync();
    }
    recorder.record();
    return {
      async stopAndGetFile() {
        await recorder.stop();
        const uri = recorder.uri ?? '';
        if (!uri) {
          throw new Error('Recording produced no file URI');
        }
        const durationMs =
          typeof recorder.currentTime === 'number' && recorder.currentTime > 0
            ? Math.round(recorder.currentTime * 1000)
            : Math.max(0, Date.now() - startedAt);
        return { uri, durationMs };
      },
    };
  },
  async readBytes(uri: string) {
    return new Uint8Array(await new File(uri).arrayBuffer());
  },
  deleteLocal(uri: string) {
    try {
      if (!uri) return;
      if (Paths.cache?.uri && !uri.startsWith(Paths.cache.uri) && !uri.startsWith('file://')) {
        return;
      }
      const file = new File(uri);
      if (file.exists) {
        file.delete();
      }
    } catch {
      // Never fail if the OS already cleared the temporary recording file.
    }
  },
};

export interface CreateVisitAudioRecorderOptions {
  modules?: VisitAudioRecorderModules;
  maxDurationMs?: number;
  onAutoStop?: (recording: CapturedVisitRecording) => void;
}

export interface VisitAudioRecorderSession {
  stop: () => Promise<CapturedVisitRecording>;
  uploadAndDeleteLocal: (opts: {
    supabase: VisitStorageSupabaseLike;
    circleId: string;
    audioId?: string;
  }) => Promise<{ audioPath: string; durationMs: number; autoStopped: boolean }>;
}

/**
 * Starts an AAC `.m4a` visit recording that automatically stops at `maxDurationMs`
 * (default 10 minutes = 600,000 ms), uploads to `visit-audio/{circleId}/{uuid}.m4a`,
 * and deletes the local `.m4a` file after upload.
 */
export async function startVisitAudioRecording(
  options: CreateVisitAudioRecorderOptions = {},
): Promise<VisitAudioRecorderSession> {
  const modules = options.modules ?? defaultRecorderModules;
  const maxDurationMs = options.maxDurationMs ?? MAX_VISIT_RECORDING_MS;

  const granted = await modules.requestPermission();
  if (!granted) {
    throw new VisitAudioPermissionError();
  }

  const nativeSession = await modules.startNativeRecording(AAC_M4A_RECORDING_OPTIONS);
  let finishPromise: Promise<CapturedVisitRecording> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finalize = (autoStopped: boolean): Promise<CapturedVisitRecording> => {
    if (finishPromise) {
      return finishPromise;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    finishPromise = (async () => {
      const file = await nativeSession.stopAndGetFile();
      const bytes = await modules.readBytes(file.uri);
      const result: CapturedVisitRecording = {
        uri: file.uri,
        bytes,
        durationMs: autoStopped
          ? Math.min(file.durationMs || maxDurationMs, maxDurationMs)
          : file.durationMs,
        contentType: 'audio/m4a',
        autoStopped,
      };
      if (autoStopped) {
        options.onAutoStop?.(result);
      }
      return result;
    })();
    return finishPromise;
  };

  timer = setTimeout(() => {
    void finalize(true).catch(() => undefined);
  }, maxDurationMs);

  return {
    stop: () => finalize(false),
    async uploadAndDeleteLocal({ supabase, circleId, audioId }) {
      const recorded = await finalize(false);
      try {
        const { audioPath } = await uploadVisitAudio({
          supabase,
          circleId,
          audioId,
          bytes: recorded.bytes,
          contentType: recorded.contentType,
        });
        return {
          audioPath,
          durationMs: recorded.durationMs,
          autoStopped: recorded.autoStopped,
        };
      } finally {
        modules.deleteLocal(recorded.uri);
      }
    },
  };
}
