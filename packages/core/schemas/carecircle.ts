import { z } from 'zod';

const uuidSchema = z.string().uuid();
const nonEmptyTextSchema = z.string().trim().min(1);
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Date must be YYYY-MM-DD');
const isoTimestampSchema = z.string().datetime({ offset: true });
const time24hSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be in 24-hour HH:MM format');
const weekdaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

export const memberRoleSchema = z.enum(['owner', 'helper', 'viewer']);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const doseStatusSchema = z.enum(['pending', 'given', 'skipped', 'missed']);
export type DoseStatus = z.infer<typeof doseStatusSchema>;

export const logTypeSchema = z.enum([
  'dose',
  'med_change',
  'appointment',
  'task',
  'visit_note',
  'member',
]);
export type LogType = z.infer<typeof logTypeSchema>;

export const medicationSourceSchema = z.enum(['manual', 'photo']);
export type MedicationSource = z.infer<typeof medicationSourceSchema>;

export const taskSourceSchema = z.enum(['manual', 'visit_note']);
export type TaskSource = z.infer<typeof taskSourceSchema>;

export const scheduleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('daily'),
      times: z.array(time24hSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('weekly'),
      days: z.array(weekdaySchema).min(1),
      times: z.array(time24hSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('every_n_days'),
      n: z.number().int().positive(),
      times: z.array(time24hSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('as_needed'),
    })
    .strict(),
]);
export type MedicationSchedule = z.infer<typeof scheduleSchema>;

