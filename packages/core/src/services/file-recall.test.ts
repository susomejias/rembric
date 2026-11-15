import { describe, expect, it } from 'vitest';

import {
  candidateValues,
  FILE_RECALL_MAX_BYTES,
  normalizeRepoPath,
  renderFileRecall,
  type FileRecallEntry,
} from '@rembric/core';

const entry = (over: Partial<FileRecallEntry> & { id: string }): FileRecallEntry => ({
  title: `Title ${over.id}`,
  content: 'content',
  createdAt: new Date('2026-11-01T10:00:00Z'),
  needsReview: false,
  ...over,
});

describe('normalizeRepoPath', () => {
  it('normalises the way path entities are stored', () => {
    expect(normalizeRepoPath('./src\\a.ts')).toBe('src/a.ts');
    expect(normalizeRepoPath('src//lib///b.ts')).toBe('src/lib/b.ts');
    expect(normalizeRepoPath('packages/db/src/migrate.ts')).toBe('packages/db/src/migrate.ts');
  });

  it('refuses anything that is not repo-relative', () => {
    for (const p of ['', '/etc/hosts', 'C:/x.ts', '../other/x.ts', 'a/../b.ts', 'dir/']) {
      expect(normalizeRepoPath(p), p).toBeNull();
    }
  });
});

describe('candidateValues', () => {
  const path = 'packages/core/src/services/review.ts';

  it('adds every 2+ segment suffix that only the requested file owns', () => {
    expect(candidateValues(path, [path])).toEqual([
      path,
      'core/src/services/review.ts',
      'src/services/review.ts',
      'services/review.ts',
    ]);
  });

  it('drops a suffix another tracked file shares, keeping the longer unique ones', () => {
    const other = 'apps/web/src/services/review.ts';
    expect(candidateValues(path, [path, other])).toEqual([path, 'core/src/services/review.ts']);
  });

  it('never tries a bare file name', () => {
    expect(candidateValues('src/a.ts', ['src/a.ts'])).toEqual(['src/a.ts']);
  });

  it('tries only the exact path when siblings are absent or do not name the path', () => {
    expect(candidateValues(path, [])).toEqual([path]);
    expect(candidateValues(path, ['apps/web/src/services/review.ts'])).toEqual([path]);
  });
});

describe('renderFileRecall', () => {
  it('renders a header, dated lines, and a window under the first memory only', () => {
    const { lines, renderedIds } = renderFileRecall('src/app.ts', [
      entry({ id: 'A', content: 'before src/app.ts after' }),
      entry({ id: 'B', content: 'other text about src/app.ts', needsReview: true }),
    ]);
    expect(lines).toEqual([
      'rembric: memories about src/app.ts:',
      '- Title A [A] (2026-11-01)',
      '  before src/app.ts after',
      '- Title B [B] (2026-11-01, needs review)',
    ]);
    expect(renderedIds).toEqual(['A', 'B']);
  });

  it('centres a 300-character window on the mention and marks the cuts', () => {
    const content = `${'x'.repeat(1000)} app.ts ${'y'.repeat(1000)}`;
    const { lines } = renderFileRecall('src/app.ts', [entry({ id: 'A', content })]);
    const window = lines[2]!;
    expect(window.startsWith('  …')).toBe(true);
    expect(window.endsWith('…')).toBe(true);
    expect(window).toContain('app.ts');
    expect(Array.from(window.slice(3, -1))).toHaveLength(300);
  });

  it('redacts a secret before cutting the window', () => {
    const secret = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const { lines } = renderFileRecall('src/app.ts', [
      entry({ id: 'A', content: `src/app.ts uses token ${secret} for auth` }),
    ]);
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).not.toContain('A1b2C3d4E5f6');
  });

  it('stays within the byte bound with multibyte text, shrinking the window before dropping lines', () => {
    const title = 'é'.repeat(100);
    const { lines, renderedIds } = renderFileRecall('src/app.ts', [
      entry({ id: 'A', title, content: '漢'.repeat(2000) }),
      entry({ id: 'B', title }),
      entry({ id: 'C', title }),
    ]);
    expect(Buffer.byteLength(lines.join('\n'), 'utf8')).toBeLessThanOrEqual(FILE_RECALL_MAX_BYTES);
    expect(lines[0]).toBe('rembric: memories about src/app.ts:');
    expect(lines[1]).toContain('[A]');
    expect(renderedIds[0]).toBe('A');
    expect(lines.join('\n')).not.toContain('\uFFFD');
  });

  it('drops trailing memories when even a windowless block is too big, and reports only the kept ones', () => {
    const title = '𝔸'.repeat(100);
    const many = ['A', 'B', 'C'].map((id) => entry({ id, title }));
    const { lines, renderedIds } = renderFileRecall('src/app.ts', many);
    expect(Buffer.byteLength(lines.join('\n'), 'utf8')).toBeLessThanOrEqual(FILE_RECALL_MAX_BYTES);
    expect(renderedIds.length).toBeLessThan(3);
    expect(renderedIds).toEqual(
      lines.filter((l) => l.startsWith('- ')).map((l) => /\[(\w)\]/.exec(l)![1]),
    );
  });
});
