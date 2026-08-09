import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  affectedCapabilities,
  checkProvenance,
  isEmptyRange,
  parseNameStatus,
  resolveRange,
} from './check-spec-provenance.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * `cwd` does NOT isolate a git child: `GIT_DIR` overrides it, and git exports
 * `GIT_DIR` and `GIT_INDEX_FILE` to every hook. Run under a pre-push hook these
 * fixtures therefore committed into the real repository — observed moving HEAD
 * and truncating the index to the fixture's single file.
 */
const GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
] as const;

const ISOLATED_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ...Object.fromEntries(GIT_ENV_KEYS.map((k) => [k, undefined])),
};

// Scrubbing the spawn env is not enough: these tests also call library helpers
// that shell out to git in-process, and those inherit `process.env`. Clear the
// variables for the whole file so neither route can escape to the real repo.
const savedGitEnv: Partial<Record<(typeof GIT_ENV_KEYS)[number], string>> = {};
beforeAll(() => {
  for (const key of GIT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) savedGitEnv[key] = value;
    delete process.env[key];
  }
});
afterAll(() => {
  for (const key of GIT_ENV_KEYS) {
    const value = savedGitEnv[key];
    if (value !== undefined) process.env[key] = value;
  }
});

const nameStatus = (...lines: string[]) => parseNameStatus(`${lines.join('\n')}\n`);

describe('parseNameStatus', () => {
  it('reads adds, modifies, deletes and scored renames', () => {
    expect(
      nameStatus(
        'M\topenspec/specs/mcp-api/spec.md',
        'A\tsrc/new.ts',
        'D\tsrc/old.ts',
        'R100\topenspec/changes/x/proposal.md\topenspec/changes/archive/2026-01-01-x/proposal.md',
        'C075\ta.md\tb.md',
      ),
    ).toEqual([
      { status: 'M', path: 'openspec/specs/mcp-api/spec.md' },
      { status: 'A', path: 'src/new.ts' },
      { status: 'D', path: 'src/old.ts' },
      {
        status: 'R',
        path: 'openspec/changes/x/proposal.md',
        newPath: 'openspec/changes/archive/2026-01-01-x/proposal.md',
      },
      { status: 'C', path: 'a.md', newPath: 'b.md' },
    ]);
  });

  it('ignores blank and malformed lines', () => {
    expect(parseNameStatus('\nM\n\nR100\tonly-one-path\n')).toEqual([]);
  });

  it('only treats openspec/specs/<cap>/spec.md as a published spec', () => {
    expect(
      affectedCapabilities(
        nameStatus(
          'M\topenspec/specs/mcp-api/spec.md',
          'M\topenspec/specs/README.md',
          'M\topenspec/specs/mcp-api/notes.md',
          'M\topenspec/changes/active/specs/mcp-api/spec.md',
        ),
      ),
    ).toEqual(['mcp-api']);
  });
});