// 1. circles (snake_case DB row + camelCase app model)
export const circleRowSchema = z
  .object({
    id: uuidSchema,
    name: nonEmptyTextSchema,
    care_recipient_name: nonEmptyTextSchema,
    care_recipient_dob: isoDateSchema.nullable(),
    timezone: nonEmptyTextSchema,
    created_by: uuidSchema.nullable(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type CircleRow = z.infer<typeof circleRowSchema>;

export const circleSchema = z
  .object({
    id: uuidSchema,
    name: nonEmptyTextSchema,
    careRecipientName: nonEmptyTextSchema,
    careRecipientDob: isoDateSchema.nullable(),
    timezone: nonEmptyTextSchema,
    createdBy: uuidSchema.nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type Circle = z.infer<typeof circleSchema>;

// 2. circle_members
export const circleMemberRowSchema = z
  .object({
    circle_id: uuidSchema,
    user_id: uuidSchema,
    role: memberRoleSchema,
    joined_at: isoTimestampSchema,
  })
  .strict();
export type CircleMemberRow = z.infer<typeof circleMemberRowSchema>;

export const circleMemberSchema = z
  .object({
    circleId: uuidSchema,
    userId: uuidSchema,
    role: memberRoleSchema,
    joinedAt: isoTimestampSchema,
  })
  .strict();
export type CircleMember = z.infer<typeof circleMemberSchema>;

// 3. invites
export const inviteRowSchema = z
  .object({
    id: uuidSchema,
    circle_id: uuidSchema,
    token: nonEmptyTextSchema,
    role: memberRoleSchema,
    expires_at: isoTimestampSchema,
    used_by: uuidSchema.nullable(),
  })
  .strict();
export type InviteRow = z.infer<typeof inviteRowSchema>;

export const inviteSchema = z
  .object({
    id: uuidSchema,
    circleId: uuidSchema,
    token: nonEmptyTextSchema,
    role: memberRoleSchema,
    expiresAt: isoTimestampSchema,
    usedBy: uuidSchema.nullable(),
  })
  .strict();
export type Invite = z.infer<typeof inviteSchema>;

// 4. medications
export const medicationRowSchema = z
  .object({
    id: uuidSchema,
    circle_id: uuidSchema,
    name: nonEmptyTextSchema,
    strength: nonEmptyTextSchema.nullable(),
    dose_text: nonEmptyTextSchema,
    schedule: scheduleSchema,
    instructions: nonEmptyTextSchema.nullable(),
    start_date: isoDateSchema.nullable(),
    end_date: isoDateSchema.nullable(),
    active: z.boolean(),
    source: medicationSourceSchema,
  })
  .strict();
export type MedicationRow = z.infer<typeof medicationRowSchema>;

export const medicationSchema = z
  .object({
    id: uuidSchema,
    circleId: uuidSchema,
    name: nonEmptyTextSchema,
    strength: nonEmptyTextSchema.nullable(),
    doseText: nonEmptyTextSchema,
    schedule: scheduleSchema,
    instructions: nonEmptyTextSchema.nullable(),
    startDate: isoDateSchema.nullable(),
    endDate: isoDateSchema.nullable(),
    active: z.boolean(),
    source: medicationSourceSchema,
  })
  .strict();
export type Medication = z.infer<typeof medicationSchema>;

// 5. dose_events
export const doseEventRowSchema = z
  .object({
    id: uuidSchema,
    medication_id: uuidSchema,
    circle_id: uuidSchema,
    due_at: isoTimestampSchema,
    status: doseStatusSchema,
    acted_by: uuidSchema.nullable(),
    acted_at: isoTimestampSchema.nullable(),
  })
  .strict();
export type DoseEventRow = z.infer<typeof doseEventRowSchema>;

export const doseEventSchema = z
  .object({
    id: uuidSchema,
    medicationId: uuidSchema,
    circleId: uuidSchema,
    dueAt: isoTimestampSchema,
    status: doseStatusSchema,
    actedBy: uuidSchema.nullable(),
    actedAt: isoTimestampSchema.nullable(),
  })
  .strict();
export type DoseEvent = z.infer<typeof doseEventSchema>;

// 6. appointments
export const appointmentRowSchema = z
  .object({
    id: uuidSchema,
    circle_id: uuidSchema,
    title: nonEmptyTextSchema,
    starts_at: isoTimestampSchema,
    ends_at: isoTimestampSchema.nullable(),
    location: nonEmptyTextSchema.nullable(),
    driver_user_id: uuidSchema.nullable(),
    notes: nonEmptyTextSchema.nullable(),
  })
  .strict();
export type AppointmentRow = z.infer<typeof appointmentRowSchema>;

export const appointmentSchema = z
  .object({
    id: uuidSchema,
    circleId: uuidSchema,
    title: nonEmptyTextSchema,
    startsAt: isoTimestampSchema,
    endsAt: isoTimestampSchema.nullable(),
    location: nonEmptyTextSchema.nullable(),
    driverUserId: uuidSchema.nullable(),
    notes: nonEmptyTextSchema.nullable(),
  })
  .strict();
export type Appointment = z.infer<typeof appointmentSchema>;

// 7. tasks
export const taskRowSchema = z
  .object({
    id: uuidSchema,
    circle_id: uuidSchema,
    title: nonEmptyTextSchema,
    due_at: isoTimestampSchema.nullable(),
    assignee: uuidSchema.nullable(),
    done_at: isoTimestampSchema.nullable(),
    done_by: uuidSchema.nullable(),
    source: taskSourceSchema,
  })
  .strict();
export type TaskRow = z.infer<typeof taskRowSchema>;

export const taskSchema = z
  .object({
    id: uuidSchema,
    circleId: uuidSchema,
    title: nonEmptyTextSchema,
    dueAt: isoTimestampSchema.nullable(),
    assignee: uuidSchema.nullable(),
    doneAt: isoTimestampSchema.nullable(),
    doneBy: uuidSchema.nullable(),
    source: taskSourceSchema,
  })
  .strict();
export type Task = z.infer<typeof taskSchema>;

// 8. visit_notes
export const visitNoteRowSchema = z
  .object({
    id: uuidSchema,
    circle_id: uuidSchema,
    appointment_id: uuidSchema.nullable(),
    transcript: nonEmptyTextSchema.nullable(),
    summary: nonEmptyTextSchema.nullable(),
    created_by: uuidSchema.nullable(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type VisitNoteRow = z.infer<typeof visitNoteRowSchema>;

export const visitNoteSchema = z
  .object({
    id: uuidSchema,
    circleId: uuidSchema,
    appointmentId: uuidSchema.nullable(),
    transcript: nonEmptyTextSchema.nullable(),
    summary: nonEmptyTextSchema.nullable(),
    createdBy: uuidSchema.nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type VisitNote = z.infer<typeof visitNoteSchema>;

// 9. log_entries
export const logEntryRowSchema = z
  .object({
    id: uuidSchema,
    circle_id: uuidSchema,
    type: logTypeSchema,
    ref_id: uuidSchema.nullable(),
    summary: nonEmptyTextSchema.nullable(),
    created_by: uuidSchema.nullable(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type LogEntryRow = z.infer<typeof logEntryRowSchema>;

export const logEntrySchema = z
  .object({
    id: uuidSchema,
    circleId: uuidSchema,
    type: logTypeSchema,
    refId: uuidSchema.nullable(),
    summary: nonEmptyTextSchema.nullable(),
    createdBy: uuidSchema.nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type LogEntry = z.infer<typeof logEntrySchema>;

// Mock dataset: 1 circle, 3 members (owner/helper/viewer), 4 meds (all 4 schedule kinds),
// 7 consecutive days of dose events, 3 appointments, 5 tasks, and fake C2 AI responses.
const mockCircleId = 'c1c00001-0000-4000-8000-000000000001';
const ownerUserId = 'c1000001-1111-4111-8111-111111111111';
const helperUserId = 'c1000002-2222-4222-8222-222222222222';
const viewerUserId = 'c1000003-3333-4333-8333-333333333333';

const med1Id = 'c1200001-0000-4000-8000-000000000001';
const med2Id = 'c1200001-0000-4000-8000-000000000002';
const med3Id = 'c1200001-0000-4000-8000-000000000003';
const med4Id = 'c1200001-0000-4000-8000-000000000004';

const mockDays = [
  '2026-11-09',
  '2026-11-10',
  '2026-11-11',
  '2026-11-12',
  '2026-11-13',
  '2026-11-14',
  '2026-11-15',
] as const;

export const CARECIRCLE_MOCKS = {
  circle: {
    id: mockCircleId,
    name: 'Mom Care Circle',
    careRecipientName: 'Evelyn',
    careRecipientDob: '1948-05-12',
    // London is UTC+0 in November, so the dose times below are the same in local time and UTC.
    timezone: 'Europe/London',
    createdBy: ownerUserId,
    createdAt: '2026-11-01T12:00:00.000Z',
  } satisfies Circle,
  members: [
    {
      circleId: mockCircleId,
      userId: ownerUserId,
      role: 'owner',
      joinedAt: '2026-11-01T12:00:00.000Z',
    },
    {
      circleId: mockCircleId,
      userId: helperUserId,
      role: 'helper',
      joinedAt: '2026-11-01T12:05:00.000Z',
    },
    {
      circleId: mockCircleId,
      userId: viewerUserId,
      role: 'viewer',
      joinedAt: '2026-11-01T12:10:00.000Z',
    },
  ] satisfies CircleMember[],
  medications: [
    {
      id: med1Id,
      circleId: mockCircleId,
      name: 'Metformin',
      strength: '500 mg',
      doseText: '1 tablet',
      schedule: { kind: 'daily', times: ['08:00', '20:00'] },
      instructions: 'Take with food',
      startDate: '2026-11-01',
      endDate: null,
      active: true,
      source: 'manual',
    },
    {
      id: med2Id,
      circleId: mockCircleId,
      name: 'Lisinopril',
      strength: '10 mg',
      doseText: '1 tablet',
      schedule: { kind: 'weekly', days: ['mon', 'thu'], times: ['09:00'] },
      instructions: 'Take in the morning',
      startDate: '2026-11-01',
      endDate: null,
      active: true,
      source: 'photo',
    },
    {
      id: med3Id,
      circleId: mockCircleId,
      name: 'Vitamin D3',
      strength: '1000 IU',
      doseText: '1 softgel',
      schedule: { kind: 'every_n_days', n: 3, times: ['08:00'] },
      instructions: null,
      startDate: '2026-11-01',
      endDate: null,
      active: true,
      source: 'manual',
    },
    {
      id: med4Id,
      circleId: mockCircleId,
      name: 'Acetaminophen',
      strength: '500 mg',
      doseText: '1 tablet as needed for mild pain',
      schedule: { kind: 'as_needed' },
      instructions: 'Do not exceed 4 tablets per day',
      startDate: '2026-11-01',
      endDate: null,
      active: true,
      source: 'manual',
    },
  ] satisfies Medication[],
  doseEvents: mockDays.flatMap((day, idx): DoseEvent[] => {
    const morningId = `c1300001-0000-4000-8000-0000000000${String(idx * 2 + 1).padStart(2, '0')}`;
    const eveningId = `c1300001-0000-4000-8000-0000000000${String(idx * 2 + 2).padStart(2, '0')}`;
    const isToday = idx === mockDays.length - 1;
    return [
      {
        id: morningId,
        medicationId: med1Id,
        circleId: mockCircleId,
        dueAt: `${day}T08:00:00.000Z`,
        status: 'given',
        actedBy: ownerUserId,
        actedAt: `${day}T08:05:00.000Z`,
      },
      {
        id: eveningId,
        medicationId: med1Id,
        circleId: mockCircleId,
        dueAt: `${day}T20:00:00.000Z`,
        status: isToday ? 'pending' : 'given',
        actedBy: isToday ? null : helperUserId,
        actedAt: isToday ? null : `${day}T20:04:00.000Z`,
      },
    ];
  }),
  appointments: [
    {
      id: 'c1400001-0000-4000-8000-000000000001',
      circleId: mockCircleId,
      title: 'Cardiology check-up',
      startsAt: '2026-11-18T15:00:00.000Z',
      endsAt: '2026-11-18T16:00:00.000Z',
      location: 'City Heart Clinic',
      driverUserId: helperUserId,
      notes: 'Bring home blood pressure log',
    },
    {
      id: 'c1400001-0000-4000-8000-000000000002',
      circleId: mockCircleId,
      title: 'Primary care lab work',
      startsAt: '2026-11-22T14:00:00.000Z',
      endsAt: '2026-11-22T14:30:00.000Z',
      location: 'High Street Surgery',
      driverUserId: ownerUserId,
      notes: 'Fasting required',
    },
    {
      id: 'c1400001-0000-4000-8000-000000000003',
      circleId: mockCircleId,
      title: 'Ophthalmology annual exam',
      startsAt: '2026-11-29T16:30:00.000Z',
      endsAt: null,
      location: 'Downtown Eye Center',
      driverUserId: null,
      notes: null,
    },
  ] satisfies Appointment[],
  tasks: [
    {
      id: 'c1500001-0000-4000-8000-000000000001',
      circleId: mockCircleId,
      title: 'Pick up Metformin refill',
      dueAt: '2026-11-16T17:00:00.000Z',
      assignee: helperUserId,
      doneAt: null,
      doneBy: null,
      source: 'manual',
    },
    {
      id: 'c1500001-0000-4000-8000-000000000002',
      circleId: mockCircleId,
      title: 'Book blood test in two weeks',
      dueAt: '2026-11-23T17:00:00.000Z',
      assignee: ownerUserId,
      doneAt: null,
      doneBy: null,
      source: 'visit_note',
    },
    {
      id: 'c1500001-0000-4000-8000-000000000003',
      circleId: mockCircleId,
      title: 'Order weekly pill organizer',
      dueAt: '2026-11-17T18:00:00.000Z',
      assignee: null,
      doneAt: null,
      doneBy: null,
      source: 'manual',
    },
    {
      id: 'c1500001-0000-4000-8000-000000000004',
      circleId: mockCircleId,
      title: 'Update emergency contact sheet on fridge',
      dueAt: '2026-11-14T18:00:00.000Z',
      assignee: ownerUserId,
      doneAt: '2026-11-14T16:30:00.000Z',
      doneBy: ownerUserId,
      source: 'manual',
    },
    {
      id: 'c1500001-0000-4000-8000-000000000005',
      circleId: mockCircleId,
      title: 'Check blood pressure cuff batteries',
      dueAt: null,
      assignee: helperUserId,
      doneAt: null,
      doneBy: null,
      source: 'manual',
    },
  ] satisfies Task[],
  visitNotes: [
    {
      id: 'c1600001-0000-4000-8000-000000000001',
      circleId: mockCircleId,
      appointmentId: 'c1400001-0000-4000-8000-000000000001',
      transcript: 'Blood pressure is stable. Book a blood test in two weeks and stop Vitamin D3.',
      summary: 'Blood pressure is stable. Book a blood test in two weeks and stop Vitamin D3.',
      createdBy: ownerUserId,
      createdAt: '2026-11-14T16:00:00.000Z',
    },
  ] satisfies VisitNote[],
  logEntries: [
    {
      id: 'c1700001-0000-4000-8000-000000000001',
      circleId: mockCircleId,
      type: 'dose',
      refId: 'c1300001-0000-4000-8000-000000000013',
      summary: 'Dose marked given',
      createdBy: ownerUserId,
      createdAt: '2026-11-15T08:05:00.000Z',
    },
    {
      id: 'c1700001-0000-4000-8000-000000000002',
      circleId: mockCircleId,
      type: 'visit_note',
      refId: 'c1600001-0000-4000-8000-000000000001',
      summary: 'Visit note recorded',
      createdBy: ownerUserId,
      createdAt: '2026-11-14T16:00:00.000Z',
    },
    {
      id: 'c1700001-0000-4000-8000-000000000003',
      circleId: mockCircleId,
      type: 'task',
      refId: 'c1500001-0000-4000-8000-000000000004',
      summary: 'Task update: Update emergency contact sheet on fridge',
      createdBy: ownerUserId,
      createdAt: '2026-11-14T16:30:00.000Z',
    },
  ] satisfies LogEntry[],
  aiResponses: {
    extractPrescription: {
      name: 'Metformin',
      strength: '500 mg',
      doseText: '1 tablet',
      schedule: { kind: 'daily', times: ['08:00', '20:00'] },
      instructions: 'Take with food',
      fieldConfidence: {
        name: 0.97,
        strength: 0.94,
        doseText: 0.95,
        schedule: 0.91,
        instructions: 0.89,
      },
      rawText: 'Metformin 500 mg - Take 1 tablet twice daily with food',
    },
    summarizeVisit: {
      summary: 'Blood pressure is stable. Book a blood test in two weeks and stop Vitamin D3.',
      followUps: [{ title: 'Book blood test', dueHint: 'in 2 weeks', dueDate: '2026-11-23' }],
      medChanges: [
        {
          action: 'stop',
          medicationId: med3Id,
          name: 'Vitamin D3',
          detail: 'Stop until next visit',
        },
      ],
      questionsToAsk: ['Should blood pressure be logged twice daily?'],
    },
  },
};
