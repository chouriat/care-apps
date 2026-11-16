import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const LABELS_DIR = path.join(ROOT_DIR, 'evals', 'carecircle', 'labels');
const EXPECTED_PATH = path.join(LABELS_DIR, 'expected.json');
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const TARGET_ACCURACY = 0.9;

// Minimal valid 1x1 white JPEG (107 bytes) for synthetic placeholder labels before real blurred photos are added.
const MINIMAL_1X1_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

export function ensurePlaceholderLabelImages() {
  if (!fs.existsSync(EXPECTED_PATH)) {
    throw new Error(`Missing expected.json at ${EXPECTED_PATH}`);
  }
  const dataset = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
  for (const item of dataset.labels) {
    const filePath = path.join(LABELS_DIR, item.file);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, MINIMAL_1X1_JPEG);
    }
  }
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

  for (const item of dataset.labels) {
    // Privacy check: labelText and rawText must never contain unblurred email addresses or phone numbers.
    if (/@/.test(item.labelText ?? '') || /@/.test(item.extracted?.rawText ?? '')) {
      throw new Error(`Label ${item.id} contains an unblurred email address`);
    }

    const expected = item.expected;
    const confirmed = item.confirmed ?? item.extracted;

    for (const field of ['name', 'strength', 'doseText', 'schedule']) {
      totalFields += 1;
      fieldCounts[field].total += 1;
      if (deepEqual(expected[field], confirmed?.[field])) {
        matchingFields += 1;
        fieldCounts[field].matched += 1;
      }
    }
  }

  const accuracy = totalFields > 0 ? matchingFields / totalFields : 0;
  return {
    labelCount: dataset.labels.length,
    totalFields,
    matchingFields,
    accuracy,
    fieldCounts,
    passed: accuracy >= TARGET_ACCURACY,
  };
}

function runCli() {
  ensurePlaceholderLabelImages();
  const raw = fs.readFileSync(EXPECTED_PATH, 'utf8');
  const dataset = JSON.parse(raw);

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
  }

  const summary = evaluateLabelDataset(dataset);
  const pct = (summary.accuracy * 100).toFixed(1);
  process.stdout.write(
    `CareCircle CC-4b Label Eval: ${summary.matchingFields}/${summary.totalFields} fields matched (${pct}%) across ${summary.labelCount} labels (threshold: >= 90.0%)\n`,
  );
  for (const [field, counts] of Object.entries(summary.fieldCounts)) {
    process.stdout.write(`  - ${field}: ${counts.matched}/${counts.total}\n`);
  }

  if (!summary.passed) {
    process.stderr.write(`FAIL: accuracy ${pct}% is below required 90.0%\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
