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
