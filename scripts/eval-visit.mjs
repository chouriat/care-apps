import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { fetch } = globalThis;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const AUDIO_FIXTURE_PATH = path.join(REPO_ROOT, 'evals/carecircle/visit/visit-5min.m4a');
const ITERATIONS = 10;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isSchemaValidVisitDraft(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const keys = Object.keys(output).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify(['followUps', 'medChanges', 'questionsToAsk', 'summary'])
  ) {
    return false;
  }
  if (typeof output.summary !== 'string' || output.summary.trim().length === 0) return false;
  if (
    !Array.isArray(output.followUps) ||
    !Array.isArray(output.medChanges) ||
    !Array.isArray(output.questionsToAsk)
  ) {
    return false;
  }
  for (const item of output.followUps) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (
      JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(['dueDate', 'dueHint', 'title'])
    ) {
      return false;
    }
    if (typeof item.title !== 'string' || item.title.trim().length === 0) return false;
    if (
      item.dueHint !== null &&
      (typeof item.dueHint !== 'string' || item.dueHint.trim().length === 0)
    ) {
      return false;
    }
    if (
      item.dueDate !== null &&
      (typeof item.dueDate !== 'string' || !ISO_DATE_REGEX.test(item.dueDate))
    ) {
      return false;
    }
  }
  for (const med of output.medChanges) {
    if (!med || typeof med !== 'object' || Array.isArray(med)) return false;
    if (
      JSON.stringify(Object.keys(med).sort()) !==
      JSON.stringify(['action', 'detail', 'medicationId', 'name'])
    ) {
      return false;
    }
    if (!['start', 'stop', 'change_dose'].includes(med.action)) return false;
    if (med.action === 'start' && med.medicationId !== null) return false;
    if (
      (med.action === 'stop' || med.action === 'change_dose') &&
      (typeof med.medicationId !== 'string' || !UUID_REGEX.test(med.medicationId))
    ) {
      return false;
    }
    if (typeof med.name !== 'string' || med.name.trim().length === 0) return false;
    if (med.detail !== null && (typeof med.detail !== 'string' || med.detail.trim().length === 0)) {
      return false;
    }
  }
  for (const q of output.questionsToAsk) {
    if (typeof q !== 'string' || q.trim().length === 0) return false;
  }
  return true;
}

export function computePercentiles(latenciesMs) {
  if (latenciesMs.length === 0) return { p50Ms: 0, p90Ms: 0 };
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const pick = (p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return Math.round(sorted[idx]);
  };
  return {
    p50Ms: pick(0.5),
    p90Ms: pick(0.9),
  };
}

