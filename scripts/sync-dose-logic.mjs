import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const sourceRelPath = 'apps/carecircle/src/features/meds/logic.ts';
const targetRelPath = 'supabase/carecircle/functions/_shared/dose-logic.ts';

const sourcePath = path.join(repoRoot, sourceRelPath);
const targetPath = path.join(repoRoot, targetRelPath);

const sourceContent = fs.readFileSync(sourcePath, 'utf8');
const header = [
  `// Generated, do not edit by hand. Synced by scripts/sync-dose-logic.mjs from ${sourceRelPath}.`,
  '// Run `node scripts/sync-dose-logic.mjs` after updating logic.ts.',
  '',
].join('\n');

const rawOutput = `${header}${sourceContent}`;
const prettierConfig = await prettier.resolveConfig(targetPath);
const formattedOutput = await prettier.format(rawOutput, {
  ...prettierConfig,
  filepath: targetPath,
});

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.writeFileSync(targetPath, formattedOutput, 'utf8');
