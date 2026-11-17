import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { fetch } = globalThis;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const LABELS_DIR = path.join(ROOT_DIR, 'evals', 'carecircle', 'labels');
const EXPECTED_PATH = path.join(LABELS_DIR, 'expected.json');
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const TARGET_ACCURACY = 0.9;

// A real label photo is a decodable JPEG (ends with the FF D9 end marker) of real size. The
// committed placeholders were 134-byte, truncated, identical white 1x1 files: scoring them
// "proved" nothing, because nothing was ever sent to the AI.
const MIN_REAL_PHOTO_BYTES = 10 * 1024;

export function findPlaceholderPhotos(files) {
  const seen = new Map();
  const problems = [];
  for (const { file, bytes } of files) {
    const n = bytes.length;
    const endsWithEoi = n >= 2 && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9;
    const key = bytes.toString('base64');
    if (n < MIN_REAL_PHOTO_BYTES || !endsWithEoi) problems.push(`${file} (too small or cut off)`);
    else if (seen.has(key)) problems.push(`${file} (same bytes as ${seen.get(key)})`);
    if (!seen.has(key)) seen.set(key, file);
  }
  return problems;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function evaluateLabelDataset(dataset) {
  if (!dataset || !Array.isArray(dataset.labels) || dataset.labels.length !== 20) {
    throw new Error(
      `Expected exactly 20 labels in expected.json, found ${dataset?.labels?.length ?? 0}`,
    );
  }

  let totalFields = 0;
  let matchingFields = 0;
  const fieldCounts = {
    name: { matched: 0, total: 0 },
    strength: { matched: 0, total: 0 },
    doseText: { matched: 0, total: 0 },
    schedule: { matched: 0, total: 0 },
  };
  const missedLabels = [];

  for (const item of dataset.labels) {
    // Privacy check: labelText and rawText must never contain unblurred email addresses or phone numbers.
    if (/@/.test(item.labelText ?? '') || /@/.test(item.extracted?.rawText ?? '')) {
      throw new Error(`Label ${item.id} contains an unblurred email address`);
    }

    const expected = item.expected;
    const confirmed = item.confirmed ?? item.extracted;
    const missedFields = [];

    for (const field of ['name', 'strength', 'doseText', 'schedule']) {
      totalFields += 1;
      fieldCounts[field].total += 1;
      if (deepEqual(expected[field], confirmed?.[field])) {
        matchingFields += 1;
        fieldCounts[field].matched += 1;
      } else {
        missedFields.push(field);
      }
    }

    if (missedFields.length > 0) {
      missedLabels.push({ id: item.id, missedFields });
    }
  }

  const accuracy = totalFields > 0 ? matchingFields / totalFields : 0;
  return {
    labelCount: dataset.labels.length,
    totalFields,
    matchingFields,
    accuracy,
    fieldCounts,
    missedLabels,
    passed: accuracy >= TARGET_ACCURACY,
  };
}

async function signInEvalAccount(supabaseUrl, anonKey, email, password) {
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
  if (typeof body?.access_token !== 'string') {
    throw new Error('Eval sign-in did not return an access_token');
  }
  return body.access_token;
}

async function getOrCreateEvalCircle(supabaseUrl, anonKey, accessToken) {
  const listRes = await fetch(`${supabaseUrl}/rest/v1/circles?select=id&limit=1`, {
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!listRes.ok) {
    throw new Error(`Failed to list circles: HTTP ${listRes.status}`);
  }
  const rows = await listRes.json();
  if (Array.isArray(rows) && typeof rows[0]?.id === 'string') {
    return rows[0].id.toLowerCase();
  }

  const createRes = await fetch(`${supabaseUrl}/rest/v1/rpc/create_circle`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Eval circle',
      careRecipientName: 'Eval Recipient',
      timezone: 'Europe/Paris',
    }),
  });
  if (!createRes.ok) {
    throw new Error(`create_circle failed with HTTP ${createRes.status}`);
  }
  const created = await createRes.json();
  if (typeof created?.id !== 'string') {
    throw new Error('create_circle did not return a circle id');
  }
  return created.id.toLowerCase();
}

