import type { SummarizeVisitOutput } from '@carecircle/ai-gateway';
import * as UI from '@carecircle/ui';
import { Stack } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import TabsLayout from '../app/(tabs)/_layout';
import MedsScreen from '../app/(tabs)/meds';
import TodayScreen from '../app/(tabs)/today';
import VisitNewRoute from '../app/visit/new';
import en from '../i18n/en.json';
import * as MedsApi from './features/meds/api';
import * as ObservabilityApi from './features/observability/api';
import { memoryTodayStorage, resetTodayState } from './features/today/api';
import * as VisitApi from './features/visit/api';
import { resolveLocalMidnightInTimezoneToUtc, type VisitScreenDeps } from './features/visit';

const CIRCLE_ID = 'c1c00001-0000-4000-8000-000000000001';
const OWNER_ID = 'c1000001-0000-4000-8000-00000000000a';
const HELPER_ID = 'c1000001-0000-4000-8000-00000000000c';
const VIEWER_ID = 'c1000001-0000-4000-8000-00000000000b';
const MED_METFORMIN_ID = 'c1200001-0000-4000-8000-000000000001';
const MED_ASPIRIN_ID = 'c1200001-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-15T12:00:00.000Z');

type Row = Record<string, unknown>;

function seedTables(timezone = 'America/New_York'): Record<string, Row[]> {
  return {
    circles: [
      {
        id: CIRCLE_ID,
        name: 'Family Care',
        care_recipient_name: 'Evelyn',
        care_recipient_dob: null,
        timezone,
        created_by: OWNER_ID,
        created_at: '2026-11-01T12:00:00.000Z',
      },
    ],
    circle_members: [
      { circle_id: CIRCLE_ID, user_id: OWNER_ID, role: 'owner', joined_at: '2026-11-01T12:00:00Z' },
      {
        circle_id: CIRCLE_ID,
        user_id: HELPER_ID,
        role: 'helper',
        joined_at: '2026-11-02T12:00:00Z',
      },
      {
        circle_id: CIRCLE_ID,
        user_id: VIEWER_ID,
        role: 'viewer',
        joined_at: '2026-11-03T12:00:00Z',
      },
    ],
    medications: [
      {
        id: MED_METFORMIN_ID,
        circle_id: CIRCLE_ID,
        name: 'Metformin',
        strength: '500 mg',
        dose_text: '1 tablet',
        schedule: { kind: 'daily', times: ['08:00', '20:00'] },
        instructions: 'Take with meals',
        start_date: '2026-11-01',
        end_date: null,
        active: true,
        source: 'manual',
      },
      {
        id: MED_ASPIRIN_ID,
        circle_id: CIRCLE_ID,
        name: 'Aspirin',
        strength: '81 mg',
        dose_text: '1 tablet',
        schedule: { kind: 'daily', times: ['09:00'] },
        instructions: null,
        start_date: '2026-11-01',
        end_date: null,
        active: true,
        source: 'manual',
      },
    ],
    dose_events: [],
    appointments: [],
    tasks: [],
    visit_notes: [],
  };
}

