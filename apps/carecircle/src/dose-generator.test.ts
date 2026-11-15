import type { MedicationSchedule } from '@carecircle/core';

interface DoseGeneratorMedication {
  id: string;
  circleId: string;
  schedule: MedicationSchedule;
  startDate: string | null;
  endDate: string | null;
  active: boolean;
}

interface MaterializedDoseSlot {
  medicationId: string;
  circleId: string;
  dueAt: string;
  localDate: string;
  requestedTime: string;
  adjustedLocalTime: string;
}

interface DoseGeneratorLogicModule {
  materializeDoseTimes: (
    medication: DoseGeneratorMedication,
    circleTimezone: string,
    windowStart: Date | string,
    windowEnd: Date | string,
  ) => MaterializedDoseSlot[];
}

function loadDoseGeneratorLogic(): DoseGeneratorLogicModule {
  // Loaded at runtime so the [safety 1/2] tests-only PR typechecks before features/meds/logic.ts exists.
  return jest.requireActual<DoseGeneratorLogicModule>('./features/meds/logic');
}

const CIRCLE_ID = 'c1c00001-0000-4000-8000-000000000001';
const MED_ID = 'c1200001-0000-4000-8000-000000000001';

function makeMed(overrides: Partial<DoseGeneratorMedication> = {}): DoseGeneratorMedication {
  return {
    id: MED_ID,
    circleId: CIRCLE_ID,
    schedule: { kind: 'daily', times: ['08:00', '20:00'] },
    startDate: '2026-01-01',
    endDate: null,
    active: true,
    ...overrides,
  };
}