async function resolveSession(supabaseUrl, anonKey) {
  if (process.env.CARECIRCLE_EVAL_ACCESS_TOKEN?.trim()) {
    return process.env.CARECIRCLE_EVAL_ACCESS_TOKEN.trim();
  }
  const email = process.env.CARECIRCLE_EVAL_EMAIL?.trim();
  const password = process.env.CARECIRCLE_EVAL_PASSWORD?.trim();
  if (!email || !password || !anonKey) return null;

  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Eval sign-in failed with HTTP ${res.status}`);
  }
  const body = await res.json();
  return typeof body.access_token === 'string' ? body.access_token : null;
}

async function ensureEvalCircleAndMeds(supabaseUrl, anonKey, accessToken) {
  const explicitCircleId = process.env.CARECIRCLE_EVAL_CIRCLE_ID?.trim();
  if (explicitCircleId) {
    const medsRes = await fetch(
      `${supabaseUrl}/rest/v1/medications?circle_id=eq.${encodeURIComponent(explicitCircleId)}&active=eq.true&select=id,name,strength`,
      {
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    const meds = medsRes.ok ? await medsRes.json() : [];
    return {
      circleId: explicitCircleId.toLowerCase(),
      knownMeds: Array.isArray(meds) ? meds : [],
    };
  }

  const circlesRes = await fetch(`${supabaseUrl}/rest/v1/circles?select=id&limit=1`, {
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${accessToken}`,
    },
  });
  const circles = circlesRes.ok ? await circlesRes.json() : [];
  let circleId =
    Array.isArray(circles) && circles[0]?.id ? String(circles[0].id).toLowerCase() : null;

  if (!circleId) {
    const createRes = await fetch(`${supabaseUrl}/rest/v1/rpc/create_circle`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Eval circle',
        careRecipientName: 'Eval recipient',
        timezone: 'Europe/Paris',
      }),
    });
    if (!createRes.ok) {
      throw new Error(`create_circle failed with HTTP ${createRes.status}`);
    }
    const created = await createRes.json();
    circleId = String(created.id).toLowerCase();
  }

  const medsRes = await fetch(
    `${supabaseUrl}/rest/v1/medications?circle_id=eq.${encodeURIComponent(circleId)}&active=eq.true&select=id,name,strength`,
    {
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${accessToken}`,
      },
    },
  );
  const meds = medsRes.ok ? await medsRes.json() : [];
  return {
    circleId,
    knownMeds: Array.isArray(meds) ? meds : [],
  };
}

async function runCli() {
  if (!fs.existsSync(AUDIO_FIXTURE_PATH)) {
    process.stderr.write(`NOT RUN: missing audio fixture at ${AUDIO_FIXTURE_PATH}\n`);
    process.exit(1);
  }

  const gatewayBaseUrl = (
    process.env.CARECIRCLE_EVAL_GATEWAY_URL ??
    process.env.EXPO_PUBLIC_SUPABASE_URL ??
    ''
  )
    .trim()
    .replace(/\/+$/, '');
  const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? gatewayBaseUrl)
    .trim()
    .replace(/\/+$/, '');
  const anonKey = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();

  if (!gatewayBaseUrl) {
    process.stderr.write(
      'NOT RUN: set CARECIRCLE_EVAL_GATEWAY_URL (or EXPO_PUBLIC_SUPABASE_URL) and credentials to run the 10-iteration visit audio speed evaluation.\n',
    );
    process.exit(1);
  }

  const accessToken = await resolveSession(supabaseUrl, anonKey);
  if (!accessToken) {
    process.stderr.write(
      'NOT RUN: set CARECIRCLE_EVAL_ACCESS_TOKEN or CARECIRCLE_EVAL_EMAIL + CARECIRCLE_EVAL_PASSWORD + EXPO_PUBLIC_SUPABASE_ANON_KEY.\n',
    );
    process.exit(1);
  }

  const audioBytes = fs.readFileSync(AUDIO_FIXTURE_PATH);
  const { circleId, knownMeds } = await ensureEvalCircleAndMeds(supabaseUrl, anonKey, accessToken);

  const latenciesMs = [];
  let validDrafts = 0;

  for (let i = 1; i <= ITERATIONS; i += 1) {
    const audioId = crypto.randomUUID().toLowerCase();
    const audioPath = `${circleId}/${audioId}.m4a`;

    const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/visit-audio/${audioPath}`, {
      method: 'POST',
      headers: {
        ...(anonKey ? { apikey: anonKey } : {}),
        authorization: `Bearer ${accessToken}`,
        'content-type': 'audio/m4a',
        'x-upsert': 'false',
      },
      body: audioBytes,
    });
    if (!uploadRes.ok) {
      throw new Error(`Iteration ${i}: visit-audio upload failed with HTTP ${uploadRes.status}`);
    }

    const requestId = crypto.randomUUID().toLowerCase();
    const startedAt = Date.now();
    const aiRes = await fetch(`${gatewayBaseUrl}/functions/v1/ai`, {
      method: 'POST',
      headers: {
        ...(anonKey ? { apikey: anonKey } : {}),
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId,
        task: 'carecircle.summarizeVisit',
        input: {
          circleId,
          audioPath,
          knownMeds,
        },
      }),
    });
    const elapsedMs = Date.now() - startedAt;
    latenciesMs.push(elapsedMs);

    const payload = await aiRes.json().catch(() => null);
    if (aiRes.ok && payload?.ok === true && isSchemaValidVisitDraft(payload.output)) {
      validDrafts += 1;
    }
  }

  const { p50Ms, p90Ms } = computePercentiles(latenciesMs);
  process.stdout.write(
    JSON.stringify({
      event: 'eval_visit_summary',
      runs: ITERATIONS,
      schemaValidDrafts: validDrafts,
      p50Ms,
      p90Ms,
    }) + '\n',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((err) => {
    process.stderr.write(`NOT RUN: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
