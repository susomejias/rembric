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

  it('recognizes a CVE id and normalizes to uppercase', () => {
    expect(values('', 'affected by cve-2024-3094 in xz-utils', 'cve_id')).toContain(
      'CVE-2024-3094',
    );
  });

  it('does not also extract a CVE id as a JIRA-style ticket', () => {
    expect(values('', 'affected by CVE-2024-3094 in xz-utils', 'ticket')).toEqual([]);
  });

  it('recognizes an IPv4 address', () => {
    expect(values('', 'the NAS is reachable at 192.168.1.50 on the LAN', 'ip_address')).toContain(
      '192.168.1.50',
    );
  });

  it('recognizes an IPv4 address with a CIDR suffix', () => {
    expect(values('', 'the docker bridge uses 172.18.0.0/16', 'ip_address')).toContain(
      '172.18.0.0/16',
    );
  });

  it('recognizes a homelab hostname', () => {
    expect(values('', 'check plex.home for the new library', 'hostname')).toContain('plex.home');
    expect(values('', 'ssh into nas.local to grab the logs', 'hostname')).toContain('nas.local');
  });

  it('normalizes a hostname to lowercase', () => {
    expect(values('', 'reach NAS.LOCAL from any device', 'hostname')).toContain('nas.local');
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
    'the version is 3.14 and the ratio is 10 to 1',
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
    'e.g. or i.e. or etc. are not hostnames',
    'see fig. 2 in the appendix, or ch. 4 for background',
    'a public domain like example.com is not extracted bare (no scheme)',
    'the value 999.1.1.1 is not a valid IP (out of octet range)',
    // Observed in a production index as `path` entities: a property access, a
    // file type, an identifier fragment, and this product's own placeholder
    // session title. None is an address, and none has a `/`.
    'the .length property is undefined',
    'run the .sql migrations by hand',
    'spawn returns a .child handle',
    'the .HERMES marker is written',
  ];

  it.each(PROSE_RESEMBLING_ENTITIES)('yields zero entities for: %s', (text) => {
    expect(extractEntities('', text)).toEqual([]);
  });

  it('does not extract a path from a decimal version number', () => {
    expect(values('', 'bumped to v3.14.159 in package.json release notes', 'path')).not.toContain(
      '3.14.159',
    );
  });

  it('admits a bare dotfile name only in the case it is listed in', () => {
    expect(values('', 'the slug lives in .rembric at the root', 'path')).toEqual(['.rembric']);
    expect(values('', 'the slug lives in .Rembric at the root', 'path')).toEqual([]);
  });

  it('still extracts a dotfile-led path whose bare form is unlisted', () => {
    expect(values('', 'wrote to .hermes/config.yaml last night', 'path')).toContain(
      '.hermes/config.yaml',
    );
  });

  // Membership is on the first segment, so a listed name may carry more. Both
  // of these appear in this repo's own README and specs, so admitting only the
  // bare form was a recall loss on exactly the identifiers the index is for.
  it('admits further segments on a listed dotfile name', () => {
    expect(values('', 'use .env.example as a template', 'path')).toEqual(['.env.example']);
    expect(values('', 'see .mcp.json for the server config', 'path')).toEqual(['.mcp.json']);
  });

  it('does not admit a longer word that merely starts with a listed name', () => {
    expect(values('', 'a .envelope of data arrived', 'path')).toEqual([]);
  });

  it('does not admit a doubled dot', () => {
    expect(values('', 'a .env..example typo', 'path')).toEqual([]);
  });

  // The narrowing's own spec forbids silencing prose by also dropping real
  // addresses. These are every dotfile `git ls-files` reports for this repo, so
  // the suite fails if a future trim of the list loses one. CLAUDE.md names
  // several of them bare, which is how they reach a memory in the first place.
  it.each([
    '.agents',
    '.claude',
    '.claude-plugin',
    '.codegraph',
    '.codex',
    '.codex-plugin',
    '.devcontainer',
    '.dockerignore',
    '.editorconfig',
    '.env.example',
    '.github',
    '.gitignore',
    '.gitkeep',
    '.hermes-plugin',
    '.husky',
    '.mcp.json',
    '.npmignore',
    '.npmrc',
    '.nvmrc',
    '.opencode',
    '.opencode-plugin',
    '.openspec.yaml',
    '.prettierignore',
    '.prettierrc',
    '.release-please-manifest.json',
    '.rembric',
  ])('still extracts the tracked dotfile %s', (name) => {
    expect(values('', `the carrier lives in ${name} at the root`, 'path')).toEqual([name]);
  });
});

