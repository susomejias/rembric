import { describe, expect, it } from 'vitest';

import { SAVE_TIME_BASE, SAVE_TIME_RELATED_SAVES, SAVE_TIME_SAVES } from './save-time-fixture.js';
import {
  runSaveTimeArm,
  summarize,
  summarizeBands,
  widestPlateau,
  type SaveOutcome,
} from './save-time-sweep.js';

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
    for (const s of [...SAVE_TIME_SAVES, ...SAVE_TIME_RELATED_SAVES]) {
      if (s.class === 'unrelated') expect(s.expects).toBeUndefined();
      else expect(baseIds.has(s.expects ?? '')).toBe(true);
    }
  });
});

describe('save-time band composition', () => {
  it('without an embedder every cosine is unknown, so the bands change no pending row', async () => {
    const fixture = {
      base: SAVE_TIME_BASE,
      saves: [...SAVE_TIME_SAVES, ...SAVE_TIME_RELATED_SAVES],
    };
    const off = await runSaveTimeArm(null, 0.6, fixture, false);
    const on = await runSaveTimeArm(null, 0.6, fixture, true);
    expect(on).toEqual(off);
    expect(on.every((o) => o.bands.low === 0 && o.bands.high === 0)).toBe(true);
  });

  it('counts rows per band and where each expected target landed', () => {
    const outcome = (
      cls: SaveOutcome['class'],
      bands: SaveOutcome['bands'],
      expectedBand: SaveOutcome['expectedBand'],
      pending: number,
    ): SaveOutcome => ({
      id: cls,
      class: cls,
      surfacedExpected:
        cls === 'unrelated' ? null : expectedBand === 'high' || expectedBand === 'middle',
      sources: Array.from({ length: pending }, () => 'vec' as const),
      bands,
      expectedBand,
    });
    const off = [outcome('related', { low: 0, middle: 3, high: 0 }, 'middle', 3)];
    const on = [
      outcome('related', { low: 2, middle: 1, high: 0 }, 'low', 1),
      outcome('related', { low: 0, middle: 0, high: 0 }, null, 0),
    ];
    const related = summarizeBands(off, on).find((r) => r.class === 'related');
    expect(related).toEqual({
      class: 'related',
      saves: 2,
      pendingWithoutBands: 3,
      bands: { high: 0, middle: 1, low: 2 },
      expected: { high: 0, middle: 0, low: 1, missed: 1 },
    });
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
