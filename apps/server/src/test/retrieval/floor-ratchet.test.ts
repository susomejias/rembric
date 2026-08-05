import { describe, expect, it } from 'vitest';

import { checkBounds, ratchetCaps, ratchetFloors } from './floor-ratchet.js';

const TOLERANCE = 0.05;

function run(measured: number, previous: number | undefined, allowLowering = false) {
  return ratchetFloors({
    label: 'hybrid',
    measuredByK: { 8: { precisionAtK: measured, recallAtK: 1, mrr: 1 } },
    previousByK:
      previous === undefined
        ? undefined
        : { 8: { precisionAtK: previous, recallAtK: 0.95, mrr: 0.95 } },
    tolerance: TOLERANCE,
    allowLowering,
  });
}

describe('ratchetFloors', () => {
  it('seeds a floor at measured minus the tolerance on a first write', () => {
    const { floors, notes } = run(0.4, undefined);
    expect(floors[8]!.precisionAtK).toBeCloseTo(0.35, 10);
    expect(notes).toEqual([]);
  });

  it('never emits a negative floor', () => {
    expect(run(0.01, undefined).floors[8]!.precisionAtK).toBe(0);
  });

  it('raises the floor when the metric improved', () => {
    const { floors, notes } = run(0.5, 0.35);
    expect(floors[8]!.precisionAtK).toBeCloseTo(0.45, 10);
    expect(notes).toEqual([]);
  });

  it('holds the floor when a rewrite would lower it, and says so', () => {
    // Measured 0.36 → proposed floor 0.31, below the committed 0.35. Before the
    // ratchet this wrote 0.31 and the regression became the new normal.
    const { floors, notes } = run(0.36, 0.35);
    expect(floors[8]!.precisionAtK).toBeCloseTo(0.35, 10);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('held at 0.350');
    expect(notes[0]).toContain('--lower-floors');
  });

  it('lowers the floor only when explicitly permitted, and reports it', () => {
    const { floors, notes } = run(0.36, 0.35, true);
    expect(floors[8]!.precisionAtK).toBeCloseTo(0.31, 10);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('LOWERED');
  });

  it('ratchets each metric independently', () => {
    const { floors, notes } = ratchetFloors({
      label: 'hybrid',
      measuredByK: { 8: { precisionAtK: 0.5, recallAtK: 0.9, mrr: 1 } },
      previousByK: { 8: { precisionAtK: 0.35, recallAtK: 0.95, mrr: 0.6 } },
      tolerance: TOLERANCE,
      allowLowering: false,
    });
    expect(floors[8]!.precisionAtK).toBeCloseTo(0.45, 10);
    expect(floors[8]!.recallAtK).toBeCloseTo(0.95, 10);
    expect(floors[8]!.mrr).toBeCloseTo(0.95, 10);
    expect(notes.map((n) => n.split(' ')[1])).toEqual(['recallAtK']);
  });

  it('repeated rewrites at a flat measurement cannot drift the floor down', () => {
    let floor = run(0.4, undefined).floors[8]!.precisionAtK;
    for (let i = 0; i < 5; i++) {
      floor = run(0.4, floor).floors[8]!.precisionAtK;
    }
    expect(floor).toBeCloseTo(0.35, 10);
  });
});

const HEADROOM = {
  abstentionFalsePositiveRate: 0.125,
  overAbstentionRate: 0.0625,
  // An isolation gate, not a tuning bound: zero rows of tolerance.
  foreignScopeRate: 0,
};

function runCaps(measured: number, previous: number | undefined, allowLoosening = false) {
  return ratchetCaps({
    label: 'hybrid',
    measuredByK: {
      8: { abstentionFalsePositiveRate: measured, overAbstentionRate: 0, foreignScopeRate: 0 },
    },
    previousByK:
      previous === undefined
        ? undefined
        : {
            8: {
              abstentionFalsePositiveRate: previous,
              overAbstentionRate: 0.125,
              foreignScopeRate: 0,
            },
          },
    headroomByMetric: HEADROOM,
    allowLoosening,
  });
}

