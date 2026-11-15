import type { z } from 'zod';

interface CareCircleSchemasModule {
  memberRoleSchema: z.ZodType<'owner' | 'helper' | 'viewer'>;
  doseStatusSchema: z.ZodType<'pending' | 'given' | 'skipped' | 'missed'>;
  logTypeSchema: z.ZodType<
    'dose' | 'med_change' | 'appointment' | 'task' | 'visit_note' | 'member'
  >;
  medicationSourceSchema: z.ZodType<'manual' | 'photo'>;
  taskSourceSchema: z.ZodType<'manual' | 'visit_note'>;
  scheduleSchema: z.ZodType<unknown>;
  circleRowSchema: z.ZodType<unknown>;
  circleSchema: z.ZodType<unknown>;
  circleMemberRowSchema: z.ZodType<unknown>;
  circleMemberSchema: z.ZodType<unknown>;
  inviteRowSchema: z.ZodType<unknown>;
  inviteSchema: z.ZodType<unknown>;
  medicationRowSchema: z.ZodType<unknown>;
  medicationSchema: z.ZodType<unknown>;
  doseEventRowSchema: z.ZodType<unknown>;
  doseEventSchema: z.ZodType<unknown>;
  appointmentRowSchema: z.ZodType<unknown>;
  appointmentSchema: z.ZodType<unknown>;
  taskRowSchema: z.ZodType<unknown>;
  taskSchema: z.ZodType<unknown>;
  visitNoteRowSchema: z.ZodType<unknown>;
  visitNoteSchema: z.ZodType<unknown>;
  logEntryRowSchema: z.ZodType<unknown>;
  logEntrySchema: z.ZodType<unknown>;
  CARECIRCLE_MOCKS: {
    circle: Record<string, unknown>;
    members: Array<Record<string, unknown>>;
    medications: Array<Record<string, unknown>>;
    doseEvents: Array<Record<string, unknown>>;
    appointments: Array<Record<string, unknown>>;
    tasks: Array<Record<string, unknown>>;
    visitNotes: Array<Record<string, unknown>>;
    logEntries: Array<Record<string, unknown>>;
    aiResponses: {
      extractPrescription: Record<string, unknown>;
      summarizeVisit: Record<string, unknown>;
    };
  };
}

function loadCareCircleSchemas(): CareCircleSchemasModule {
  // Loaded at runtime so the tests-only PR typechecks before schemas/carecircle.ts exists.
  return jest.requireActual<CareCircleSchemasModule>('../schemas/carecircle');
}

