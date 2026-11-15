import { materializeDoseTimes } from './dose-logic.ts';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
};

Deno.test(
  'supabase/carecircle/functions/_shared/dose-logic.ts matches apps/carecircle/src/features/meds/logic.ts',
  async () => {
    const repoRoot = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
    const sourcePath = `${repoRoot}/apps/carecircle/src/features/meds/logic.ts`;
    const copyPath = `${repoRoot}/supabase/carecircle/functions/_shared/dose-logic.ts`;

    const sourceText = await Deno.readTextFile(sourcePath);
    const copyText = await Deno.readTextFile(copyPath);

    const expectedHeader = [
      '// Generated, do not edit by hand. Synced by scripts/sync-dose-logic.mjs from apps/carecircle/src/features/meds/logic.ts.',
      '// Run `node scripts/sync-dose-logic.mjs` after updating logic.ts.',
      '',
    ].join('\n');

    assert(
      copyText.startsWith(expectedHeader),
      '_shared/dose-logic.ts must start with the Generated, do not edit header',
    );
    assert(
      copyText.slice(expectedHeader.length) === sourceText,
      '_shared/dose-logic.ts differs from apps/carecircle/src/features/meds/logic.ts; run node scripts/sync-dose-logic.mjs',
    );
    assert(typeof materializeDoseTimes === 'function', 'materializeDoseTimes must be exported');
  },
);