describe('checkProvenance', () => {
  it('fails a published-spec edit with no archive in the diff', () => {
    const result = checkProvenance(nameStatus('M\topenspec/specs/mcp-api/spec.md'));
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      {
        capability: 'mcp-api',
        expectedPath: 'openspec/changes/archive/<YYYY-MM-DD-change>/specs/mcp-api/spec.md',
      },
    ]);
  });

  it('passes an archive that renames the change folder in', () => {
    const result = checkProvenance(
      nameStatus(
        'M\topenspec/specs/mcp-api/spec.md',
        'R100\topenspec/changes/x/specs/mcp-api/spec.md\topenspec/changes/archive/2026-01-01-x/specs/mcp-api/spec.md',
        'R098\topenspec/changes/x/proposal.md\topenspec/changes/archive/2026-01-01-x/proposal.md',
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('does not accept a merely modified archive path as provenance', () => {
    const result = checkProvenance(
      nameStatus(
        'M\topenspec/specs/tui-installer/spec.md',
        'M\topenspec/changes/archive/2026-07-17-earlier/proposal.md',
        'M\topenspec/changes/archive/2026-07-17-earlier/design.md',
        'M\topenspec/changes/archive/2026-07-17-earlier/specs/tui-installer/spec.md',
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.capability)).toEqual(['tui-installer']);
  });

  it('does not accept a rename out of the archive as provenance', () => {
    const result = checkProvenance(
      nameStatus(
        'M\topenspec/specs/mcp-api/spec.md',
        'R100\topenspec/changes/archive/2026-01-01-x/specs/mcp-api/spec.md\topenspec/changes/x/specs/mcp-api/spec.md',
      ),
    );
    expect(result.ok).toBe(false);
  });

  it('archiving one capability does not license editing another', () => {
    const result = checkProvenance(
      nameStatus(
        'A\topenspec/changes/archive/2026-01-01-x/specs/sessions/spec.md',
        'M\topenspec/specs/sessions/spec.md',
        'M\topenspec/specs/codex-distribution/spec.md',
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.capability)).toEqual(['codex-distribution']);
  });

  it('requires provenance for an added published spec', () => {
    expect(checkProvenance(nameStatus('A\topenspec/specs/new-cap/spec.md')).ok).toBe(false);
  });

  it('requires provenance for a deleted published spec', () => {
    expect(checkProvenance(nameStatus('D\topenspec/specs/old-cap/spec.md')).ok).toBe(false);
  });

  it('accepts a delta under the same capability for a deleted published spec', () => {
    expect(
      checkProvenance(
        nameStatus(
          'D\topenspec/specs/old-cap/spec.md',
          'A\topenspec/changes/archive/2026-01-01-x/specs/old-cap/spec.md',
        ),
      ).ok,
    ).toBe(true);
  });

  it('flags both capabilities when a published spec is renamed across capabilities', () => {
    expect(
      affectedCapabilities(
        nameStatus('R090\topenspec/specs/from-cap/spec.md\topenspec/specs/to-cap/spec.md'),
      ),
    ).toEqual(['from-cap', 'to-cap']);
  });

  it('accepts an archive move recorded as delete-plus-add', () => {
    const result = checkProvenance(
      nameStatus(
        'M\topenspec/specs/mcp-api/spec.md',
        'D\topenspec/changes/x/specs/mcp-api/spec.md',
        'A\topenspec/changes/archive/2026-01-01-x/specs/mcp-api/spec.md',
        'D\topenspec/changes/x/proposal.md',
        'A\topenspec/changes/archive/2026-01-01-x/proposal.md',
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes a diff that touches no published spec', () => {
    const result = checkProvenance(
      nameStatus(
        'M\tapps/server/src/services/memory.ts',
        'M\tdocs/docker.md',
        'A\topenspec/changes/in-flight/specs/mcp-api/spec.md',
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.exempt).toBeNull();
  });

  it('exempts on a trailer with a non-empty reason and reports the waived paths', () => {
    const result = checkProvenance(
      nameStatus('M\topenspec/specs/mcp-api/spec.md', 'M\topenspec/specs/sessions/spec.md'),
      {
        trailers: ['fix: a thing\n\nSpec-Provenance-Exempt: broken link, no requirement change\n'],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.exempt).toEqual({
      reason: 'broken link, no requirement change',
      waived: ['openspec/specs/mcp-api/spec.md', 'openspec/specs/sessions/spec.md'],
    });
  });

  it('does not exempt on a trailer with an empty reason', () => {
    for (const trailer of ['Spec-Provenance-Exempt:', 'Spec-Provenance-Exempt:   ']) {
      const result = checkProvenance(nameStatus('M\topenspec/specs/mcp-api/spec.md'), {
        trailers: [`fix: a thing\n\n${trailer}\n`],
      });
      expect(result.ok, trailer).toBe(false);
    }
  });

  it('reports no exemption when the diff needed none', () => {
    const result = checkProvenance(nameStatus('M\tdocs/docker.md'), {
      trailers: ['Spec-Provenance-Exempt: unnecessary'],
    });
    expect(result.exempt).toBeNull();
  });
});

// `pnpm test` must stay green on a shallow clone and on a source tarball.
describe('the predicate needs no git history', () => {
  it('evaluates in a directory with no .git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-provenance-'));
    try {
      copyFileSync(
        join(SCRIPT_DIR, 'check-spec-provenance.mjs'),
        join(dir, 'check-spec-provenance.mjs'),
      );
      const probe = [
        `const m = await import('file://${join(dir, 'check-spec-provenance.mjs')}');`,
        `const e = m.parseNameStatus('M\\topenspec/specs/mcp-api/spec.md\\n');`,
        `console.log(JSON.stringify(m.checkProvenance(e).violations.map((v) => v.capability)));`,
      ].join('\n');
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe('["mcp-api"]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveRange', () => {
  const run = (args: string[], cwd: string) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ISOLATED_GIT_ENV });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };

  it('resolves a base that is not an ancestor of head (the base branch advanced)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-provenance-range-'));
    try {
      const env = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
      run(['init', '-q', '-b', 'main', '.'], dir);
      run([...env, 'commit', '-q', '--allow-empty', '-m', 'root'], dir);
      const root = run(['rev-parse', 'HEAD'], dir);
      run(['checkout', '-q', '-b', 'feature'], dir);
      run([...env, 'commit', '-q', '--allow-empty', '-m', 'pr work'], dir);
      const head = run(['rev-parse', 'HEAD'], dir);
      run(['checkout', '-q', 'main'], dir);
      run([...env, 'commit', '-q', '--allow-empty', '-m', 'base moved on'], dir);
      const base = run(['rev-parse', 'HEAD'], dir);

      const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', base, head], {
        cwd: dir,
        env: ISOLATED_GIT_ENV,
      });
      expect(ancestry.status).toBe(1);
      expect(resolveRange(base, head, dir)).toEqual({ ok: true });
      expect(resolveRange(root, head, dir)).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a null base SHA, an unknown ref, and unrelated histories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-provenance-range-'));
    try {
      const env = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
      run(['init', '-q', '-b', 'main', '.'], dir);
      run([...env, 'commit', '-q', '--allow-empty', '-m', 'root'], dir);
      run(['checkout', '-q', '--orphan', 'other'], dir);
      run([...env, 'commit', '-q', '--allow-empty', '-m', 'orphan'], dir);

      expect(resolveRange('0'.repeat(40), 'main', dir).ok).toBe(false);
      expect(resolveRange('deadbeef', 'main', dir).ok).toBe(false);
      expect(resolveRange('other', 'main', dir).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI', () => {
  const SCRIPT = join(SCRIPT_DIR, 'check-spec-provenance.mjs');

  function scratchRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'spec-provenance-cli-'));
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: ISOLATED_GIT_ENV,
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const write = (path: string, body: string) => {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    };
    git('init', '-q', '-b', 'main', '.');
    write('openspec/specs/mcp-api/spec.md', 'original\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'root');
    const base = git('rev-parse', 'HEAD');
    const cli = () =>
      spawnSync(process.execPath, [SCRIPT, '--base', base, '--head', 'HEAD'], {
        cwd: dir,
        encoding: 'utf8',
        // The script shells out to git itself, so it needs the same isolation.
        env: ISOLATED_GIT_ENV,
      });
    return { dir, git, write, cli };
  }

  it('exits 1 and names the capability for an unpaired spec edit', () => {
    const repo = scratchRepo();
    try {
      repo.write('openspec/specs/mcp-api/spec.md', 'edited\n');
      repo.git('commit', '-qam', 'fix: tweak the spec');
      const run = repo.cli();
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('mcp-api: openspec/specs/mcp-api/spec.md has no paired archive');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('exits 2 on an empty range instead of passing over a diff it never examined', () => {
    const repo = scratchRepo();
    try {
      repo.write('openspec/specs/mcp-api/spec.md', 'edited\n');
      repo.git('commit', '-qam', 'fix: an unpaired spec edit');

      const empty = spawnSync(process.execPath, [SCRIPT, '--base', 'HEAD', '--head', 'HEAD'], {
        cwd: repo.dir,
        encoding: 'utf8',
        env: ISOLATED_GIT_ENV,
      });
      expect(empty.status, empty.stdout + empty.stderr).toBe(2);
      expect(empty.stderr).toContain('"HEAD..HEAD" holds no commits');
      expect(empty.stdout).not.toContain('spec-provenance: ok');
      expect(isEmptyRange('HEAD', 'HEAD', repo.dir)).toBe(true);

      // Control: the same violation over a range that does hold the commit still
      // exits 1, so the exit 2 above is the empty range and not a broken probe.
      const held = spawnSync(process.execPath, [SCRIPT, '--base', 'HEAD~1', '--head', 'HEAD'], {
        cwd: repo.dir,
        encoding: 'utf8',
        env: ISOLATED_GIT_ENV,
      });
      expect(held.status, held.stdout).toBe(1);
      expect(isEmptyRange('HEAD~1', 'HEAD', repo.dir)).toBe(false);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('exits 0 for a delta sync plus archive move in one commit', () => {
    const repo = scratchRepo();
    try {
      repo.write('openspec/changes/x/specs/mcp-api/spec.md', 'delta\n');
      repo.git('add', '-A');
      repo.git('commit', '-qm', 'docs: open a change');
      const base2 = repo.git('rev-parse', 'HEAD');
      repo.write('openspec/specs/mcp-api/spec.md', 'edited\n');
      mkdirSync(join(repo.dir, 'openspec/changes/archive'), { recursive: true });
      repo.git('mv', 'openspec/changes/x', 'openspec/changes/archive/2026-01-01-x');
      repo.git('add', '-A');
      repo.git('commit', '-qm', 'docs: archive x');
      const run = spawnSync(process.execPath, [SCRIPT, '--base', base2, '--head', 'HEAD'], {
        cwd: repo.dir,
        encoding: 'utf8',
      });
      expect(run.status, run.stdout).toBe(0);
      expect(run.stdout).toContain('spec-provenance: ok');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('exits 0 and echoes the reason when a commit in the range carries the trailer', () => {
    const repo = scratchRepo();
    try {
      repo.write('openspec/specs/mcp-api/spec.md', 'edited\n');
      repo.git(
        'commit',
        '-qam',
        'fix: repair a broken link\n\nSpec-Provenance-Exempt: broken link only',
      );
      const run = repo.cli();
      expect(run.status, run.stdout).toBe(0);
      expect(run.stdout).toContain('exempted by trailer — broken link only');
      expect(run.stdout).toContain('waived: openspec/specs/mcp-api/spec.md');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('finds the trailer on any commit in the range, not just the tip', () => {
    const repo = scratchRepo();
    try {
      repo.write('openspec/specs/mcp-api/spec.md', 'edited\n');
      repo.git('commit', '-qam', 'fix: edit\n\nSpec-Provenance-Exempt: deliberate');
      repo.write('unrelated.txt', 'x\n');
      repo.git('add', '-A');
      repo.git('commit', '-qm', 'chore: something else');
      expect(repo.cli().status).toBe(0);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('does not honour a trailer from a commit outside the range', () => {
    const repo = scratchRepo();
    try {
      repo.write('openspec/specs/mcp-api/spec.md', 'edited\n');
      repo.git('commit', '-qam', 'fix: edit\n\nSpec-Provenance-Exempt: deliberate');
      const afterExempt = repo.git('rev-parse', 'HEAD');
      repo.write('openspec/specs/mcp-api/spec.md', 'edited again\n');
      repo.git('commit', '-qam', 'fix: another undocumented edit');
      const run = spawnSync(process.execPath, [SCRIPT, '--base', afterExempt, '--head', 'HEAD'], {
        cwd: repo.dir,
        encoding: 'utf8',
      });
      expect(run.status).toBe(1);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe('laundering routes closed after review', () => {
  it('a rename of a published spec into the archive does not prove its own provenance', () => {
    const entries = parseNameStatus(
      'R100\topenspec/specs/mcp-api/spec.md\topenspec/changes/archive/2026-01-01-x/specs/mcp-api/spec.md',
    );
    expect(checkProvenance(entries).ok).toBe(false);
  });

  it('a rename within the archive is not a fresh arrival', () => {
    const entries = parseNameStatus(
      [
        'R100\topenspec/changes/archive/2026-01-01-x/specs/mcp-api/spec.md\topenspec/changes/archive/2026-01-02-x/specs/mcp-api/spec.md',
        'M\topenspec/specs/mcp-api/spec.md',
      ].join('\n'),
    );
    expect(checkProvenance(entries).ok).toBe(false);
  });

  it('a rename into the archive from outside it still counts', () => {
    const entries = parseNameStatus(
      [
        'R100\topenspec/changes/x/specs/mcp-api/spec.md\topenspec/changes/archive/2026-01-01-x/specs/mcp-api/spec.md',
        'M\topenspec/specs/mcp-api/spec.md',
      ].join('\n'),
    );
    expect(checkProvenance(entries).ok).toBe(true);
  });
});

describe('the exemption is a trailer, not any matching line', () => {
  const affected = parseNameStatus('M\topenspec/specs/mcp-api/spec.md');
  const waived = (message: string): boolean =>
    checkProvenance(affected, { trailers: [message] }).ok;

  it('ignores the key when it appears in prose describing the feature', () => {
    expect(
      waived(
        'docs: explain it\n\nAdd a Spec-Provenance-Exempt: <reason> trailer.\n\nSee the skill.',
      ),
    ).toBe(false);
  });

  it('ignores an indented occurrence', () => {
    expect(waived('fix: x\n\n    Spec-Provenance-Exempt: sneaky')).toBe(false);
  });

  it.each(['-', '.', 'n/a', 'na', 'none', 'TBD', '??'])(
    'rejects the placeholder reason %s',
    (r) => {
      expect(waived(`fix: x\n\nSpec-Provenance-Exempt: ${r}`)).toBe(false);
    },
  );

  it('accepts a reason with substance in the last paragraph', () => {
    expect(
      waived('fix: x\n\nSpec-Provenance-Exempt: the published text was merely incomplete'),
    ).toBe(true);
  });
});