describe('CC-0 C1 Zod schemas and mock dataset (@carecircle/core)', () => {
  it('accepts all 4 schedule JSON examples from the spec and rejects unknown kind or malformed schedules', () => {
    const { scheduleSchema } = loadCareCircleSchemas();

    const specExamples = [
      { kind: 'daily', times: ['08:00', '20:00'] },
      { kind: 'weekly', days: ['mon', 'thu'], times: ['09:00'] },
      { kind: 'every_n_days', n: 3, times: ['08:00'] },
      { kind: 'as_needed' },
    ];

    for (const example of specExamples) {
      const parsed = scheduleSchema.safeParse(example);
      expect(parsed.success).toBe(true);
    }

    const invalidSchedules = [
      { kind: 'monthly', times: ['08:00'] },
      { kind: 'hourly', n: 4 },
      { kind: '' },
      {},
      { kind: 'daily', times: [] },
      { kind: 'daily', times: ['8:00'] },
      { kind: 'daily', times: ['24:00'] },
      { kind: 'daily', times: ['08:60'] },
      { kind: 'daily', times: ['08:00'], extraField: true },
      { kind: 'weekly', days: [], times: ['09:00'] },
      { kind: 'weekly', days: ['monday'], times: ['09:00'] },
      { kind: 'weekly', days: ['mon'], times: [] },
      { kind: 'every_n_days', n: 0, times: ['08:00'] },
      { kind: 'every_n_days', n: -2, times: ['08:00'] },
      { kind: 'every_n_days', n: 1.5, times: ['08:00'] },
      { kind: 'every_n_days', n: 3, times: [] },
      { kind: 'as_needed', times: ['08:00'] },
    ];

    for (const invalid of invalidSchedules) {
      expect(scheduleSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('validates C1 enum schemas strictly against spec values', () => {
    const {
      memberRoleSchema,
      doseStatusSchema,
      logTypeSchema,
      medicationSourceSchema,
      taskSourceSchema,
    } = loadCareCircleSchemas();

    for (const role of ['owner', 'helper', 'viewer']) {
      expect(memberRoleSchema.safeParse(role).success).toBe(true);
    }
    expect(memberRoleSchema.safeParse('admin').success).toBe(false);

    for (const status of ['pending', 'given', 'skipped', 'missed']) {
      expect(doseStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(doseStatusSchema.safeParse('snoozed').success).toBe(false);

    for (const logType of ['dose', 'med_change', 'appointment', 'task', 'visit_note', 'member']) {
      expect(logTypeSchema.safeParse(logType).success).toBe(true);
    }
    expect(logTypeSchema.safeParse('system').success).toBe(false);

    expect(medicationSourceSchema.safeParse('manual').success).toBe(true);
    expect(medicationSourceSchema.safeParse('photo').success).toBe(true);
    expect(medicationSourceSchema.safeParse('voice').success).toBe(false);

    expect(taskSourceSchema.safeParse('manual').success).toBe(true);
    expect(taskSourceSchema.safeParse('visit_note').success).toBe(true);
    expect(taskSourceSchema.safeParse('photo').success).toBe(false);
  });

  it('validates C1 row schemas and rejects malformed UUIDs, blank strings, and unknown properties', () => {
    const {
      circleRowSchema,
      circleMemberRowSchema,
      inviteRowSchema,
      medicationRowSchema,
      doseEventRowSchema,
      appointmentRowSchema,
      taskRowSchema,
      visitNoteRowSchema,
      logEntryRowSchema,
    } = loadCareCircleSchemas();

    const circleId = 'c1c00001-0000-4000-8000-000000000001';
    const userId = 'c1000001-1111-4111-8111-111111111111';
    const medId = 'c1200001-0000-4000-8000-000000000001';
    const isoNow = '2026-11-15T12:00:00.000Z';

    expect(
      circleRowSchema.safeParse({
        id: circleId,
        name: 'Mom Care Circle',
        care_recipient_name: 'Evelyn',
        care_recipient_dob: '1948-05-12',
        timezone: 'America/New_York',
        created_by: userId,
        created_at: isoNow,
      }).success,
    ).toBe(true);
    expect(
      circleRowSchema.safeParse({
        id: 'not-a-uuid',
        name: 'Mom Care Circle',
        care_recipient_name: 'Evelyn',
        care_recipient_dob: null,
        timezone: 'America/New_York',
        created_by: userId,
        created_at: isoNow,
      }).success,
    ).toBe(false);
    expect(
      circleRowSchema.safeParse({
        id: circleId,
        name: '',
        care_recipient_name: 'Evelyn',
        care_recipient_dob: null,
        timezone: 'America/New_York',
        created_by: userId,
        created_at: isoNow,
      }).success,
    ).toBe(false);

    expect(
      circleMemberRowSchema.safeParse({
        circle_id: circleId,
        user_id: userId,
        role: 'owner',
        joined_at: isoNow,
      }).success,
    ).toBe(true);

    expect(
      inviteRowSchema.safeParse({
        id: 'c1100001-0000-4000-8000-000000000001',
        circle_id: circleId,
        token: 'invite-tok-123',
        role: 'helper',
        expires_at: isoNow,
        used_by: null,
      }).success,
    ).toBe(true);

    expect(
      medicationRowSchema.safeParse({
        id: medId,
        circle_id: circleId,
        name: 'Metformin',
        strength: '500 mg',
        dose_text: '1 tablet',
        schedule: { kind: 'daily', times: ['08:00', '20:00'] },
        instructions: 'Take with food',
        start_date: '2026-11-01',
        end_date: null,
        active: true,
        source: 'manual',
      }).success,
    ).toBe(true);
    expect(
      medicationRowSchema.safeParse({
        id: medId,
        circle_id: circleId,
        name: 'Metformin',
        strength: '500 mg',
        dose_text: '1 tablet',
        schedule: { kind: 'invalid_kind' },
        instructions: null,
        start_date: '2026-11-01',
        end_date: null,
        active: true,
        source: 'manual',
      }).success,
    ).toBe(false);

    expect(
      doseEventRowSchema.safeParse({
        id: 'c1300001-0000-4000-8000-000000000001',
        medication_id: medId,
        circle_id: circleId,
        due_at: isoNow,
        status: 'given',
        acted_by: userId,
        acted_at: isoNow,
      }).success,
    ).toBe(true);

    expect(
      appointmentRowSchema.safeParse({
        id: 'c1400001-0000-4000-8000-000000000001',
        circle_id: circleId,
        title: 'Cardiology check-up',
        starts_at: isoNow,
        ends_at: null,
        location: 'Clinic',
        driver_user_id: userId,
        notes: null,
      }).success,
    ).toBe(true);

    expect(
      taskRowSchema.safeParse({
        id: 'c1500001-0000-4000-8000-000000000001',
        circle_id: circleId,
        title: 'Pick up prescription',
        due_at: isoNow,
        assignee: userId,
        done_at: null,
        done_by: null,
        source: 'manual',
      }).success,
    ).toBe(true);

    expect(
      visitNoteRowSchema.safeParse({
        id: 'c1600001-0000-4000-8000-000000000001',
        circle_id: circleId,
        appointment_id: null,
        transcript: 'Doctor reported stable vitals.',
        summary: 'Vitals are stable.',
        created_by: userId,
        created_at: isoNow,
      }).success,
    ).toBe(true);

    expect(
      logEntryRowSchema.safeParse({
        id: 'c1700001-0000-4000-8000-000000000001',
        circle_id: circleId,
        type: 'dose',
        ref_id: 'c1300001-0000-4000-8000-000000000001',
        summary: 'Dose given',
        created_by: userId,
        created_at: isoNow,
      }).success,
    ).toBe(true);
  });

  it('provides CARECIRCLE_MOCKS with 1 circle, 3 members, 4 meds, 7 days of dose events, 3 appointments, and 5 tasks', () => {
    const {
      CARECIRCLE_MOCKS,
      circleSchema,
      circleMemberSchema,
      medicationSchema,
      doseEventSchema,
      appointmentSchema,
      taskSchema,
    } = loadCareCircleSchemas();

    expect(circleSchema.safeParse(CARECIRCLE_MOCKS.circle).success).toBe(true);

    expect(CARECIRCLE_MOCKS.members).toHaveLength(3);
    for (const member of CARECIRCLE_MOCKS.members) {
      expect(circleMemberSchema.safeParse(member).success).toBe(true);
    }
    const roles = CARECIRCLE_MOCKS.members.map((m) => m.role).sort();
    expect(roles).toEqual(['helper', 'owner', 'viewer']);

    expect(CARECIRCLE_MOCKS.medications).toHaveLength(4);
    for (const med of CARECIRCLE_MOCKS.medications) {
      expect(medicationSchema.safeParse(med).success).toBe(true);
    }

    expect(CARECIRCLE_MOCKS.doseEvents.length).toBeGreaterThanOrEqual(7);
    const distinctDays = new Set<string>();
    for (const evt of CARECIRCLE_MOCKS.doseEvents) {
      expect(doseEventSchema.safeParse(evt).success).toBe(true);
      distinctDays.add(String(evt.dueAt).slice(0, 10));
    }
    expect(distinctDays.size).toBe(7);

    expect(CARECIRCLE_MOCKS.appointments).toHaveLength(3);
    for (const appt of CARECIRCLE_MOCKS.appointments) {
      expect(appointmentSchema.safeParse(appt).success).toBe(true);
    }

    expect(CARECIRCLE_MOCKS.tasks).toHaveLength(5);
    for (const task of CARECIRCLE_MOCKS.tasks) {
      expect(taskSchema.safeParse(task).success).toBe(true);
    }
  });
});

// Added in review: every C1 row, field by field, in both shapes (database snake_case and
// app camelCase, AGENTS.md 5.2), and a mock dataset that hangs together.
type Shapes = { row: string; camel: string };
type TableSpec = {
  shapes: Shapes;
  valid: Record<string, unknown>;
  nullable: string[];
  required: string[];
  enums: string[];
  timestamps: string[];
  dates: string[];
  uuids: string[];
};

const ID = 'c1c00001-0000-4000-8000-000000000001';
const USER = 'c1000001-1111-4111-8111-111111111111';
const AT = '2026-11-15T12:00:00.000Z';

const TABLES: Record<string, TableSpec> = {
  circles: {
    shapes: { row: 'circleRowSchema', camel: 'circleSchema' },
    valid: {
      id: ID,
      name: 'Mum',
      care_recipient_name: 'Alex',
      care_recipient_dob: '1948-05-12',
      timezone: 'Europe/London',
      created_by: USER,
      created_at: AT,
    },
    nullable: ['care_recipient_dob'],
    required: ['id', 'name', 'care_recipient_name', 'timezone', 'created_at'],
    enums: [],
    timestamps: ['created_at'],
    dates: ['care_recipient_dob'],
    uuids: ['id', 'created_by'],
  },
  circle_members: {
    shapes: { row: 'circleMemberRowSchema', camel: 'circleMemberSchema' },
    valid: { circle_id: ID, user_id: USER, role: 'viewer', joined_at: AT },
    nullable: [],
    required: ['circle_id', 'user_id', 'role', 'joined_at'],
    enums: ['role'],
    timestamps: ['joined_at'],
    dates: [],
    uuids: ['circle_id', 'user_id'],
  },
  invites: {
    shapes: { row: 'inviteRowSchema', camel: 'inviteSchema' },
    valid: {
      id: ID,
      circle_id: ID,
      token: 'a'.repeat(64),
      role: 'helper',
      expires_at: AT,
      used_by: null,
    },
    nullable: ['used_by'],
    required: ['id', 'circle_id', 'token', 'role', 'expires_at'],
    enums: ['role'],
    timestamps: ['expires_at'],
    dates: [],
    uuids: ['id', 'circle_id', 'used_by'],
  },
  medications: {
    shapes: { row: 'medicationRowSchema', camel: 'medicationSchema' },
    valid: {
      id: ID,
      circle_id: ID,
      name: 'Metformin',
      strength: '500 mg',
      dose_text: '1 tablet',
      schedule: { kind: 'every_n_days', n: 2, times: ['07:30'] },
      instructions: 'With food',
      start_date: '2026-11-01',
      end_date: '2026-12-01',
      active: false,
      source: 'photo',
    },
    nullable: ['strength', 'instructions', 'end_date'],
    required: ['id', 'circle_id', 'name', 'dose_text', 'schedule', 'active', 'source'],
    enums: ['source'],
    timestamps: [],
    dates: ['start_date', 'end_date'],
    uuids: ['id', 'circle_id'],
  },
  dose_events: {
    shapes: { row: 'doseEventRowSchema', camel: 'doseEventSchema' },
    valid: {
      id: ID,
      medication_id: ID,
      circle_id: ID,
      due_at: AT,
      status: 'skipped',
      acted_by: USER,
      acted_at: AT,
    },
    nullable: ['acted_by', 'acted_at'],
    required: ['id', 'medication_id', 'circle_id', 'due_at', 'status'],
    enums: ['status'],
    timestamps: ['due_at', 'acted_at'],
    dates: [],
    uuids: ['id', 'medication_id', 'circle_id', 'acted_by'],
  },
  appointments: {
    shapes: { row: 'appointmentRowSchema', camel: 'appointmentSchema' },
    valid: {
      id: ID,
      circle_id: ID,
      title: 'GP',
      starts_at: AT,
      ends_at: AT,
      location: 'Clinic',
      driver_user_id: USER,
      notes: 'Bring list',
    },
    nullable: ['ends_at', 'location', 'driver_user_id', 'notes'],
    required: ['id', 'circle_id', 'title', 'starts_at'],
    enums: [],
    timestamps: ['starts_at', 'ends_at'],
    dates: [],
    uuids: ['id', 'circle_id', 'driver_user_id'],
  },
  tasks: {
    shapes: { row: 'taskRowSchema', camel: 'taskSchema' },
    valid: {
      id: ID,
      circle_id: ID,
      title: 'Refill',
      due_at: AT,
      assignee: USER,
      done_at: AT,
      done_by: USER,
      source: 'visit_note',
    },
    nullable: ['due_at', 'assignee', 'done_at', 'done_by'],
    required: ['id', 'circle_id', 'title', 'source'],
    enums: ['source'],
    timestamps: ['due_at', 'done_at'],
    dates: [],
    uuids: ['id', 'circle_id', 'assignee', 'done_by'],
  },
  visit_notes: {
    shapes: { row: 'visitNoteRowSchema', camel: 'visitNoteSchema' },
    valid: {
      id: ID,
      circle_id: ID,
      appointment_id: ID,
      transcript: 'T',
      summary: 'S',
      created_by: USER,
      created_at: AT,
    },
    nullable: ['appointment_id'],
    required: ['id', 'circle_id', 'created_at'],
    enums: [],
    timestamps: ['created_at'],
    dates: [],
    uuids: ['id', 'circle_id', 'appointment_id', 'created_by'],
  },
  log_entries: {
    shapes: { row: 'logEntryRowSchema', camel: 'logEntrySchema' },
    valid: {
      id: ID,
      circle_id: ID,
      type: 'member',
      ref_id: USER,
      summary: 'Joined',
      created_by: USER,
      created_at: AT,
    },
    nullable: [],
    required: ['id', 'circle_id', 'type', 'created_at'],
    enums: ['type'],
    timestamps: ['created_at'],
    dates: [],
    uuids: ['id', 'circle_id', 'ref_id', 'created_by'],
  },
};

const toCamel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
function camelRow(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [toCamel(k), v]));
}

describe('CC-0 C1 rows field by field (added in review)', () => {
  for (const [table, spec] of Object.entries(TABLES)) {
    for (const shape of ['row', 'camel'] as const) {
      it(`${table} (${shape === 'row' ? 'database snake_case' : 'app camelCase'}) follows C1`, () => {
        const schemas = loadCareCircleSchemas() as unknown as Record<string, z.ZodType<unknown>>;
        const schema = schemas[spec.shapes[shape]] as z.ZodType<unknown>;
        const key = (k: string) => (shape === 'row' ? k : toCamel(k));
        const base = shape === 'row' ? spec.valid : camelRow(spec.valid);
        const ok = (patch: Record<string, unknown>, drop?: string) => {
          const value: Record<string, unknown> = { ...base, ...patch };
          if (drop) delete value[drop];
          return schema.safeParse(value).success;
        };

        expect(ok({})).toBe(true);
        expect(ok({ unexpected: 1 })).toBe(false);
        // The other shape's keys are refused (no mixing snake_case and camelCase).
        const otherShape = shape === 'row' ? camelRow(spec.valid) : spec.valid;
        expect(schema.safeParse(otherShape).success).toBe(false);
        for (const f of spec.nullable)
          expect({ f, ok: ok({ [key(f)]: null }) }).toEqual({ f, ok: true });
        for (const f of spec.required) {
          expect({ f, nullOk: ok({ [key(f)]: null }) }).toEqual({ f, nullOk: false });
          expect({ f, missingOk: ok({}, key(f)) }).toEqual({ f, missingOk: false });
        }
        for (const f of spec.enums)
          expect({ f, ok: ok({ [key(f)]: 'bogus' }) }).toEqual({ f, ok: false });
        for (const f of spec.timestamps) {
          expect({ f, ok: ok({ [key(f)]: '2026-11-15' }) }).toEqual({ f, ok: false });
          expect({ f, ok: ok({ [key(f)]: 'tomorrow' }) }).toEqual({ f, ok: false });
          expect({ f, ok: ok({ [key(f)]: '2026-11-15T12:00:00+01:00' }) }).toEqual({ f, ok: true });
        }
        for (const f of spec.dates) {
          expect({ f, ok: ok({ [key(f)]: '12/05/1948' }) }).toEqual({ f, ok: false });
          expect({ f, ok: ok({ [key(f)]: '2026-11-15T12:00:00.000Z' }) }).toEqual({ f, ok: false });
        }
        for (const f of spec.uuids)
          expect({ f, ok: ok({ [key(f)]: 'not-a-uuid' }) }).toEqual({ f, ok: false });
      });
    }
  }

  it('the mock dataset hangs together like real data', () => {
    const { CARECIRCLE_MOCKS: m } = loadCareCircleSchemas();
    const circleId = m.circle.id;
    const rows = [...m.members, ...m.medications, ...m.doseEvents, ...m.appointments, ...m.tasks];
    expect(rows.every((r) => r.circleId === circleId)).toBe(true);

    expect(new Set(m.members.map((x) => x.userId)).size).toBe(3);
    expect(m.members.filter((x) => x.role === 'owner')).toHaveLength(1);

    // One medication per schedule kind, so every screen state has data.
    const kinds = m.medications.map((x) => (x.schedule as { kind: string }).kind).sort();
    expect(kinds).toEqual(['as_needed', 'daily', 'every_n_days', 'weekly']);

    const medsById = new Map(m.medications.map((x) => [x.id, x]));
    const seen = new Set<string>();
    for (const dose of m.doseEvents) {
      const med = medsById.get(dose.medicationId as string);
      expect(med).toBeDefined();
      // as_needed creates no scheduled events: only doses someone logged as given.
      const asNeeded = (med?.schedule as { kind?: string } | undefined)?.kind === 'as_needed';
      expect({ asNeeded, status: asNeeded ? dose.status : 'given' }).toEqual({
        asNeeded,
        status: 'given',
      });
      // unique (medication_id, due_at), as in C1.
      const pair = `${String(dose.medicationId)}|${String(dose.dueAt)}`;
      expect(seen.has(pair)).toBe(false);
      seen.add(pair);
    }
    // Days of dose events are 7 consecutive calendar days.
    const days = [...new Set(m.doseEvents.map((d) => String(d.dueAt).slice(0, 10)))].sort();
    const span = (Date.parse(days[days.length - 1] ?? '') - Date.parse(days[0] ?? '')) / 86_400_000;
    expect(span).toBe(6);

    const ids = rows.flatMap((r) => ('id' in r ? [r.id] : []));
    expect(new Set(ids).size).toBe(ids.length);

    const memberIds = new Set(m.members.map((x) => x.userId));
    const strangers = [
      ...m.appointments.map((a) => a.driverUserId),
      ...m.tasks.map((t) => t.assignee),
    ].filter((u) => u != null && !memberIds.has(u));
    // Drivers and assignees are members of the circle.
    expect(strangers).toEqual([]);
  });
});

describe('CC-0 schedule JSON, weekday names (added in review)', () => {
  it('weekly days are exactly mon..sun', () => {
    const { scheduleSchema } = loadCareCircleSchemas();
    const week = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    expect(scheduleSchema.safeParse({ kind: 'weekly', days: week, times: ['09:00'] }).success).toBe(
      true,
    );
    for (const day of ['xyz', 'Mon', 'MON', 'thur', 'sunday']) {
      expect({
        day,
        ok: scheduleSchema.safeParse({ kind: 'weekly', days: [day], times: ['09:00'] }).success,
      }).toEqual({ day, ok: false });
    }
  });
});
