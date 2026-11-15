/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// Expo copies an EXPO_PUBLIC_ variable into a release or preview build only where the code
// writes `process.env.EXPO_PUBLIC_NAME` in full. Reading it through another object
// (`const env = process.env; env.EXPO_PUBLIC_NAME`, destructuring, `process.env[name]`) works
// in development but is empty in every release build (PR #16 found the app crashing on launch).
// https://docs.expo.dev/guides/environment-variables/ (checked 2026-11-15)
const ROOT = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'node_modules' || name === '__mocks__' ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('EXPO_PUBLIC_ variables reach release builds', () => {
  it('every EXPO_PUBLIC_ variable the app uses is read literally as process.env.EXPO_PUBLIC_NAME', () => {
    const problems: string[] = [];
    for (const file of [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'app'))]) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
      const names = new Set(
        [...code.matchAll(/(?<!['"\w ])\b(EXPO_PUBLIC_[A-Z0-9_]+)\b/g)].map((m) => m[1]),
      );
      for (const name of names) {
        if (!code.includes(`process.env.${name}`)) {
          problems.push(`${file.replace(ROOT, '')}: ${name}`);
        }
      }
      if (/process\.env\[/.test(code)) {
        problems.push(`${file.replace(ROOT, '')}: process.env[...]`);
      }
    }
    expect(problems).toEqual([]);
  });
});
