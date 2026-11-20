import {
  createExportLogHandler,
  createPostgrestExportLogStore,
  type CircleMetadataRow,
  type ExportLogAuditEvent,
  type ExportLogStorage,
  type ExportLogStore,
  type LogEntryRow,
} from './handler.ts';
import { extractTextFromPdfBytes } from './pdf.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

const CIRCLE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const VIEWER_ID = '33333333-3333-4333-8333-333333333333';
const STRANGER_ID = '44444444-4444-4444-8444-444444444444';
const EXPORT_UUID = '55555555-5555-4555-8555-555555555555';

function makeFixtureEntries30Days(): LogEntryRow[] {
  const types = ['dose', 'med_change', 'appointment', 'task', 'visit_note', 'member'] as const;
  const entries: LogEntryRow[] = [];
  for (let i = 0; i < 35; i += 1) {
    const day = (i % 30) + 1;
    const dayPadded = String(day).padStart(2, '0');
    const type = types[i % types.length] ?? 'dose';
    entries.push({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      circle_id: CIRCLE_ID,
      type,
      ref_id: null,
      summary: `Entry #${i + 1} summary for ${type}`,
      created_by: i % 2 === 0 ? OWNER_ID : VIEWER_ID,
      created_at: `2026-11-${dayPadded}T14:30:00.000Z`,
    });
  }
  return entries;
}

