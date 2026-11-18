import { beforeAll, describe, expect, it } from 'vitest';

import {
  CANDIDATE_HIGH_BAND_FLOOR,
  CANDIDATE_LOW_BAND_CEILING,
  embeddingInput,
  loadEmbedder,
  VEC_THRESHOLD,
  type Embedder,
} from '@rembric/core';

import {
  SAVE_TIME_BASE,
  SAVE_TIME_RELATED_SAVES,
  SAVE_TIME_SAVES,
  type SaveTimeClass,
} from '../test-support/retrieval/save-time-fixture.js';

const cosine = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

describe('save-time constants are calibrated to the compiled-in embedding model (real embedder)', () => {
  let embedder: Embedder;
  const toTarget = new Map<SaveTimeClass, number[]>();
  const toOthers: number[] = [];

  beforeAll(async () => {
    embedder = await loadEmbedder();
    const base = new Map<string, Float32Array>();
    for (const b of SAVE_TIME_BASE)
      base.set(b.id, await embedder.embed(embeddingInput(b.title, b.content)));
    for (const s of [...SAVE_TIME_SAVES, ...SAVE_TIME_RELATED_SAVES]) {
      const v = await embedder.embed(embeddingInput(s.title, s.content));
      for (const [id, b] of base) {
        if (id === s.expects) {
          const list = toTarget.get(s.class) ?? [];
          list.push(cosine(v, b));
          toTarget.set(s.class, list);
        } else {
          toOthers.push(cosine(v, b));
        }
      }
    }
  }, 120_000);

  it('admits every labelled duplicate, rewrite and contradiction through the dense channel', () => {
    for (const cls of ['near-duplicate', 'expanded-rewrite', 'contradiction'] as const) {
      expect(Math.min(...toTarget.get(cls)!), cls).toBeGreaterThanOrEqual(VEC_THRESHOLD);
    }
  });

  it('admits no pair whose save is about a different base memory', () => {
    expect(Math.max(...toOthers)).toBeLessThan(VEC_THRESHOLD);
  });

  it('keeps every contradiction above the low band, so a vector-only one is still judged', () => {
    expect(Math.min(...toTarget.get('contradiction')!)).toBeGreaterThanOrEqual(
      CANDIDATE_LOW_BAND_CEILING,
    );
  });

  it('puts every near-duplicate, and no rewrite or contradiction, in the high band', () => {
    expect(Math.min(...toTarget.get('near-duplicate')!)).toBeGreaterThanOrEqual(
      CANDIDATE_HIGH_BAND_FLOOR,
    );
    for (const cls of ['expanded-rewrite', 'contradiction'] as const) {
      expect(Math.max(...toTarget.get(cls)!), cls).toBeLessThan(CANDIDATE_HIGH_BAND_FLOOR);
    }
  });
});