describe('CC-2a Dose generator pure logic (apps/carecircle/src/features/meds/logic.ts)', () => {
  it('materializes daily doses inside [windowStart, windowEnd] in the circle timezone, sorted and deduplicated', () => {
    const { materializeDoseTimes } = loadDoseGeneratorLogic();

    // Europe/Paris in November is CET (UTC+1): 08:00 local = 07:00Z, 20:00 local = 19:00Z.
    // 48-hour window: 2026-11-15T10:00:00.000Z .. 2026-11-17T10:00:00.000Z.
    const med = makeMed({
      schedule: { kind: 'daily', times: ['20:00', '08:00', '08:00'] },
    });
    const slots = materializeDoseTimes(
      med,
      'Europe/Paris',
      '2026-11-15T10:00:00.000Z',
      '2026-11-17T10:00:00.000Z',
    );

    expect(slots.map((s) => s.dueAt)).toEqual([
      '2026-11-15T19:00:00.000Z',
      '2026-11-16T07:00:00.000Z',
      '2026-11-16T19:00:00.000Z',
      '2026-11-17T07:00:00.000Z',
    ]);
    expect(slots[0]).toEqual({
      medicationId: MED_ID,
      circleId: CIRCLE_ID,
      dueAt: '2026-11-15T19:00:00.000Z',
      localDate: '2026-11-15',
      requestedTime: '20:00',
      adjustedLocalTime: '20:00',
    });

    // Exact boundary instants (dueAt === windowStart and dueAt === windowEnd) are inclusive.
    const boundarySlots = materializeDoseTimes(
      med,
      'Europe/Paris',
      '2026-11-15T19:00:00.000Z',
      '2026-11-16T07:00:00.000Z',
    );
    expect(boundarySlots.map((s) => s.dueAt)).toEqual([
      '2026-11-15T19:00:00.000Z',
      '2026-11-16T07:00:00.000Z',
    ]);
  });

  it('materializes weekly doses on matching weekdays in the circle timezone, not UTC', () => {
    const { materializeDoseTimes } = loadDoseGeneratorLogic();

    const weeklyMed = makeMed({
      schedule: { kind: 'weekly', days: ['mon', 'thu'], times: ['09:00'] },
    });
    // 2026-11-15 is Sunday; 2026-11-16 is Monday; 2026-11-19 is Thursday.
    const slots = materializeDoseTimes(
      weeklyMed,
      'Europe/Paris',
      '2026-11-15T00:00:00.000Z',
      '2026-11-22T00:00:00.000Z',
    );
    expect(slots.map((s) => ({ localDate: s.localDate, dueAt: s.dueAt }))).toEqual([
      { localDate: '2026-11-16', dueAt: '2026-11-16T08:00:00.000Z' },
      { localDate: '2026-11-19', dueAt: '2026-11-19T08:00:00.000Z' },
    ]);

    // In America/Los_Angeles (PST, UTC-8), Sunday 2026-11-15 at 22:30 local is
    // Monday 2026-11-16T06:30:00.000Z in UTC. Must match 'sun' in Los Angeles, NOT 'mon'.
    const sundayNightMed = makeMed({
      schedule: { kind: 'weekly', days: ['sun'], times: ['22:30'] },
    });
    const laSundaySlots = materializeDoseTimes(
      sundayNightMed,
      'America/Los_Angeles',
      '2026-11-15T08:00:00.000Z',
      '2026-11-17T08:00:00.000Z',
    );
    expect(laSundaySlots.map((s) => ({ localDate: s.localDate, dueAt: s.dueAt }))).toEqual([
      { localDate: '2026-11-15', dueAt: '2026-11-16T06:30:00.000Z' },
    ]);
  });

  it('materializes every_n_days doses by counting calendar days from startDate in the circle timezone (including across 23-hour DST days)', () => {
    const { materializeDoseTimes } = loadDoseGeneratorLogic();

    // start_date = 2026-11-01, n = 3 -> 2026-11-01, 2026-11-04, 2026-11-07, 2026-11-10.
    const every3DaysMed = makeMed({
      startDate: '2026-11-01',
      schedule: { kind: 'every_n_days', n: 3, times: ['08:00'] },
    });
    const slots = materializeDoseTimes(
      every3DaysMed,
      'Europe/London',
      '2026-11-01T00:00:00.000Z',
      '2026-11-11T00:00:00.000Z',
    );
    expect(slots.map((s) => s.localDate)).toEqual([
      '2026-11-01',
      '2026-11-04',
      '2026-11-07',
      '2026-11-10',
    ]);

    // Across Europe/Paris spring-forward on 2026-03-29 (a 23-hour day):
    // startDate = 2026-03-27, n = 3 -> 2026-03-27 (CET, 07:00Z) and 2026-03-30 (CEST, 06:00Z).
    const acrossDstMed = makeMed({
      startDate: '2026-03-27',
      schedule: { kind: 'every_n_days', n: 3, times: ['08:00'] },
    });
    const dstSlots = materializeDoseTimes(
      acrossDstMed,
      'Europe/Paris',
      '2026-03-27T00:00:00.000Z',
      '2026-03-31T00:00:00.000Z',
    );
    expect(dstSlots.map((s) => ({ localDate: s.localDate, dueAt: s.dueAt }))).toEqual([
      { localDate: '2026-03-27', dueAt: '2026-03-27T07:00:00.000Z' },
      { localDate: '2026-03-30', dueAt: '2026-03-30T06:00:00.000Z' },
    ]);
  });

  it('creates zero events for as_needed medications and inactive medications', () => {
    const { materializeDoseTimes } = loadDoseGeneratorLogic();

    const asNeededMed = makeMed({
      schedule: { kind: 'as_needed' },
      active: true,
    });
    expect(
      materializeDoseTimes(
        asNeededMed,
        'Europe/Paris',
        '2026-11-15T00:00:00.000Z',
        '2026-11-17T00:00:00.000Z',
      ),
    ).toEqual([]);

    const inactiveDailyMed = makeMed({
      schedule: { kind: 'daily', times: ['08:00', '20:00'] },
      active: false,
    });
    expect(
      materializeDoseTimes(
        inactiveDailyMed,
        'Europe/Paris',
        '2026-11-15T00:00:00.000Z',
        '2026-11-17T00:00:00.000Z',
      ),
    ).toEqual([]);
  });

  it('emits nothing before startDate or after endDate in the circle timezone', () => {
    const { materializeDoseTimes } = loadDoseGeneratorLogic();

    const boundedMed = makeMed({
      startDate: '2026-11-16',
      endDate: '2026-11-17',
      schedule: { kind: 'daily', times: ['08:00'] },
    });
    const slots = materializeDoseTimes(
      boundedMed,
      'Europe/London',
      '2026-11-14T00:00:00.000Z',
      '2026-11-19T00:00:00.000Z',
    );
    expect(slots.map((s) => s.localDate)).toEqual(['2026-11-16', '2026-11-17']);

    // Timezone boundary: in Asia/Tokyo (UTC+9), 2026-11-16 00:30 local is 2026-11-15T15:30:00.000Z.
    // With endDate = '2026-11-15', 2026-11-16 00:30 Tokyo time must NOT be emitted even though its UTC date is 2026-11-15.
    const tokyoMed = makeMed({
      startDate: '2026-11-15',
      endDate: '2026-11-15',
      schedule: { kind: 'daily', times: ['00:30'] },
    });
    const tokyoSlots = materializeDoseTimes(
      tokyoMed,
      'Asia/Tokyo',
      '2026-11-14T00:00:00.000Z',
      '2026-11-17T00:00:00.000Z',
    );
    expect(tokyoSlots.map((s) => ({ localDate: s.localDate, dueAt: s.dueAt }))).toEqual([
      { localDate: '2026-11-15', dueAt: '2026-11-14T15:30:00.000Z' },
    ]);
  });

  it('handles DST spring-forward (02:30 fires at 03:00) and fall-back (01:30 / repeated hour fires once) in the circle timezone', () => {
    const { materializeDoseTimes } = loadDoseGeneratorLogic();

    // 1. Europe/Paris spring-forward: Sunday 2026-03-29 jumps from 01:59 CET (UTC+1) to 03:00 CEST (UTC+2).
    // 02:30 local does not exist and moves to 03:00 CEST = 2026-03-29T01:00:00.000Z.
    const parisSpringMed = makeMed({
      startDate: '2026-03-01',
      schedule: { kind: 'daily', times: ['02:30'] },
    });
    const parisSpringSlots = materializeDoseTimes(
      parisSpringMed,
      'Europe/Paris',
      '2026-03-29T00:00:00.000Z',
      '2026-03-29T12:00:00.000Z',
    );
    expect(parisSpringSlots).toEqual([
      {
        medicationId: MED_ID,
        circleId: CIRCLE_ID,
        dueAt: '2026-03-29T01:00:00.000Z',
        localDate: '2026-03-29',
        requestedTime: '02:30',
        adjustedLocalTime: '03:00',
      },
    ]);

    // 2. America/New_York spring-forward: Sunday 2026-03-08 jumps from 01:59 EST (UTC-5) to 03:00 EDT (UTC-4).
    // 02:30 local moves to 03:00 EDT = 2026-03-08T07:00:00.000Z.
    const nySpringSlots = materializeDoseTimes(
      parisSpringMed,
      'America/New_York',
      '2026-03-08T05:00:00.000Z',
      '2026-03-08T12:00:00.000Z',
    );
    expect(nySpringSlots).toEqual([
      {
        medicationId: MED_ID,
        circleId: CIRCLE_ID,
        dueAt: '2026-03-08T07:00:00.000Z',
        localDate: '2026-03-08',
        requestedTime: '02:30',
        adjustedLocalTime: '03:00',
      },
    ]);

    // 3. Europe/Paris fall-back: Sunday 2026-10-25 falls back from 03:00 CEST (UTC+2) to 02:00 CET (UTC+1).
    // Both 01:30 (2026-10-24T23:30:00.000Z) and repeated 02:30 (first occurrence 2026-10-25T00:30:00.000Z) fire once.
    const parisFallMed = makeMed({
      startDate: '2026-10-01',
      schedule: { kind: 'daily', times: ['01:30', '02:30'] },
    });
    const parisFallSlots = materializeDoseTimes(
      parisFallMed,
      'Europe/Paris',
      '2026-10-24T22:00:00.000Z',
      '2026-10-25T06:00:00.000Z',
    );
    expect(parisFallSlots.map((s) => ({ time: s.adjustedLocalTime, dueAt: s.dueAt }))).toEqual([
      { time: '01:30', dueAt: '2026-10-24T23:30:00.000Z' },
      { time: '02:30', dueAt: '2026-10-25T00:30:00.000Z' },
    ]);

    // 4. Europe/London fall-back (2026-10-25) and America/New_York fall-back (2026-11-01):
    // 01:30 repeats in both zones and fires once at its first occurrence.
    const fallBack0130Med = makeMed({
      startDate: '2026-10-01',
      schedule: { kind: 'daily', times: ['01:30'] },
    });
    const londonFallSlots = materializeDoseTimes(
      fallBack0130Med,
      'Europe/London',
      '2026-10-24T23:00:00.000Z',
      '2026-10-25T06:00:00.000Z',
    );
    expect(londonFallSlots).toHaveLength(1);
    expect(londonFallSlots[0]?.dueAt).toBe('2026-10-25T00:30:00.000Z');

    const nyFallSlots = materializeDoseTimes(
      fallBack0130Med,
      'America/New_York',
      '2026-11-01T04:00:00.000Z',
      '2026-11-01T10:00:00.000Z',
    );
    expect(nyFallSlots).toHaveLength(1);
    expect(nyFallSlots[0]?.dueAt).toBe('2026-11-01T05:30:00.000Z');
  });

  it('rejects invalid IANA timezones and returns empty when windowEnd < windowStart', () => {
    const { materializeDoseTimes } = loadDoseGeneratorLogic();
    const med = makeMed();

    expect(
      materializeDoseTimes(
        med,
        'Europe/Paris',
        '2026-11-17T00:00:00.000Z',
        '2026-11-15T00:00:00.000Z',
      ),
    ).toEqual([]);

    expect(() =>
      materializeDoseTimes(
        med,
        'Not/A_Timezone',
        '2026-11-15T00:00:00.000Z',
        '2026-11-17T00:00:00.000Z',
      ),
    ).toThrow(/timezone/i);
  });
});