function createFakeDeps(overrides?: {
  memberRoles?: Record<string, 'owner' | 'helper' | 'viewer'>;
  familyActive?: boolean;
  entries?: LogEntryRow[];
}) {
  const memberRoles: Record<string, 'owner' | 'helper' | 'viewer'> = overrides?.memberRoles ?? {
    [OWNER_ID]: 'owner',
    [VIEWER_ID]: 'viewer',
  };
  const familyActive = overrides?.familyActive ?? true;
  const entries = overrides?.entries ?? makeFixtureEntries30Days();

  let getCircleCalls = 0;
  let listLogEntriesCalls = 0;
  let getDisplayNamesCalls = 0;
  let uploadedObject: { path: string; bytes: Uint8Array } | null = null;
  let signedUrlCall: { path: string; expiresIn: number } | null = null;
  const auditEvents: ExportLogAuditEvent[] = [];

  const store: ExportLogStore = {
    async isCircleMember(userId, circleId) {
      if (circleId !== CIRCLE_ID) return false;
      return Boolean(memberRoles[userId]);
    },
    async getCircle(circleId): Promise<CircleMetadataRow | null> {
      getCircleCalls += 1;
      if (circleId !== CIRCLE_ID) return null;
      return {
        id: CIRCLE_ID,
        name: 'bensalem Family Circle',
        care_recipient_name: 'Nadia Bensalem',
        timezone: 'America/New_York',
      };
    },
    async listLogEntries() {
      listLogEntriesCalls += 1;
      return entries;
    },
    async getDisplayNames() {
      getDisplayNamesCalls += 1;
      return {
        [OWNER_ID]: 'Leila Bensalem',
        [VIEWER_ID]: 'Karim Bensalem',
      };
    },
  };

  const storage: ExportLogStorage = {
    async uploadPdf(opts) {
      uploadedObject = opts;
    },
    async createSignedUrl(opts) {
      signedUrlCall = opts;
      return `https://storage.example.test/log-exports/${opts.path}?exp=${opts.expiresIn}`;
    },
  };

  const handler = createExportLogHandler({
    verifyJwt: async (token) => {
      if (token === 'token-owner') return { userId: OWNER_ID };
      if (token === 'token-viewer') return { userId: VIEWER_ID };
      if (token === 'token-stranger') return { userId: STRANGER_ID };
      return null;
    },
    store,
    storage,
    entitlementStore: {
      async getCircleOwnerUserId(circleId) {
        return { data: circleId === CIRCLE_ID ? OWNER_ID : null, error: null };
      },
      async getEntitlement(userId, entitlement) {
        if (userId === OWNER_ID && entitlement === 'carecircle_family' && familyActive) {
          return {
            data: {
              user_id: OWNER_ID,
              entitlement: 'carecircle_family',
              active: true,
              expires_at: '2027-01-01T00:00:00.000Z',
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    },
    now: () => new Date('2026-11-30T12:00:00.000Z'),
    randomUuid: () => EXPORT_UUID,
    onLogExported: (ev) => auditEvents.push(ev),
  });

  return {
    handler,
    getStats: () => ({
      getCircleCalls,
      listLogEntriesCalls,
      getDisplayNamesCalls,
      uploadedObject,
      signedUrlCall,
      auditEvents,
    }),
  };
}

function makeRequest(body: unknown, token = 'token-owner'): Request {
  return new Request('https://example.test/functions/v1/export-log', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

Deno.test('refuses non-member with 403 and no detail before reading circle data', async () => {
  const { handler, getStats } = createFakeDeps();
  const res = await handler(
    makeRequest(
      {
        circleId: CIRCLE_ID,
        from: '2026-11-01',
        to: '2026-11-30',
      },
      'token-stranger',
    ),
  );
  assert(res.status === 403, `expected 403, got ${res.status}`);
  const payload = await res.json();
  assert(payload.ok === false, 'expected ok: false');
  assert(
    !JSON.stringify(payload).includes('Nadia'),
    'must not leak care recipient name or circle details',
  );
  const stats = getStats();
  assert(stats.getCircleCalls === 0, 'getCircle must not be called for non-member');
  assert(stats.listLogEntriesCalls === 0, 'listLogEntries must not be called for non-member');
});

Deno.test('allows viewer member on Family plan and signs URL for 3600 seconds', async () => {
  const { handler, getStats } = createFakeDeps();
  const res = await handler(
    makeRequest(
      {
        circleId: CIRCLE_ID,
        from: '2026-11-01',
        to: '2026-11-30',
      },
      'token-viewer',
    ),
  );
  assert(res.status === 200, `expected 200 for viewer, got ${res.status}`);
  const payload = (await res.json()) as { ok: boolean; pdfUrl: string };
  assert(payload.ok === true, 'expected ok: true');
  assert(
    payload.pdfUrl ===
      `https://storage.example.test/log-exports/${CIRCLE_ID}/${EXPORT_UUID}.pdf?exp=3600`,
    `unexpected pdfUrl: ${payload.pdfUrl}`,
  );

  const stats = getStats();
  assert(
    stats.uploadedObject?.path === `${CIRCLE_ID}/${EXPORT_UUID}.pdf`,
    'uploaded path must be {circleId}/{uuid}.pdf',
  );
  assert(stats.signedUrlCall?.expiresIn === 3600, 'signed URL expiry must be 3600 seconds');
  assert(stats.auditEvents.length === 1, 'must emit 1 audit event');
  const auditJson = JSON.stringify(stats.auditEvents[0]);
  assert(!auditJson.includes('Nadia'), 'audit log must never include care recipient name');
  assert(!auditJson.includes('Entry #1'), 'audit log must never include PDF content');
});

Deno.test(
  'refuses free plan with 402 QUOTA_EXCEEDED before reading any circle or log data (even with forged body field)',
  async () => {
    const { handler, getStats } = createFakeDeps({ familyActive: false });
    const res = await handler(
      makeRequest(
        {
          circleId: CIRCLE_ID,
          from: '2026-11-01',
          to: '2026-11-30',
          entitlements: { carecircle_family: true, active: true },
        },
        'token-owner',
      ),
    );
    assert(res.status === 402, `expected 402 on free plan, got ${res.status}`);
    const payload = (await res.json()) as {
      ok: boolean;
      code?: string;
      error?: { code?: string };
    };
    assert(payload.ok === false, 'expected ok: false');
    assert(
      payload.code === 'QUOTA_EXCEEDED' && payload.error?.code === 'QUOTA_EXCEEDED',
      `expected QUOTA_EXCEEDED, got ${JSON.stringify(payload)}`,
    );

    const stats = getStats();
    assert(stats.getCircleCalls === 0, 'getCircle must not be called when free plan is refused');
    assert(
      stats.listLogEntriesCalls === 0,
      'listLogEntries must not be called when free plan is refused',
    );
    assert(
      stats.getDisplayNamesCalls === 0,
      'getDisplayNames must not be called when free plan is refused',
    );
    assert(stats.uploadedObject === null, 'no PDF may be uploaded on free plan');
  },
);

Deno.test('refuses 91-day range with 400 RANGE_INVALID and allows 90-day range', async () => {
  const { handler, getStats } = createFakeDeps();

  // 2026-01-01 to 2026-04-01 inclusive = 31 (Jan) + 28 (Feb) + 31 (Mar) + 1 (Apr) = 91 days
  const res91 = await handler(
    makeRequest({
      circleId: CIRCLE_ID,
      from: '2026-01-01',
      to: '2026-04-01',
    }),
  );
  assert(res91.status === 400, `expected 400 for 91 days, got ${res91.status}`);
  const body91 = await res91.json();
  assert(
    body91.error?.code === 'RANGE_INVALID',
    `expected RANGE_INVALID for 91 days, got ${JSON.stringify(body91)}`,
  );
  assert(getStats().listLogEntriesCalls === 0, 'must not read entries on invalid range');

  // 2026-01-01 to 2026-03-31 inclusive = 31 + 28 + 31 = 90 days
  const res90 = await handler(
    makeRequest({
      circleId: CIRCLE_ID,
      from: '2026-01-01',
      to: '2026-03-31',
    }),
  );
  assert(res90.status === 200, `expected 200 for 90 days, got ${res90.status}`);
});

Deno.test('refuses from after to with 400 RANGE_INVALID', async () => {
  const { handler, getStats } = createFakeDeps();
  const res = await handler(
    makeRequest({
      circleId: CIRCLE_ID,
      from: '2026-11-15',
      to: '2026-11-14',
    }),
  );
  assert(res.status === 400, `expected 400 when from > to, got ${res.status}`);
  const body = await res.json();
  assert(
    body.error?.code === 'RANGE_INVALID',
    `expected RANGE_INVALID when from > to, got ${JSON.stringify(body)}`,
  );
  assert(getStats().listLogEntriesCalls === 0, 'must not read entries when from > to');
});

Deno.test(
  'text extraction test: 30-day fixture circle PDF contains recipient name, date range, and one line per entry',
  async () => {
    const entries = makeFixtureEntries30Days();
    const { handler, getStats } = createFakeDeps({ entries });
    const res = await handler(
      makeRequest({
        circleId: CIRCLE_ID,
        from: '2026-11-01',
        to: '2026-11-30',
      }),
    );
    assert(res.status === 200, `expected 200, got ${res.status}`);

    const uploaded = getStats().uploadedObject;
    assert(uploaded !== null, 'PDF bytes must be uploaded');

    const extractedText = await extractTextFromPdfBytes(uploaded.bytes);
    assert(
      extractedText.includes('Care recipient: Nadia Bensalem'),
      `expected recipient name in extracted text, got:\n${extractedText}`,
    );
    assert(
      extractedText.includes('Date range: 2026-11-01 to 2026-11-30 (America/New_York)'),
      `expected date range in extracted text, got:\n${extractedText}`,
    );

    const entryLines = extractedText.split('\n').filter((line) => line.startsWith('[ENTRY] '));
    assert(
      entryLines.length === entries.length,
      `expected ${entries.length} [ENTRY] lines, found ${entryLines.length}`,
    );

    // Check first and last entry details in America/New_York (14:30 UTC in Nov is 09:30 EST)
    assert(
      entryLines[0]?.includes(
        '2026-11-01 09:30 | dose | Entry #1 summary for dose | Leila Bensalem',
      ),
      `unexpected first entry line: ${entryLines[0]}`,
    );
    assert(
      entryLines[entries.length - 1]?.includes('Entry #35 summary for visit_note | Leila Bensalem'),
      `unexpected last entry line: ${entryLines[entries.length - 1]}`,
    );
  },
);

Deno.test('PostgREST store pages log_entries in batches of 500 past 1000 rows', async () => {
  const totalRows = 1205;
  const allRows: LogEntryRow[] = Array.from({ length: totalRows }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    circle_id: CIRCLE_ID,
    type: 'dose',
    ref_id: null,
    summary: `Dose ${i + 1}`,
    created_by: OWNER_ID,
    created_at: '2026-11-10T10:00:00.000Z',
  }));

  const store = createPostgrestExportLogStore(
    async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '1000', 10);
      const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
      const slice = allRows.slice(offset, offset + Math.min(limit, 1000));
      return new Response(JSON.stringify(slice), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    (key) => {
      if (key === 'SUPABASE_URL') return 'https://supabase.example.test';
      if (key === 'SUPABASE_SERVICE_ROLE_KEY') return 'service-key';
      return undefined;
    },
  );

  const fetched = await store.listLogEntries({
    circleId: CIRCLE_ID,
    fromUtcIso: '2026-11-01T00:00:00.000Z',
    toExclusiveUtcIso: '2026-12-01T00:00:00.000Z',
  });
  assert(fetched.length === totalRows, `expected ${totalRows} rows, got ${fetched.length}`);
});
