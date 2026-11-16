import {
  createAiGatewayClient,
  summarizeVisitInputSchema,
  summarizeVisitOutputSchema,
  type AiFetch,
  type AiGatewayResponse,
  type SummarizeVisitInput,
  type SummarizeVisitOutput,
} from '@carecircle/ai-gateway';
import { getSupabaseClient } from '../auth/api';
import {
  createVisitAudioId,
  deleteVisitAudioObject,
  uploadVisitAudio,
  type VisitStorageSupabaseLike,
} from './storage';

export interface VisitKnownMed {
  id: string;
  name: string;
  strength: string | null;
}

export interface SummarizeVisitApiDeps {
  supabase?: VisitStorageSupabaseLike & {
    auth?: {
      getSession: () => Promise<{ data: { session: { access_token: string } | null } }>;
    };
  };
  baseUrl?: string;
  getAccessToken?: () => Promise<string | null> | string | null;
  fetchImpl?: AiFetch;
  requestId?: string;
  audioId?: string;
  deleteLocalFile?: (uri: string) => void;
}

export type SummarizeVisitCallInput =
  | {
      circleId: string;
      text: string;
      knownMeds: VisitKnownMed[];
      audioBytes?: undefined;
      audioPath?: undefined;
    }
  | {
      circleId: string;
      audioPath: string;
      text?: string;
      knownMeds: VisitKnownMed[];
      audioBytes?: undefined;
    }
  | {
      circleId: string;
      audioBytes: Uint8Array;
      contentType?: 'audio/m4a' | 'audio/mp4';
      localUri?: string;
      text?: string;
      knownMeds: VisitKnownMed[];
      audioPath?: undefined;
    };

export async function summarizeVisit(
  input: SummarizeVisitCallInput,
  deps: SummarizeVisitApiDeps = {},
): Promise<AiGatewayResponse<SummarizeVisitOutput>> {
  const supabase =
    deps.supabase ??
    (getSupabaseClient() as unknown as NonNullable<SummarizeVisitApiDeps['supabase']>);
  const baseUrl =
    deps.baseUrl ?? process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? 'http://127.0.0.1:54321';

  const getAccessToken =
    deps.getAccessToken ??
    (async () => {
      const res = await supabase.auth?.getSession();
      return res?.data?.session?.access_token ?? null;
    });

  const client = createAiGatewayClient({
    baseUrl,
    getAccessToken,
    fetchImpl: deps.fetchImpl,
  });

  let uploadedAudioPath: string | null = null;
  try {
    if (input.audioBytes !== undefined) {
      try {
        const uploaded = await uploadVisitAudio({
          supabase,
          circleId: input.circleId,
          audioId: deps.audioId,
          bytes: input.audioBytes,
          contentType: input.contentType ?? 'audio/m4a',
        });
        uploadedAudioPath = uploaded.audioPath;
      } finally {
        if (input.localUri) {
          deps.deleteLocalFile?.(input.localUri);
        }
      }
    }

    const gatewayInput: SummarizeVisitInput = {
      circleId: input.circleId,
      ...(uploadedAudioPath
        ? { audioPath: uploadedAudioPath }
        : input.audioPath
          ? { audioPath: input.audioPath }
          : {}),
      ...(input.text ? { text: input.text } : {}),
      knownMeds: input.knownMeds,
    };

    const parsedInput = summarizeVisitInputSchema.safeParse(gatewayInput);
    if (!parsedInput.success) {
      return {
        ok: false,
        error: {
          code: 'INPUT_INVALID',
          message: 'Invalid visit summary input.',
          retryable: false,
        },
      };
    }

    const requestId = deps.requestId ?? createVisitAudioId();
    return await client.call(
      {
        requestId,
        task: 'carecircle.summarizeVisit',
        input: parsedInput.data,
      },
      summarizeVisitOutputSchema,
    );
  } finally {
    if (uploadedAudioPath) {
      await deleteVisitAudioObject({ supabase, audioPath: uploadedAudioPath }).catch(
        () => undefined,
      );
    }
  }
}