function createVisitFakeClient(opts: {
  tables: Record<string, Row[]>;
  userId: string;
  writeError?: (table: string, op: 'insert' | 'update', values: Row) => { message: string } | null;
}) {
  let seq = 1;
  const writes: Array<{ table: string; op: 'insert' | 'update'; values: Row }> = [];

  function from(table: string) {
    const filters: Array<[op: 'eq' | 'gte' | 'lte', col: string, val: unknown]> = [];
    let pendingOp: 'select' | 'insert' | 'update' = 'select';
    let pendingValues: Row | null = null;
    let limitN: number | null = null;

    const run = () => {
      if (pendingOp === 'insert' && pendingValues) {
        writes.push({ table, op: 'insert', values: pendingValues });
        const err = opts.writeError?.(table, 'insert', pendingValues) ?? null;
        if (err) return { data: null, error: err };

        const id = `c1990000-0000-4000-8000-${String(seq++).padStart(12, '0')}`;
        let created: Row;
        if (table === 'visit_notes') {
          created = {
            id,
            circle_id: pendingValues.circle_id,
            appointment_id: pendingValues.appointment_id ?? null,
            transcript: pendingValues.transcript ?? null,
            summary: pendingValues.summary ?? null,
            created_by: opts.userId,
            created_at: NOW.toISOString(),
          };
        } else if (table === 'tasks') {
          created = {
            id,
            circle_id: pendingValues.circle_id,
            title: pendingValues.title,
            due_at: pendingValues.due_at ?? null,
            assignee: pendingValues.assignee ?? null,
            done_at: null,
            done_by: null,
            source: pendingValues.source,
          };
        } else {
          created = {
            id,
            strength: null,
            instructions: null,
            start_date: '2026-11-15',
            end_date: null,
            active: true,
            ...pendingValues,
          };
        }
        const rows = opts.tables[table] ?? [];
        rows.push(created);
        opts.tables[table] = rows;
        return { data: [created], error: null };
      }

      if (pendingOp === 'update' && pendingValues) {
        writes.push({ table, op: 'update', values: pendingValues });
        const err = opts.writeError?.(table, 'update', pendingValues) ?? null;
        if (err) return { data: null, error: err };

        const updated: Row[] = [];
        opts.tables[table] = (opts.tables[table] ?? []).map((row) => {
          const match = filters.every(([op, col, val]) => (op === 'eq' ? row[col] === val : true));
          if (!match) return row;
          const next = { ...row, ...pendingValues };
          updated.push(next);
          return next;
        });
        return { data: updated, error: null };
      }

      let rows = [...(opts.tables[table] ?? [])];
      for (const [op, col, val] of filters) {
        rows = rows.filter((r) => {
          if (op === 'eq') return r[col] === val;
          const a = new Date(String(r[col])).getTime();
          const b = new Date(String(val)).getTime();
          return op === 'gte' ? a >= b : a <= b;
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    };

    const builder = {
      select: () => builder,
      insert: (v: Row) => {
        pendingOp = 'insert';
        pendingValues = v;
        return builder;
      },
      update: (v: Row) => {
        pendingOp = 'update';
        pendingValues = v;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push(['eq', col, val]);
        return builder;
      },
      gte: (col: string, val: unknown) => {
        filters.push(['gte', col, val]);
        return builder;
      },
      lte: (col: string, val: unknown) => {
        filters.push(['lte', col, val]);
        return builder;
      },
      order: () => builder,
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      then: <T,>(resolve: (val: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) => {
        try {
          return Promise.resolve(resolve(run()));
        } catch (e) {
          return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
        }
      },
    };
    return builder;
  }

  return {
    client: { from, rpc: async () => ({ data: null, error: null }) } as never,
    writes,
  };
}

const SAMPLE_DRAFT: SummarizeVisitOutput = {
  summary: 'Blood pressure is stable. Book a blood test in two weeks and stop Aspirin.',
  followUps: [
    { title: 'Book blood test', dueHint: 'in 2 weeks', dueDate: '2026-11-15' },
    { title: 'Check home cuff batteries', dueHint: null, dueDate: null },
  ],
  medChanges: [
    {
      action: 'stop',
      medicationId: MED_ASPIRIN_ID,
      name: 'Aspirin',
      detail: 'Stop until next visit',
    },
  ],
  questionsToAsk: ['Should blood pressure be logged twice daily?'],
};

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <UI.ThemeProvider>{children}</UI.ThemeProvider>
);

async function press(testID: string) {
  await fireEvent.press(within(screen.getByTestId(testID)).getByRole('button'));
}

beforeEach(() => {
  resetTodayState();
  delete process.env.MOCKS;
  delete process.env.EXPO_PUBLIC_MOCKS;
  jest.restoreAllMocks();
});

describe('CC-5b Visit note review and save (real router)', () => {
  it('writes nothing before Save, disables Save until every item is decided, applies accepted stop, ignores rejected items, sets source="visit_note" with timezone midnight due_at, and sends counts-only analytics', async () => {
    const tables = seedTables('America/New_York');
    const fake = createVisitFakeClient({ tables, userId: OWNER_ID });

    const saveNoteSpy = jest.spyOn(VisitApi, 'saveVisitNoteRow');
    const saveTaskSpy = jest.spyOn(VisitApi, 'saveFollowUpTask');
    const pauseMedSpy = jest.spyOn(MedsApi, 'pauseMedication');
    const updateMedSpy = jest.spyOn(MedsApi, 'updateMedication');
    const addMedSpy = jest.spyOn(MedsApi, 'addMedication');

    const trackedEvents: Array<{ event: string; props: unknown }> = [];
    jest.spyOn(ObservabilityApi, 'getAppObservability').mockReturnValue({
      analytics: {
        track: jest.fn(async (event: string, props: unknown) => {
          trackedEvents.push({ event, props });
        }),
      },
    } as never);

    let capturedGatewayInput: unknown = null;
    const deps: VisitScreenDeps = {
      getClient: () => fake.client,
      getUserId: async () => OWNER_ID,
      storage: memoryTodayStorage,
      now: () => NOW,
      callSummarizeVisit: async (input) => {
        capturedGatewayInput = input;
        return { ok: true, output: SAMPLE_DRAFT, model: 'fake', latencyMs: 10 };
      },
    };

    const routes = {
      _layout: () => <Stack screenOptions={{ headerShown: false }} />,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/today': () => <TodayScreen deps={deps} referenceNow={NOW} />,
      '(tabs)/meds': () => <MedsScreen deps={deps} />,
      'visit/new': () => <VisitNewRoute deps={deps} />,
    };

    await renderRouter(routes, { initialUrl: '/today', wrapper });

    // Owner sees the "New visit note" button on Today and opens /visit/new
    await waitFor(() => expect(screen.getByTestId('today-new-visit-note-button')).toBeTruthy());
    await press('today-new-visit-note-button');
    await waitFor(() => expect(screen.getByTestId('visit-new-screen')).toBeTruthy());
    expect(screen).toHavePathname('/visit/new');

    // common.notMedicalAdvice is rendered on /visit/new
    expect(screen.getByTestId('visit-not-medical-advice')).toHaveTextContent(
      en.common.notMedicalAdvice,
    );

    // Type visit note and tap Summarise
    await fireEvent.changeText(
      screen.getByTestId('visit-notes-text-input'),
      'Patient blood pressure is stable. Stop Aspirin and book blood test.',
    );
    await press('visit-summarise-button');

    await waitFor(() => expect(screen.getByTestId('visit-draft-review')).toBeTruthy());

    // Summarise sent circleId and active medications as knownMeds
    expect(capturedGatewayInput).toEqual({
      circleId: CIRCLE_ID,
      text: 'Patient blood pressure is stable. Stop Aspirin and book blood test.',
      knownMeds: [
        { id: MED_METFORMIN_ID, name: 'Metformin', strength: '500 mg' },
        { id: MED_ASPIRIN_ID, name: 'Aspirin', strength: '81 mg' },
      ],
    });

    // Questions to ask are rendered read-only
    expect(screen.getByTestId('visit-question-0')).toHaveTextContent(
      /Should blood pressure be logged twice daily\?/,
    );

    // Nothing has been written to the database before Save is tapped
    expect(fake.writes).toHaveLength(0);
    expect(saveNoteSpy).not.toHaveBeenCalled();
    expect(saveTaskSpy).not.toHaveBeenCalled();
    expect(pauseMedSpy).not.toHaveBeenCalled();
    expect(updateMedSpy).not.toHaveBeenCalled();
    expect(addMedSpy).not.toHaveBeenCalled();

    // Save is disabled until every follow-up and every med change is accepted or rejected
    const saveButton = () => within(screen.getByTestId('visit-save-button')).getByRole('button');
    expect(saveButton().props.accessibilityState?.disabled).toBe(true);

    // Accept follow-up 0, reject follow-up 1 -> Save still disabled because med change 0 is undecided
    await press('visit-followup-accept-0');
    await press('visit-followup-reject-1');
    expect(saveButton().props.accessibilityState?.disabled).toBe(true);

    // Edit follow-up 0 title and due date
    await fireEvent.changeText(
      screen.getByTestId('visit-followup-title-0'),
      'Book fasting blood test',
    );
    await fireEvent.changeText(screen.getByTestId('visit-followup-due-date-0'), '2026-11-15');

    // Accept med change 0 (stop Aspirin) -> all items decided, Save becomes enabled
    await press('visit-med-change-accept-0');
    expect(saveButton().props.accessibilityState?.disabled).toBe(false);

    // Still zero writes before Save is tapped
    expect(fake.writes).toHaveLength(0);

    // Tap Save
    await press('visit-save-button');

    // Returns to Today where the new visit_note task due on 2026-11-15 in America/New_York is shown
    await waitFor(() => expect(screen).toHavePathname('/today'));

    // 1. One visit_notes row saved
    expect(tables.visit_notes).toHaveLength(1);
    expect(tables.visit_notes![0]).toMatchObject({
      circle_id: CIRCLE_ID,
      transcript: 'Patient blood pressure is stable. Stop Aspirin and book blood test.',
      summary: SAMPLE_DRAFT.summary,
      created_by: OWNER_ID,
    });

    // 2. Only the accepted follow-up was written (rejected follow-up 1 was NOT written),
    // with source: 'visit_note' and due_at = 2026-11-15 00:00 America/New_York (EST = UTC-5 -> 05:00:00.000Z)
    expect(tables.tasks).toHaveLength(1);
    expect(tables.tasks![0]).toMatchObject({
      circle_id: CIRCLE_ID,
      title: 'Book fasting blood test',
      source: 'visit_note',
      due_at: '2026-11-15T05:00:00.000Z',
    });

    // 3. Accepted `stop` paused only Aspirin; Metformin stays active
    const metformin = tables.medications!.find((m) => m.id === MED_METFORMIN_ID);
    const aspirin = tables.medications!.find((m) => m.id === MED_ASPIRIN_ID);
    expect(metformin?.active).toBe(true);
    expect(aspirin?.active).toBe(false);

    // 4. Analytics event has counts only (no summary, transcript, or medication name)
    expect(trackedEvents).toEqual([
      {
        event: 'cc_visit_note_saved',
        props: { followUps: 1, medChanges: 1 },
      },
    ]);
    expect(JSON.stringify(trackedEvents)).not.toContain('Aspirin');
    expect(JSON.stringify(trackedEvents)).not.toContain('blood');
  });

  it('change_dose and start open the existing edit and add medication forms pre-filled, and write nothing to medications until those forms are saved', async () => {
    const tables = seedTables('Europe/London');
    const fake = createVisitFakeClient({ tables, userId: HELPER_ID });

    const draftWithChangeAndStart: SummarizeVisitOutput = {
      summary: 'Increase Metformin to 2 tablets and start Vitamin D3.',
      followUps: [],
      medChanges: [
        {
          action: 'change_dose',
          medicationId: MED_METFORMIN_ID,
          name: 'Metformin',
          detail: 'Increase to 2 tablets twice daily',
        },
        {
          action: 'start',
          medicationId: null,
          name: 'Vitamin D3',
          detail: '1000 IU once daily',
        },
      ],
      questionsToAsk: [],
    };

    const deps: VisitScreenDeps = {
      getClient: () => fake.client,
      getUserId: async () => HELPER_ID,
      storage: memoryTodayStorage,
      now: () => NOW,
      trackMedAdded: () => undefined,
      trackVisitNoteSaved: () => undefined,
      callSummarizeVisit: async () => ({
        ok: true,
        output: draftWithChangeAndStart,
        model: 'fake',
        latencyMs: 10,
      }),
    };

    const routes = {
      _layout: () => <Stack screenOptions={{ headerShown: false }} />,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/today': () => <TodayScreen deps={deps} referenceNow={NOW} />,
      '(tabs)/meds': () => <MedsScreen deps={deps} />,
      'visit/new': () => <VisitNewRoute deps={deps} />,
    };

    await renderRouter(routes, { initialUrl: '/visit/new', wrapper });

    await waitFor(() => expect(screen.getByTestId('visit-notes-text-input')).toBeTruthy());
    await fireEvent.changeText(
      screen.getByTestId('visit-notes-text-input'),
      'Increase Metformin and start Vitamin D3.',
    );
    await press('visit-summarise-button');
    await waitFor(() => expect(screen.getByTestId('visit-draft-review')).toBeTruthy());

    await press('visit-med-change-accept-0');
    await press('visit-med-change-accept-1');
    await press('visit-save-button');

    // 1. First form opened is the pre-filled edit form for Metformin (change_dose), with the change shown on top
    await waitFor(() => expect(screen.getByTestId('meds-form')).toBeTruthy());
    expect(screen.getByTestId('visit-med-form-change-banner')).toHaveTextContent(
      /Increase to 2 tablets twice daily/,
    );
    expect(screen.getByTestId('meds-name-input').props.value).toBe('Metformin');
    expect(screen.getByTestId('meds-strength-input').props.value).toBe('500 mg');
    expect(screen.getByTestId('meds-dose-text-input').props.value).toBe('1 tablet');
    expect(screen.getByTestId('meds-times-input').props.value).toBe('08:00, 20:00');

    // No medication updates or inserts have happened yet!
    expect(fake.writes.filter((w) => w.table === 'medications')).toHaveLength(0);

    // User confirms new dose on the edit form and saves
    await fireEvent.changeText(screen.getByTestId('meds-dose-text-input'), '2 tablets');
    await press('meds-save-button');

    // Now Metformin is updated, and the second form opens: pre-filled add form for Vitamin D3 (start)
    await waitFor(() =>
      expect(screen.getByTestId('visit-med-form-change-banner')).toHaveTextContent(
        /1000 IU once daily/,
      ),
    );
    expect(screen.getByTestId('meds-name-input').props.value).toBe('Vitamin D3');
    expect(screen.getByTestId('meds-dose-text-input').props.value).toBe('');

    // Vitamin D3 has STILL not been inserted until the user saves the add form!
    expect(fake.writes.filter((w) => w.table === 'medications' && w.op === 'insert')).toHaveLength(
      0,
    );

    // User fills dose text on the add form and saves -> inserted with source: 'manual'
    await fireEvent.changeText(screen.getByTestId('meds-dose-text-input'), '1 capsule');
    await press('meds-save-button');

    await waitFor(() => expect(screen).toHavePathname('/today'));

    const medInserts = fake.writes.filter((w) => w.table === 'medications' && w.op === 'insert');
    expect(medInserts).toHaveLength(1);
    expect(medInserts[0]?.values).toMatchObject({
      circle_id: CIRCLE_ID,
      name: 'Vitamin D3',
      dose_text: '1 capsule',
      source: 'manual',
    });
  });

  it('viewer sees no New visit note button on Today', async () => {
    const tables = seedTables();
    const fake = createVisitFakeClient({ tables, userId: VIEWER_ID });
    const deps: VisitScreenDeps = {
      getClient: () => fake.client,
      getUserId: async () => VIEWER_ID,
      storage: memoryTodayStorage,
      now: () => NOW,
    };

    const routes = {
      _layout: () => <Stack screenOptions={{ headerShown: false }} />,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/today': () => <TodayScreen deps={deps} referenceNow={NOW} />,
      '(tabs)/meds': () => <MedsScreen deps={deps} />,
      'visit/new': () => <VisitNewRoute deps={deps} />,
    };

    await renderRouter(routes, { initialUrl: '/today', wrapper });
    await waitFor(() => expect(screen.getByTestId('today-empty-state')).toBeTruthy());
    expect(screen.queryByTestId('today-new-visit-note-button')).toBeNull();
  });

  it('viewer sees no controls on /visit/new', async () => {
    const tables = seedTables();
    const fake = createVisitFakeClient({ tables, userId: VIEWER_ID });
    const deps: VisitScreenDeps = {
      getClient: () => fake.client,
      getUserId: async () => VIEWER_ID,
      storage: memoryTodayStorage,
      now: () => NOW,
    };

    const routes = {
      _layout: () => <Stack screenOptions={{ headerShown: false }} />,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/today': () => <TodayScreen deps={deps} referenceNow={NOW} />,
      '(tabs)/meds': () => <MedsScreen deps={deps} />,
      'visit/new': () => <VisitNewRoute deps={deps} />,
    };

    await renderRouter(routes, { initialUrl: '/visit/new', wrapper });
    await waitFor(() => expect(screen.getByTestId('visit-viewer-restricted')).toBeTruthy());
    expect(screen.queryByTestId('visit-record-button')).toBeNull();
    expect(screen.queryByTestId('visit-notes-text-input')).toBeNull();
    expect(screen.queryByTestId('visit-summarise-button')).toBeNull();
    expect(screen.queryByTestId('visit-save-button')).toBeNull();
  });

  it('opens the paywall sheet when the gateway returns QUOTA_EXCEEDED, and shows partial save state when one write fails after visit_notes succeeds', async () => {
    const tables = seedTables();
    let failTaskInsert = true;
    const fake = createVisitFakeClient({
      tables,
      userId: OWNER_ID,
      writeError: (table, op) =>
        table === 'tasks' && op === 'insert' && failTaskInsert
          ? { message: 'task insert failed' }
          : null,
    });

    let quotaFail = true;
    const deps: VisitScreenDeps = {
      getClient: () => fake.client,
      getUserId: async () => OWNER_ID,
      storage: memoryTodayStorage,
      now: () => NOW,
      trackVisitNoteSaved: () => undefined,
      callSummarizeVisit: async () =>
        quotaFail
          ? {
              ok: false,
              error: { code: 'QUOTA_EXCEEDED', message: 'Upgrade required', retryable: false },
            }
          : { ok: true, output: SAMPLE_DRAFT, model: 'fake', latencyMs: 10 },
    };

    const routes = {
      _layout: () => <Stack screenOptions={{ headerShown: false }} />,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/today': () => <TodayScreen deps={deps} referenceNow={NOW} />,
      '(tabs)/meds': () => <MedsScreen deps={deps} />,
      'visit/new': () => <VisitNewRoute deps={deps} />,
    };

    await renderRouter(routes, { initialUrl: '/visit/new', wrapper });
    await waitFor(() => expect(screen.getByTestId('visit-notes-text-input')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('visit-notes-text-input'), 'Visit summary note');
    await press('visit-summarise-button');

    // QUOTA_EXCEEDED opens PaywallSheet modal
    await waitFor(() => expect(screen.getByTestId('paywall-sheet')).toBeTruthy());
    expect(screen.getByText(en.paywall.title)).toBeTruthy();

    // Close PaywallSheet modal -> quota error card is visible underneath
    await fireEvent.press(screen.getByText(en.gallery.sheetClose));
    await waitFor(() => expect(screen.getByTestId('visit-error-quota')).toBeTruthy());

    // Now succeed on Summarise and test partial failure on Save
    quotaFail = false;
    await press('visit-summarise-button');
    await waitFor(() => expect(screen.getByTestId('visit-draft-review')).toBeTruthy());

    await press('visit-followup-accept-0');
    await press('visit-followup-reject-1');
    await press('visit-med-change-reject-0');
    await press('visit-save-button');

    // visit_notes succeeded, tasks failed -> shows partial save notice, NEVER blanket "Not saved"
    await waitFor(() => expect(screen.getByTestId('visit-partial-save-notice')).toBeTruthy());
    expect(screen.queryByTestId('visit-not-saved-notice')).toBeNull();
    expect(screen.getByTestId('visit-saved-parts')).toHaveTextContent(/Visit note/);
    expect(screen.getByTestId('visit-unsaved-parts')).toHaveTextContent(/Book blood test/);
    expect(tables.visit_notes).toHaveLength(1);

    // Retry Save: does not insert a duplicate visit_notes row, only retries the failed task
    failTaskInsert = false;
    await press('visit-save-button');
    await waitFor(() => expect(screen).toHavePathname('/today'));
    expect(tables.visit_notes).toHaveLength(1);
    expect(tables.tasks).toHaveLength(1);
  });

  it('shows the recording timer counting toward 10:00 with Stop button, and guards Save against double taps', async () => {
    const tables = seedTables();
    const fake = createVisitFakeClient({ tables, userId: OWNER_ID });

    let stopCalled = false;
    const deps: VisitScreenDeps = {
      getClient: () => fake.client,
      getUserId: async () => OWNER_ID,
      storage: memoryTodayStorage,
      now: () => NOW,
      trackVisitNoteSaved: () => undefined,
      startRecording: async () => ({
        stop: async () => {
          stopCalled = true;
          return {
            uri: 'file:///cache/visit.m4a',
            bytes: new Uint8Array([1, 2, 3, 4]),
            durationMs: 12_000,
            contentType: 'audio/m4a',
            autoStopped: false,
          };
        },
        uploadAndDeleteLocal: async () => ({
          audioPath: `${CIRCLE_ID}/11111111-1111-4111-8111-111111111111.m4a`,
          durationMs: 12_000,
          autoStopped: false,
        }),
      }),
      callSummarizeVisit: async () => ({
        ok: true,
        output: {
          summary: 'Recorded summary.',
          followUps: [],
          medChanges: [],
          questionsToAsk: [],
        },
        model: 'fake',
        latencyMs: 10,
      }),
    };

    const routes = {
      _layout: () => <Stack screenOptions={{ headerShown: false }} />,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/today': () => <TodayScreen deps={deps} referenceNow={NOW} />,
      '(tabs)/meds': () => <MedsScreen deps={deps} />,
      'visit/new': () => <VisitNewRoute deps={deps} />,
    };

    await renderRouter(routes, { initialUrl: '/visit/new', wrapper });
    await waitFor(() => expect(screen.getByTestId('visit-record-button')).toBeTruthy());

    await press('visit-record-button');
    await waitFor(() => expect(screen.getByTestId('visit-recording-timer')).toBeTruthy());
    expect(screen.getByTestId('visit-recording-timer')).toHaveTextContent(/00:00 \/ 10:00/);

    await press('visit-stop-record-button');
    await waitFor(() => expect(screen.getByTestId('visit-recording-ready')).toBeTruthy());
    expect(stopCalled).toBe(true);

    await press('visit-summarise-button');
    await waitFor(() => expect(screen.getByTestId('visit-draft-review')).toBeTruthy());

    const saveBtn = within(screen.getByTestId('visit-save-button')).getByRole('button');
    await act(async () => {
      fireEvent.press(saveBtn);
      fireEvent.press(saveBtn);
    });

    await waitFor(() => expect(screen).toHavePathname('/today'));
    expect(tables.visit_notes).toHaveLength(1);
  });

  it('resolves local midnight to UTC across timezones and DST boundaries', () => {
    expect(resolveLocalMidnightInTimezoneToUtc('2026-11-15', 'America/New_York')).toBe(
      '2026-11-15T05:00:00.000Z',
    );
    expect(resolveLocalMidnightInTimezoneToUtc('2026-07-15', 'America/New_York')).toBe(
      '2026-07-15T04:00:00.000Z',
    );
    expect(resolveLocalMidnightInTimezoneToUtc('2026-11-15', 'Asia/Tokyo')).toBe(
      '2026-11-14T15:00:00.000Z',
    );
  });
});
