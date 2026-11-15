import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { touchesImage } from './docker-relevant-changes.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'docker-relevant-changes.mjs');

describe('touchesImage', () => {
  it('skips a change confined to paths outside the image and the installer server path', () => {
    expect(
      touchesImage([
        'openspec/changes/x/proposal.md',
        'docs/agents.md',
        'README.md',
        'apps/plugin/.hermes-plugin/__init__.py',
        'apps/plugin/bin/rembric-plugin-core.mjs',
        '.github/ISSUE_TEMPLATE/bug.yml',
        '.github/PULL_REQUEST_TEMPLATE.md',
        '.release-please-manifest.json',
        '.agents/skills/x/SKILL.md',
      ]),
    ).toBe(false);
  });

  it.each([
    'apps/plugin/install.sh',
    'apps/plugin/package.json',
    'install.sh',
    'docker-compose.yml',
    '.env.example',
    'apps/web/src/app/page.tsx',
    'apps/web/README.md',
    'packages/db/src/migrations/0040_x.sql',
    'pnpm-lock.yaml',
    'package.json',
    '.dockerignore',
    '.github/workflows/ci.yml',
    '.github/actions/build-runtime-image/action.yml',
    'scripts/some-new-script.mjs',
  ])('builds the image when %s changes', (path) => {
    expect(touchesImage(['docs/agents.md', path])).toBe(true);
  });

  it('builds the image when the diff is empty', () => {
    expect(touchesImage([])).toBe(true);
  });
});

describe('CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docker-relevant-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const commit = (path: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `${path}\n`);
    git('add', path);
    git('-c', 'user.email=ci@example.com', '-c', 'user.name=ci', 'commit', '-qm', path);
    return git('rev-parse', 'HEAD');
  };
  const run = (base: string, head: string) => {
    const output = join(dir, `out-${head}`);
    writeFileSync(output, '');
    const result = spawnSync('node', [SCRIPT, '--base', base, '--head', head], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    return { status: result.status, output: readFileSync(output, 'utf8') };
  };

  git('init', '-q');
  const base = commit('README.md');
  const docs = commit('docs/agents.md');
  const web = commit('apps/web/page.tsx');
  git('mv', 'apps/web/page.tsx', 'docs/page.tsx');
  git('-c', 'user.email=ci@example.com', '-c', 'user.name=ci', 'commit', '-qm', 'move');
  const moved = git('rev-parse', 'HEAD');

  it('writes docker=false for a docs-only range and docker=true once the range reaches the image', () => {
    expect(run(base, docs)).toEqual({ status: 0, output: 'docker=false\n' });
    expect(run(base, web)).toEqual({ status: 0, output: 'docker=true\n' });
  });

  it('counts the source of a rename that moves a file out of the image', () => {
    expect(run(web, moved)).toEqual({ status: 0, output: 'docker=true\n' });
  });

  it('fails instead of guessing when the range cannot be resolved', () => {
    expect(run(base, 'deadbeef').status).not.toBe(0);
  });
});
