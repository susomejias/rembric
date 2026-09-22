import { ENTITY_KINDS } from '@rembric/db';
import { describe, expect, it } from 'vitest';

import { applyRule, EXTRACTOR_RULES } from '@rembric/core';

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
