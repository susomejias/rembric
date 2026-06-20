import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseKeyLearnings } from './observability-tools.js';

describe('parseKeyLearnings — capture_passive parser', () => {
  it('returns [] when no Key Learnings section exists', () => {
    expect(parseKeyLearnings('## Other section\n- item one')).toEqual([]);
    expect(parseKeyLearnings('plain text without any heading')).toEqual([]);
  });

  it('extracts numbered items', () => {
    const text = `## Key Learnings:

1. bcrypt cost=12 is the right balance
2. JWT refresh tokens need atomic rotation
3. session timeouts should be 24h not 7d`;
    expect(parseKeyLearnings(text)).toEqual([
      'bcrypt cost=12 is the right balance',
      'JWT refresh tokens need atomic rotation',
      'session timeouts should be 24h not 7d',
    ]);
  });

  it('extracts bulleted items', () => {
    const text = `## Key Learnings:

- alpha
* beta
- gamma`;
    expect(parseKeyLearnings(text)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('stops at the next H2', () => {
    const text = `## Key Learnings:

1. one
2. two

## Next Section

3. should not appear`;
    expect(parseKeyLearnings(text)).toEqual(['one', 'two']);
  });

  it('is case-sensitive on the heading', () => {
    expect(parseKeyLearnings('## key learnings:\n1. nope')).toEqual([]);
    expect(parseKeyLearnings('## KEY LEARNINGS:\n1. nope')).toEqual([]);
  });

  it('property: number of extracted items equals the number of well-formed list lines (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 40 }).map((s) => s.replace(/\n/g, ' ')),
          {
            minLength: 1,
            maxLength: 8,
          },
        ),
        fc.array(fc.constantFrom('-', '*', '1.', '2.', '3.'), { minLength: 1, maxLength: 8 }),
        (items, markers) => {
          const n = Math.min(items.length, markers.length);
          const usedItems = items.slice(0, n).map((s) => s.trim() || 'placeholder');
          const lines = usedItems.map((it, i) => `${markers[i]} ${it}`);
          const text = `## Key Learnings:\n\n${lines.join('\n\n')}\n\n## Done`;
          const parsed = parseKeyLearnings(text);
          expect(parsed.length).toBe(n);
          expect(parsed).toEqual(usedItems);
        },
      ),
    );
  });

  it('tolerates blank lines and mixed list markers', () => {
    const text = `## Key Learnings:


1. first


* second

- third
   4. fourth`;
    expect(parseKeyLearnings(text)).toEqual(['first', 'second', 'third', 'fourth']);
  });
});
