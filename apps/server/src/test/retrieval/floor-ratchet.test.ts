import { describe, expect, it } from 'vitest';

import { ratchetFloors } from './floor-ratchet.js';

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