describe('ratchetCaps', () => {
  it('seeds a cap at measured plus one query of headroom', () => {
    const { caps, notes } = runCaps(0.25, undefined);
    expect(caps[8]!.abstentionFalsePositiveRate).toBeCloseTo(0.375, 10);
    expect(notes).toEqual([]);
  });

  it('clamps a cap at 1, since both metrics are rates', () => {
    expect(runCaps(0.95, undefined).caps[8]!.abstentionFalsePositiveRate).toBe(1);
  });

  it('tightens the cap when the metric improved', () => {
    const { caps, notes } = runCaps(0.125, 0.375);
    expect(caps[8]!.abstentionFalsePositiveRate).toBeCloseTo(0.25, 10);
    expect(notes).toEqual([]);
  });

  it('holds the cap when a rewrite would loosen it, and says so', () => {
    // The mirror image of the floor hazard: a regression must not be able to
    // raise the cap above itself on the next --write-baselines.
    const { caps, notes } = runCaps(0.375, 0.375);
    expect(caps[8]!.abstentionFalsePositiveRate).toBeCloseTo(0.375, 10);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('held at 0.375');
  });

  it('loosens the cap only when explicitly permitted, and reports it', () => {
    const { caps, notes } = runCaps(0.375, 0.375, true);
    expect(caps[8]!.abstentionFalsePositiveRate).toBeCloseTo(0.5, 10);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('LOOSENED');
  });

  it('repeated rewrites at a flat measurement cannot drift the cap up', () => {
    let cap = runCaps(0.25, undefined).caps[8]!.abstentionFalsePositiveRate;
    for (let i = 0; i < 5; i++) {
      cap = ratchetCaps({
        label: 'hybrid',
        measuredByK: {
          8: { abstentionFalsePositiveRate: 0.25, overAbstentionRate: 0, foreignScopeRate: 0 },
        },
        previousByK: {
          8: { abstentionFalsePositiveRate: cap, overAbstentionRate: 0.125, foreignScopeRate: 0 },
        },
        headroomByMetric: HEADROOM,
        allowLoosening: false,
      }).caps[8]!.abstentionFalsePositiveRate;
    }
    expect(cap).toBeCloseTo(0.375, 10);
  });

  it('ratchets each cap metric independently', () => {
    const { caps, notes } = ratchetCaps({
      label: 'hybrid',
      measuredByK: {
        8: { abstentionFalsePositiveRate: 0.25, overAbstentionRate: 0.25, foreignScopeRate: 0 },
      },
      previousByK: {
        8: { abstentionFalsePositiveRate: 0.5, overAbstentionRate: 0.125, foreignScopeRate: 0 },
      },
      headroomByMetric: HEADROOM,
      allowLoosening: false,
    });
    expect(caps[8]!.abstentionFalsePositiveRate).toBeCloseTo(0.375, 10);
    expect(caps[8]!.overAbstentionRate).toBeCloseTo(0.125, 10);
    expect(notes.map((n) => n.split(' ')[1])).toEqual(['overAbstentionRate']);
  });
});

/**
 * The new cap carries the same three properties as the other two, plus the one
 * that is only true of it: zero headroom, so a measurement of zero commits a
 * bound of zero and a single foreign row is over it.
 */
