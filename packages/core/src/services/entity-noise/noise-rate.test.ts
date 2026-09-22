import { ENTITY_KINDS } from '@rembric/db';
import { describe, expect, it } from 'vitest';

import { NOISE_PROBES, PUBLISHED_NOISE } from './corpus.js';
import { measureLexicalNoise, noisePercent } from './measure.js';

describe('entity kinds — lexical noise measurement', () => {
  const measured = measureLexicalNoise();

  it('every declared entity kind has at least one probe', () => {
    const covered = new Set(NOISE_PROBES.map((p) => p.kind));
    for (const kind of ENTITY_KINDS) {
      expect(covered, `${kind} has no noise probe — add one before publishing a figure`).toContain(
        kind,
      );
    }
  });

  it('every probe declares a truth document the lexical branch actually returns', () => {
    for (const r of measured) {
      for (const p of r.results) {
        expect(p.truthMatched, `${p.probe.identifier}: truth document not retrieved`).toBe(true);
      }
    }
  });

  it('the published table matches the measurement', () => {
    const actual = Object.fromEntries(measured.map((r) => [r.group, noisePercent(r.noiseRate)]));
    expect(actual).toEqual(PUBLISHED_NOISE);
  });

  it('every reporting group carries a published figure, and vice versa', () => {
    const groups = new Set(measured.map((r) => r.group));
    for (const group of Object.keys(PUBLISHED_NOISE)) {
      expect(groups, `${group} is published but has no probe`).toContain(group);
    }
  });
});
