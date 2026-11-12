import { describe, expect, it } from 'vitest';

import { SAVE_TIME_BASE, SAVE_TIME_SAVES } from './save-time-fixture.js';
import { runSaveTimeArm, summarize, widestPlateau } from './save-time-sweep.js';

describe('save-time calibration sweep', () => {
  it('writes the same pending rows at floor 0 as rank-only admission', async () => {
    const atZero = await runSaveTimeArm(null, 0);
    const rankOnly = await runSaveTimeArm(null, Number.NEGATIVE_INFINITY);
    expect(atZero).toEqual(rankOnly);
    expect(summarize(0, atZero).totalRows).toBeGreaterThan(0);
  });

  it('produces identical output on unchanged inputs', async () => {
    const first = await runSaveTimeArm(null, 0.3);
    const second = await runSaveTimeArm(null, 0.3);
    expect(second).toEqual(first);
  });

  it('a higher floor writes fewer rows over the same fixture', async () => {
    const low = summarize(0, await runSaveTimeArm(null, 0)).totalRows;
    const high = summarize(0.6, await runSaveTimeArm(null, 0.6)).totalRows;
    expect(high).toBeLessThan(low);
  });

  it('labels every non-unrelated save with a base item that exists', () => {
    const baseIds = new Set(SAVE_TIME_BASE.map((b) => b.id));
    for (const s of SAVE_TIME_SAVES) {
      if (s.class === 'unrelated') expect(s.expects).toBeUndefined();
      else expect(baseIds.has(s.expects ?? '')).toBe(true);
    }
  });
});

describe('widestPlateau', () => {
  const floors = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3];

  it('picks the widest admissible run and its grid midpoint', () => {
    const ok = [true, false, true, true, true, true, false];
    expect(widestPlateau(floors, ok)).toEqual({ from: 0.1, to: 0.25, width: 0.15, chosen: 0.15 });
  });

  it('returns null when nothing is admissible', () => {
    expect(
      widestPlateau(
        floors,
        floors.map(() => false),
      ),
    ).toBeNull();
  });

  it('measures a run that reaches the last grid point', () => {
    const ok = [false, false, false, false, true, true, true];
    expect(widestPlateau(floors, ok)).toEqual({ from: 0.2, to: 0.3, width: 0.1, chosen: 0.25 });
  });
});
