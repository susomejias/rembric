import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { hasAnyHeading, mergeSummarySections, parseSummarySections } from './summary-sections.js';

describe('mergeSummarySections', () => {
  it('updates one section and preserves the others (partial write)', () => {
    const stored = '## Goal\nShip X\n## Files\nsrc/a.ts';
    const incoming = '## Files\nsrc/a.ts, src/b.ts';
    expect(mergeSummarySections(stored, incoming)).toBe(
      '## Goal\nShip X\n## Files\nsrc/a.ts, src/b.ts',
    );
  });

  it('replaces a section outright rather than appending to it', () => {
    const stored = '## Goal\nShip X';
    const incoming = '## Goal\nShip Y';
    const merged = mergeSummarySections(stored, incoming);
    expect(merged).toBe('## Goal\nShip Y');
    expect(merged).not.toContain('Ship X');
  });

  it('appends a heading only the write carries, after the stored sections', () => {
    const stored = '## Goal\nShip X\n## Files\nsrc/a.ts';
    const incoming = '## Risks\nflaky test';
    expect(mergeSummarySections(stored, incoming)).toBe(
      '## Goal\nShip X\n## Files\nsrc/a.ts\n## Risks\nflaky test',
    );
  });

  it('keeps the stored order even when the write reorders shared headings', () => {
    const stored = '## Goal\nA\n## Files\nB';
    const incoming = '## Files\nB2\n## Goal\nA2';
    expect(mergeSummarySections(stored, incoming)).toBe('## Goal\nA2\n## Files\nB2');
  });

  it('matches headings ignoring case and surrounding whitespace', () => {
    const stored = '## Files\nsrc/a.ts';
    const incoming = '##   files  \nsrc/b.ts';
    const merged = mergeSummarySections(stored, incoming);
    expect(merged).toBe('##   files  \nsrc/b.ts');
    expect(parseSummarySections(merged)).toHaveLength(1);
  });

  it('does not treat a `##` line inside a fenced code block as a section boundary', () => {
    const stored = '## Files\n```\n## Goal\n```\nsrc/a.ts';
    const incoming = '## Goal\nShip X';
    const merged = mergeSummarySections(stored, incoming);
    expect(merged).toBe('## Files\n```\n## Goal\n```\nsrc/a.ts\n## Goal\nShip X');
    const sections = parseSummarySections(merged);
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.key)).toEqual(['files', 'goal']);
  });

  it('stores a section carried with an empty body as empty rather than removing it', () => {
    const stored = '## Goal\nA\n## Unfinished+why\nblocked on Y';
    const incoming = '## Unfinished+why\n';
    const merged = mergeSummarySections(stored, incoming);
    expect(merged).toBe('## Goal\nA\n## Unfinished+why\n');
    expect(merged).toContain('## Unfinished+why');
    expect(merged).toContain('## Goal\nA');
  });

  it('concatenates a duplicate stored heading once, at its first occurrence', () => {
    const stored = '## Goal\nA\n## Files\nB\n## Goal\nC';
    const sections = parseSummarySections(stored);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ key: 'goal' });
    expect(sections[0]!.body.map((l) => l.text)).toEqual(['A', 'C']);
    expect(sections[1]).toMatchObject({ key: 'files' });
  });

  it('reproduces the stored bytes exactly when nothing changes', () => {
    const stored = '## Goal\nA\n## Files\nB';
    expect(mergeSummarySections(stored, '## Files\nB')).toBe(stored);
  });

  it('is the identity when merged with itself, including a preamble, blank lines, ### subheadings and a fence', () => {
    const doc =
      'A preamble line.\n\n## Goal\nShip X\n\n### Sub-decision\ndetail\n## Files\n```\ncode\n```\nsrc/a.ts\n';
    expect(mergeSummarySections(doc, doc)).toBe(doc);
  });

  it('treats a level-3+ heading as body text of the enclosing section', () => {
    const stored = '## Decisions+why\n### Sub-decision\ndetail';
    const sections = parseSummarySections(stored);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.key).toBe('decisions+why');
    expect(sections[0]!.body.map((l) => l.text)).toEqual(['### Sub-decision', 'detail']);
  });

  it('treats text before the first heading as a section with an empty key', () => {
    const doc = 'preamble\n## Goal\nA';
    const sections = parseSummarySections(doc);
    expect(sections[0]).toMatchObject({ key: '' });
    expect(sections[0]!.body.map((l) => l.text)).toEqual(['preamble']);
  });

  it('recognises both \\n and \\r\\n as line breaks', () => {
    const doc = '## Goal\r\nA\r\n## Files\nB';
    const sections = parseSummarySections(doc);
    expect(sections.map((s) => s.key)).toEqual(['goal', 'files']);
    expect(mergeSummarySections(doc, doc)).toBe(doc);
  });
});

describe('hasAnyHeading', () => {
  it('is false for a flat paragraph with no ## heading', () => {
    expect(hasAnyHeading('Fixed the CI formatting job.')).toBe(false);
  });

  it('is true when at least one ## heading is present', () => {
    expect(hasAnyHeading('## Accomplished\ndid the thing')).toBe(true);
  });

  it('ignores a `##` line inside a fenced code block', () => {
    expect(hasAnyHeading('```\n## not a heading\n```')).toBe(false);
  });
});

describe('purity', () => {
  it('imports no Date, repository or db module, and calls no Date constructor', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./summary-sections.ts', import.meta.url)),
      'utf8',
    );
    const importLines = src
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line))
      .join('\n');
    expect(src).not.toMatch(/\bnew Date\(/);
    expect(src).not.toMatch(/\bDate\.now\(/);
    expect(importLines).toBe('');
  });
});
