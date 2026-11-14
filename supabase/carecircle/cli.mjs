import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const carecircleDir = dirname(fileURLToPath(import.meta.url));

function collectTestFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
    } else if (entry.name.endsWith('.sql') || entry.name.endsWith('.pg')) {
      files.push(entry.name);
    }
  }
  return files;
}

function stageProject() {
  const workDir = process.env.CARECIRCLE_SUPABASE_WORKDIR ?? join(tmpdir(), 'carecircle-supabase');
  const supabaseDir = join(workDir, 'supabase');

  mkdirSync(supabaseDir, { recursive: true });
  cpSync(join(carecircleDir, 'config.toml'), join(supabaseDir, 'config.toml'));

  for (const folder of ['migrations', 'functions', 'tests']) {
    const source = join(carecircleDir, folder);
    const target = join(supabaseDir, folder);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    if (existsSync(source)) {
      cpSync(source, target, {
        recursive: true,
        filter: (sourcePath) => !sourcePath.endsWith('.gitkeep'),
      });
    }
  }

  return workDir;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('Usage: node supabase/carecircle/cli.mjs <stage | supabase-args...>\n');
  process.exit(1);
}

const workDir = stageProject();
if (args[0] === 'stage') {
  process.stdout.write(`${workDir}\n`);
  process.exit(0);
}

const cliArgs = args.includes('--workdir') ? args : [...args, '--workdir', workDir];

if (args[0] === 'test' && args[1] === 'db') {
  const testFiles = collectTestFiles(join(carecircleDir, 'tests'));
  if (testFiles.length === 0) {
    process.stderr.write('No pgTAP test files found in supabase/carecircle/tests.\n');
    process.exit(1);
  }

  const result = spawnSync('supabase', cliArgs, { encoding: 'utf8' });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const missingFiles = testFiles.filter((file) => !combinedOutput.includes(file));
  if (!combinedOutput.includes('Result: PASS') || missingFiles.length > 0) {
    process.stderr.write(
      `pgTAP verification failed: missing Result: PASS or unexecuted files (${missingFiles.join(', ')}).\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const result = spawnSync('supabase', cliArgs, { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