describe('the foreign-scope cap', () => {
  function foreignCaps(measured: number, previous: number | undefined, allowLoosening = false) {
    return ratchetCaps({
      label: 'hybrid',
      measuredByK: {
        8: { abstentionFalsePositiveRate: 0, overAbstentionRate: 0, foreignScopeRate: measured },
      },
      previousByK:
        previous === undefined
          ? undefined
          : {
              8: {
                abstentionFalsePositiveRate: 1,
                overAbstentionRate: 1,
                foreignScopeRate: previous,
              },
            },
      headroomByMetric: HEADROOM,
      allowLoosening,
    });
  }

  it('commits exactly zero from a clean measurement, with no headroom added', () => {
    expect(foreignCaps(0, undefined).caps[8]!.foreignScopeRate).toBe(0);
  });

  it('holds at zero when a rewrite after a leak would raise it, and says so', () => {
    const { caps, notes } = foreignCaps(0.125, 0);
    expect(caps[8]!.foreignScopeRate).toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('foreignScopeRate cap held at 0.000');
  });

  it('raises it only when explicitly permitted, and names it in the output', () => {
    const { caps, notes } = foreignCaps(0.125, 0, true);
    expect(caps[8]!.foreignScopeRate).toBeCloseTo(0.125, 10);
    expect(notes.map((n) => n.split(' ')[1])).toEqual(['foreignScopeRate']);
    expect(notes[0]).toContain('LOOSENED');
  });

  it('cannot drift up across repeated regeneration at a flat measurement', () => {
    let cap = foreignCaps(0, undefined).caps[8]!.foreignScopeRate;
    for (let i = 0; i < 5; i++) cap = foreignCaps(0, cap).caps[8]!.foreignScopeRate;
    expect(cap).toBe(0);
  });

  it('fails a run in which one row of many came from another project', () => {
    const failures = checkBounds({
      label: 'hybrid',
      ks: [8],
      measuredByK: {
        8: {
          precisionAtK: 1,
          recallAtK: 1,
          mrr: 1,
          abstentionFalsePositiveRate: 0,
          overAbstentionRate: 0,
          foreignScopeRate: 1 / 160,
        },
      },
      floorsByK: { 8: { precisionAtK: 0.1, recallAtK: 0.95, mrr: 0.6 } },
      capsByK: {
        8: { abstentionFalsePositiveRate: 1, overAbstentionRate: 1, foreignScopeRate: 0 },
      },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('foreignScopeRate regressed');
  });
});

describe('checkBounds', () => {
  const FLOORS = { 8: { precisionAtK: 0.1, recallAtK: 0.95, mrr: 0.6 } };
  const CAPS = {
    8: { abstentionFalsePositiveRate: 0.375, overAbstentionRate: 0.0625, foreignScopeRate: 0 },
  };

  function check(over: Partial<Record<string, number | null>>) {
    return checkBounds({
      label: 'hybrid',
      ks: [8],
      measuredByK: {
        8: {
          precisionAtK: 0.15,
          recallAtK: 1,
          mrr: 0.7,
          abstentionFalsePositiveRate: 0.25,
          overAbstentionRate: 0,
          foreignScopeRate: 0,
          ...over,
        },
      },
      floorsByK: FLOORS,
      capsByK: CAPS,
    });
  }

  it('passes a measurement inside every bound', () => {
    expect(check({})).toEqual([]);
  });

  it('fails a floor metric BELOW its floor and not above it', () => {
    expect(check({ recallAtK: 0.9 })).toHaveLength(1);
    expect(check({ recallAtK: 0.9 })[0]).toContain('recallAtK regressed: 0.900 < committed floor');
    // The opposite direction is an improvement and must not fail.
    expect(check({ recallAtK: 1 })).toEqual([]);
  });

  it('fails a cap metric ABOVE its cap and not below it', () => {
    expect(check({ overAbstentionRate: 0.125 })).toHaveLength(1);
    expect(check({ overAbstentionRate: 0.125 })[0]).toContain(
      'overAbstentionRate regressed: 0.125 > committed cap 0.063',
    );
    // A lower rate is an improvement; comparing a cap like a floor would fail here.
    expect(check({ overAbstentionRate: 0 })).toEqual([]);
    expect(check({ abstentionFalsePositiveRate: 0 })).toEqual([]);
  });

  it('names the metric and both values, so a failure is actionable', () => {
    const [failure] = check({ abstentionFalsePositiveRate: 0.5 });
    expect(failure).toContain('hybrid@8');
    expect(failure).toContain('0.500');
    expect(failure).toContain('0.375');
  });

  it('skips a cap metric whose axis had no queries', () => {
    expect(
      check({
        overAbstentionRate: null,
        abstentionFalsePositiveRate: null,
        foreignScopeRate: null,
      }),
    ).toEqual([]);
  });

  it('gates nothing when the baseline carries no caps block, rather than throwing', () => {
    expect(
      checkBounds({
        label: 'hybrid',
        ks: [8],
        measuredByK: {
          8: {
            precisionAtK: 0.15,
            recallAtK: 1,
            mrr: 0.7,
            abstentionFalsePositiveRate: 1,
            overAbstentionRate: 1,
            foreignScopeRate: 1,
          },
        },
        floorsByK: FLOORS,
        capsByK: undefined,
      }),
    ).toEqual([]);
  });
});
