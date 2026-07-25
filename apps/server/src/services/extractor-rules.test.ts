import { describe, expect, it } from 'vitest';

import { ENTITY_KINDS } from '../db/schema/entities.js';

import { applyRule, EXTRACTOR_RULES } from './extractor-rules.js';

/**
 * Registry-driven: every assertion here is derived from the rules themselves,
 * so a new kind is covered the moment it is declared — the point of moving the
 * patterns into a registry in the first place.
 */

describe('extractor registry — structural invariants', () => {
  it('every rule pattern is global (matchAll would throw otherwise)', () => {
    for (const rule of EXTRACTOR_RULES) {
      expect(rule.pattern.flags, `${rule.kind} pattern must be /g`).toContain('g');
    }
  });

  it('every rule declares at least one example and one reject', () => {
    for (const rule of EXTRACTOR_RULES) {
      expect(rule.examples.length, `${rule.kind} needs examples`).toBeGreaterThan(0);
      expect(rule.rejects.length, `${rule.kind} needs rejects`).toBeGreaterThan(0);
    }
  });

  it('every rule kind is a declared ENTITY_KIND', () => {
    for (const rule of EXTRACTOR_RULES) {
      expect(ENTITY_KINDS).toContain(rule.kind);
    }
  });

  it('every declared ENTITY_KIND has at least one rule producing it', () => {
    const covered = new Set(EXTRACTOR_RULES.map((r) => r.kind));
    for (const kind of ENTITY_KINDS) {
      expect(covered, `${kind} has no extractor rule`).toContain(kind);
    }
  });

  it('a capture group is only requested where the pattern has one', () => {
    for (const rule of EXTRACTOR_RULES) {
      if (rule.capture === undefined || rule.capture === 0) continue;
      const groups = new RegExp(`${rule.pattern.source}|`).exec('')!.length - 1;
      expect(groups, `${rule.kind} requests group ${rule.capture}`).toBeGreaterThanOrEqual(
        rule.capture,
      );
    }
  });
});

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();

describe('extractor registry — declared examples must match, and match nothing else', () => {
  for (const rule of EXTRACTOR_RULES) {
    for (const ex of rule.examples) {
      it(`${rule.kind}: ${JSON.stringify(ex.text.slice(0, 48))}`, () => {
        // Set equality, not `toContain`: a containment assertion cannot see
        // over-extraction, which is how a truncated `path` value shipped green
        // alongside the correct one.
        expect(unique(applyRule(rule, ex.text))).toEqual(unique(ex.values));
      });
    }
  }
});

describe('extractor registry — declared rejects must NOT match', () => {
  for (const rule of EXTRACTOR_RULES) {
    for (const text of rule.rejects) {
      it(`${rule.kind}: ${JSON.stringify(text.slice(0, 48))}`, () => {
        expect(applyRule(rule, text)).toEqual([]);
      });
    }
  }
});

describe('extractor registry — cross-rule isolation', () => {
  it("no rule matches another rule's rejects for its own kind", () => {
    // A reject declared for one rule is prose as far as its KIND is concerned,
    // so a sibling rule of the SAME kind must not resurrect it (this is what
    // guards the two-rule `ticket` and `error_code` pairs against each other).
    for (const rule of EXTRACTOR_RULES) {
      const siblings = EXTRACTOR_RULES.filter((r) => r !== rule && r.kind === rule.kind);
      for (const sibling of siblings) {
        for (const text of rule.rejects) {
          expect(applyRule(sibling, text), `${sibling.kind} resurrected ${text}`).toEqual([]);
        }
      }
    }
  });

  it("a rule may only match another kind's reject when it claims that value as its own example", () => {
    // Rejects were previously only run against rules of the same kind, so a
    // pattern could quietly claim another kind's prose. Some rejects ARE
    // another kind's identifier — `uuid` rejects a git SHA on purpose — and
    // those are legitimate exactly when the matching rule declares that value
    // among its own examples. Anything else is a cross-kind false positive.
    for (const rule of EXTRACTOR_RULES) {
      for (const other of EXTRACTOR_RULES) {
        if (other === rule) continue;
        const claimed = new Set(other.examples.flatMap((ex) => ex.values));
        for (const text of rule.rejects) {
          for (const value of applyRule(other, text)) {
            expect(
              claimed,
              `${other.kind} matched ${JSON.stringify(value)} in ${rule.kind}'s reject ${JSON.stringify(text)} without declaring it as an example`,
            ).toContain(value);
          }
        }
      }
    }
  });
});

describe('applyRule — bounds', () => {
  it('drops a match longer than the token cap', () => {
    const rule = EXTRACTOR_RULES.find((r) => r.kind === 'url')!;
    const long = `https://example.com/${'a'.repeat(400)}`;
    expect(applyRule(rule, long, 300)).toEqual([]);
    expect(applyRule(rule, long, 1000)).toHaveLength(1);
  });

  it('is reproducible across repeated application (lastIndex is not leaked)', () => {
    for (const rule of EXTRACTOR_RULES) {
      for (const ex of rule.examples) {
        expect(applyRule(rule, ex.text)).toEqual(applyRule(rule, ex.text));
      }
    }
  });
});