async function extractLabelViaGateway({ supabaseUrl, anonKey, accessToken, circleId, bytes }) {
  const photoId = crypto.randomUUID().toLowerCase();
  const imagePath = `${circleId}/${photoId}.jpg`;
  const authHeaders = {
    apikey: anonKey,
    authorization: `Bearer ${accessToken}`,
  };

  const uploadRes = await fetch(
    `${supabaseUrl}/storage/v1/object/prescription-photos/${imagePath}`,
    {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'image/jpeg',
        'x-upsert': 'false',
      },
      body: bytes,
    },
  );
  if (!uploadRes.ok) {
    throw new Error(`Storage upload failed for ${imagePath}: HTTP ${uploadRes.status}`);
  }

  try {
    const aiRes = await fetch(`${supabaseUrl}/functions/v1/ai`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: crypto.randomUUID().toLowerCase(),
        task: 'carecircle.extractPrescription',
        input: { imagePath },
      }),
    });
    const body = await aiRes.json().catch(() => null);
    if (!aiRes.ok || !body?.ok) {
      throw new Error(
        `AI gateway extractPrescription failed (${aiRes.status}): ${body?.error?.code ?? 'UNKNOWN'}`,
      );
    }
    return {
      output: body.output,
      model: typeof body.model === 'string' ? body.model : 'live-gateway',
    };
  } finally {
    await fetch(`${supabaseUrl}/storage/v1/object/prescription-photos`, {
      method: 'DELETE',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prefixes: [imagePath] }),
    }).catch(() => undefined);
  }
}

async function runCli() {
  const raw = fs.readFileSync(EXPECTED_PATH, 'utf8');
  const dataset = JSON.parse(raw);
  const files = [];
  const bytesByFile = new Map();

  // Verify all 20 JPEG files exist and have a valid JPEG header (FF D8 FF) and size <= 2 MB.
  for (const item of dataset.labels) {
    const filePath = path.join(LABELS_DIR, item.file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing label image file: ${filePath}`);
    }
    const bytes = fs.readFileSync(filePath);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_JPEG_BYTES) {
      throw new Error(`Label image ${item.file} size (${bytes.byteLength}) exceeds 2 MB limit`);
    }
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error(`Label image ${item.file} does not start with JPEG header FF D8 FF`);
    }
    const buf = Buffer.from(bytes);
    files.push({ file: item.file, bytes: buf });
    bytesByFile.set(item.file, buf);
  }

  const placeholders = findPlaceholderPhotos(files);
  if (placeholders.length > 0) {
    process.stderr.write(
      `NOT RUN: ${placeholders.length} label photo(s) are placeholders, not real blurred labels:\n` +
        placeholders.map((p) => `  - ${p}\n`).join('') +
        'No accuracy is reported until the 20 blurred photos are in evals/carecircle/labels/.\n',
    );
    process.exit(1);
  }

  const email = process.env.CARECIRCLE_EVAL_EMAIL?.trim();
  const password = process.env.CARECIRCLE_EVAL_PASSWORD?.trim();
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, '');
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (email && password && supabaseUrl && anonKey) {
    const accessToken = await signInEvalAccount(supabaseUrl, anonKey, email, password);
    const circleId = await getOrCreateEvalCircle(supabaseUrl, anonKey, accessToken);
    for (const item of dataset.labels) {
      const bytes = bytesByFile.get(item.file);
      const reading = await extractLabelViaGateway({
        supabaseUrl,
        anonKey,
        accessToken,
        circleId,
        bytes,
      });
      item.extracted = reading.output;
      item.extractedBy = reading.model;
      delete item.confirmed;
    }
  }

  // Until the gateway runner has populated extractedBy, `extracted` is a hand-written answer, not an AI reading.
  if (dataset.labels.some((item) => !item.extracted || !item.extractedBy)) {
    process.stderr.write(
      'NOT RUN: expected.json has hand-written "extracted" answers. The eval must send each photo ' +
        'through carecircle.extractPrescription and score that reading, not a copy of the answer.\n',
    );
    process.exit(1);
  }

  const summary = evaluateLabelDataset(dataset);
  const pct = (summary.accuracy * 100).toFixed(1);
  process.stdout.write(
    `CareCircle CC-4b Label Eval: ${summary.matchingFields}/${summary.totalFields} fields matched (${pct}%) across ${summary.labelCount} labels (threshold: >= 90.0%)\n`,
  );
  for (const [field, counts] of Object.entries(summary.fieldCounts)) {
    process.stdout.write(`  - ${field}: ${counts.matched}/${counts.total}\n`);
  }
  if (summary.missedLabels.length > 0) {
    process.stdout.write(
      `Missed labels: ${summary.missedLabels.map((m) => `${m.id} (${m.missedFields.join(', ')})`).join('; ')}\n`,
    );
  } else {
    process.stdout.write('Missed labels: none\n');
  }

  if (!summary.passed) {
    process.stderr.write(`FAIL: accuracy ${pct}% is below required 90.0%\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((err) => {
    process.stderr.write(`NOT RUN: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