describe('extractEntities — per-memory budget', () => {
  /** `MAX_ENTITIES`, hardcoded: the bound is contract, not an implementation detail. */
  const BOUND = 250;
  const paths = (n: number): string =>
    Array.from({ length: n }, (_, i) => `node_modules/pkg${i}/dist/index.js`).join('\n');
  const FIVE_KIND_TAIL =
    'fixed in #4242, failed with ENOENT, set $DEPLOY_TOKEN, commit cfb5c04, host nas.local';
  const OTHER_KINDS = ['ticket', 'error_code', 'env_var', 'git_ref', 'hostname'];

  it('does not let a dominant kind starve the others', () => {
    const found = extractEntities('', `${paths(400)}\n${FIVE_KIND_TAIL}`);
    expect(found.length).toBeLessThanOrEqual(BOUND);
    const kinds = new Set(found.map((e) => e.kind));
    for (const kind of OTHER_KINDS) expect(kinds).toContain(kind);
    // Fair share, not an equal one: the paths still take all but the five slots.
    expect(found.filter((e) => e.kind === 'path')).toHaveLength(BOUND - OTHER_KINDS.length);
  });

  it('lets a single-kind memory consume the whole bound', () => {
    const found = extractEntities('', paths(BOUND + 50));
    expect(found).toHaveLength(BOUND);
    expect(new Set(found.map((e) => e.kind))).toEqual(new Set(['path']));
  });

  it('respects the bound on a dump of thousands of identifiers across many kinds', () => {
    const dump = Array.from(
      { length: 2000 },
      (_, i) => `apps/f${i}.ts PROJ-${i} 10.0.0.${i % 256} $VAR_${i} host${i}.local`,
    ).join('\n');
    expect(extractEntities('', dump).length).toBeLessThanOrEqual(BOUND);
  });

  // Exactly, not at-most. Three kinds of 300 give a fair share of 83 and a total
  // of 249, so the last slot only lands if the remainder is redistributed —
  // mutation testing showed every set-equality test passes without that pass,
  // because dropping it under-fills uniformly and permutations still agree.
  it('fills the bound exactly when the fair share leaves a remainder', () => {
    const contested = [
      Array.from({ length: 300 }, (_, i) => `src/mod${i}/index.ts`).join('\n'),
      Array.from({ length: 300 }, (_, i) => `#${1000 + i}`).join(' '),
      Array.from({ length: 300 }, (_, i) => `$DEPLOY_TOKEN_${1000 + i}`).join(' '),
    ].join('\n');
    const found = extractEntities('', contested);
    expect(found).toHaveLength(BOUND);
    expect(new Set(found.map((e) => e.kind))).toEqual(new Set(['path', 'ticket', 'env_var']));
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

  it('stays linear on the hostname/path label shape that was once quadratic', () => {
    // `a.` repeated is the adversarial input for the label-group patterns: it
    // is one continuous run of dot-separated labels, which the nested-
    // quantifier form of HOSTNAME_RE walked in 19s at this size. Budget is
    // deliberately far below the 2s hang guard above — a regression here is a
    // complexity change, not a slow machine.
    const pathological = 'a.'.repeat(100_000);
    const start = performance.now();
    extractEntities('', pathological);
    expect(performance.now() - start).toBeLessThan(50);
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
