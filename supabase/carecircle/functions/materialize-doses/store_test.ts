// CC-2a review: the PostgREST store must not lose medicines past PostgREST's `max_rows` cap
// (1000 rows per request), and a single-medicine request must look that medicine up directly.
import { createMaterializeDosesHandler } from './handler.ts';
import { createPostgrestStore, MEDICATION_PAGE_SIZE } from './store.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const MAX_ROWS = 1000;

function medId(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

/** A fake PostgREST that, like the real one, never returns more than MAX_ROWS rows. */
function fakePostgrest(total: number) {
  const all = Array.from({ length: total }, (_, i) => ({
    id: medId(i + 1),
    circle_id: 'c0000000-0000-4000-8000-000000000001',
    schedule: { kind: 'daily', times: ['08:00'] },
    start_date: null,
    end_date: null,
    active: true,
    circles: { timezone: 'Europe/Paris' },
  }));
  const urls: string[] = [];
  const insertedMedicationIds = new Set<string>();
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    urls.push(url.pathname + url.search);
    if (url.pathname.endsWith('/medications')) {
      let rows = all.filter((r) => r.active);
      for (const f of url.searchParams.getAll('id')) {
        const [op, value] = [f.slice(0, f.indexOf('.')), f.slice(f.indexOf('.') + 1)];
        if (op === 'eq') rows = rows.filter((r) => r.id === value);
        else if (op === 'gt') rows = rows.filter((r) => r.id > value);
        else throw new Error(`unexpected id filter ${f}`);
      }
      rows.sort((a, b) => (a.id < b.id ? -1 : 1));
      const limit = Math.min(Number(url.searchParams.get('limit') ?? MAX_ROWS), MAX_ROWS);
      return Promise.resolve(Response.json(rows.slice(0, limit)));
    }
    if (url.pathname.endsWith('/dose_events') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Array<{ medication_id: string }>;
      for (const r of body) insertedMedicationIds.add(r.medication_id);
      return Promise.resolve(Response.json(body.map((_, i) => ({ id: String(i) }))));
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchImpl: fetchImpl as typeof fetch, urls, insertedMedicationIds };
}

const SECRET = 'cron-secret-for-store-tests';
const NOW = new Date('2026-11-16T06:00:00.000Z');

function run(store: ReturnType<typeof createPostgrestStore>, body?: unknown) {
  const handler = createMaterializeDosesHandler({ cronSecret: SECRET, now: () => NOW, store });
  return handler(
    new Request('http://localhost/functions/v1/materialize-doses', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

Deno.test(
  'the hourly run reads every active medicine, past the 1000-row PostgREST cap',
  async () => {
    const total = 2 * MAX_ROWS + 7;
    const pg = fakePostgrest(total);
    const store = createPostgrestStore('http://supabase.test', 'service-key', pg.fetchImpl);

    const listed = await store.listActiveMedications();
    assert(listed.length === total, `expected ${total} medicines, got ${listed.length}`);
    assert(new Set(listed.map((m) => m.id)).size === total, 'no medicine is listed twice');
    assert(MEDICATION_PAGE_SIZE <= MAX_ROWS, 'page size must not exceed max_rows');

    const res = await run(store);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      pg.insertedMedicationIds.size === total,
      `every medicine gets doses: ${pg.insertedMedicationIds.size} of ${total}`,
    );
  },
);

Deno.test(
  'a trigger request for one medication_id finds it directly, however many exist',
  async () => {
    const total = 3 * MAX_ROWS;
    const pg = fakePostgrest(total);
    const store = createPostgrestStore('http://supabase.test', 'service-key', pg.fetchImpl);
    const target = medId(total); // the last one, beyond any single page

    const res = await run(store, { medication_id: target });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      pg.insertedMedicationIds.size === 1 && pg.insertedMedicationIds.has(target),
      `only the named medicine gets doses, got ${[...pg.insertedMedicationIds].join(',')}`,
    );
    const listCalls = pg.urls.filter((u) => u.includes('/medications'));
    assert(listCalls.length === 1, `one lookup, got ${listCalls.length}`);
    assert(
      (listCalls[0] ?? '').includes(`id=eq.${target}`),
      'the lookup filters by id in the query',
    );
  },
);
