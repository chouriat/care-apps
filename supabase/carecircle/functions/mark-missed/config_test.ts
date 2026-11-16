function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// pg_cron calls mark-missed with `Authorization: Bearer <cron_secret>`, which is not a Supabase
// JWT. Without `verify_jwt = false` the Supabase gateway answers 401 before the function runs, so
// no dose would ever become `missed` and nobody would be alerted.
Deno.test(
  'config.toml turns off Supabase JWT checks for mark-missed (pg_cron sends the cron secret)',
  async () => {
    const toml = await Deno.readTextFile(new URL('../../config.toml', import.meta.url));
    const section = toml
      .split(/\n(?=\[)/)
      .find((s) => s.trim().startsWith('[functions.mark-missed]'));
    assert(section !== undefined, '[functions.mark-missed] section exists');
    assert(/\bverify_jwt\s*=\s*false\b/.test(section ?? ''), 'verify_jwt = false');
  },
);
