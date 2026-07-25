import { describe, expect, it } from 'vitest';

import { extractEntities } from './entities.js';

function values(title: string, content: string, kind?: string): string[] {
  const found = extractEntities(title, content);
  return (kind ? found.filter((e) => e.kind === kind) : found).map((e) => e.value);
}

describe('extractEntities — positive matches', () => {
  it('recognizes a file path with a code extension', () => {
    expect(
      values('', 'the bug is in apps/server/src/db/migrate.ts around the pragma', 'path'),
    ).toContain('apps/server/src/db/migrate.ts');
  });

  it('recognizes a dotfile path', () => {
    expect(values('', 'the slug lives in .rembric at the repo root', 'path')).toContain('.rembric');
  });

  it('recognizes a relative path with a leading ./', () => {
    expect(values('', 'run ./scripts/prompt-search.sh to reproduce', 'path')).toContain(
      'scripts/prompt-search.sh',
    );
  });

  it('recognizes a full https URL and trims trailing punctuation', () => {
    expect(
      values('', 'see https://github.com/anthropics/claude-code/issues/282.', 'url'),
    ).toContain('https://github.com/anthropics/claude-code/issues/282');
  });

  it('recognizes a 7-char git short SHA with a digit and a letter', () => {
    expect(values('', 'fixed in commit cfb5c04 yesterday', 'git_ref')).toContain('cfb5c04');
  });

  it('recognizes a full 40-char git SHA', () => {
    const sha = '6840d670c1a2b3d4e5f60718293a4b5c6d7e8f90';
    expect(values('', `landed as ${sha}`, 'git_ref')).toContain(sha);
  });

  it('recognizes a whitelisted errno code', () => {
    expect(
      values(
        '',
        'dev:docker:up dies with SQLITE_CANTOPEN unless data-dev is chowned',
        'error_code',
      ),
    ).toContain('SQLITE_CANTOPEN');
    expect(values('', 'the write failed with ENOENT on a missing dir', 'error_code')).toContain(
      'ENOENT',
    );
  });

  it('recognizes an ERR_ prefixed node error constant', () => {
    expect(values('', 'threw ERR_MODULE_NOT_FOUND on boot', 'error_code')).toContain(
      'ERR_MODULE_NOT_FOUND',
    );
  });

  it('recognizes a generic underscored constant', () => {
    expect(
      values('', 'the server returned PERMISSION_DENIED for that token', 'error_code'),
    ).toContain('PERMISSION_DENIED');
  });

  it('recognizes a JIRA-style ticket id', () => {
    expect(values('', 'tracked as PROJ-1234 in the backlog', 'ticket')).toContain('PROJ-1234');
  });

  it('recognizes a GitHub-style issue reference', () => {
    expect(values('', 'fixed in #282 last week', 'ticket')).toContain('#282');
  });

  it('is reproducible: same input always yields the same output', () => {
    const title = 'apps/server/src/db/migrate.ts and ENOENT and PROJ-99';
    const content = 'see https://example.com/x and cfb5c042';
    expect(extractEntities(title, content)).toEqual(extractEntities(title, content));
  });

  it('extracts across both title and content', () => {
    expect(values('bug in apps/server/src/db/migrate.ts', 'unrelated content', 'path')).toContain(
      'apps/server/src/db/migrate.ts',
    );
  });
});

describe('extractEntities — false-positive fixture corpus (zero tolerance)', () => {
  const PROSE_RESEMBLING_ENTITIES = [
    'e.g. this is not a path, and neither is i.e. or etc.',
    'a solution / an idea, or maybe both',
    'the version is 3.14 and the ratio is 10.0.0.5',
    'v1.2.3 shipped yesterday',
    'An ERROR occurred while EITHER retrying or aborting; EXTRA context helped, ENOUGH said',
    'UTF-8 encoding broke the parser, per ISO-8601 and RFC-822',
    'check the ASCII table or the HTTP-2 spec',
    'the word deface, defaced, and facade all use only hex-like letters',
    'this costs $100 for the item',
    'call it TODO, or NOTE, or leave a URL, API, or JSON blob',
    'a decimal like 1234567 is not a hash, nor is 42',
    'HTML and IEEE and ECMA are just acronyms',
    'the cabbage recipe needs a dash - not a ticket',
  ];

  it.each(PROSE_RESEMBLING_ENTITIES)('yields zero entities for: %s', (text) => {
    expect(extractEntities('', text)).toEqual([]);
  });

  it('does not extract a path from a decimal version number', () => {
    expect(values('', 'bumped to v3.14.159 in package.json release notes', 'path')).not.toContain(
      '3.14.159',
    );
  });
});

describe('extractEntities — adversarial input never throws', () => {
  it('handles a NUL byte embedded in content', () => {
    expect(() => extractEntities('title', 'before\0after apps/x/y.ts')).not.toThrow();
  });

  it('handles a very long single token', () => {
    const long = 'a'.repeat(500_000);
    expect(() => extractEntities('', long)).not.toThrow();
  });

  it('handles mixed scripts and emoji', () => {
    expect(() => extractEntities('日本語 🎉', 'مرحبا apps/server/x.ts 中文 🚀')).not.toThrow();
  });

  it('handles empty strings', () => {
    expect(extractEntities('', '')).toEqual([]);
  });

  it('caps total input so a pathological blob does not hang', () => {
    const huge = 'apps/server/src/x.ts '.repeat(50_000);
    const start = Date.now();
    extractEntities('', huge);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('extractEntities — deduplication and normalization', () => {
  it('deduplicates the same entity mentioned twice', () => {
    const found = values('', 'see apps/x.ts and again apps/x.ts', 'path');
    expect(found.filter((v) => v === 'apps/x.ts')).toHaveLength(1);
  });

  it('normalizes a leading ./ away', () => {
    expect(values('', './apps/server/x.ts', 'path')).toContain('apps/server/x.ts');
  });

  it('does not match a mixed-case token (real git SHAs are always lowercase)', () => {
    expect(values('', 'ABCdef1', 'git_ref')).toEqual([]);
  });
});
