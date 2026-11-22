import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-migrations.mjs');
const MIGRATIONS = 'packages/db/src/migrations';

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function repo(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'rembric-migrations-gate-'));
  fixtures.push(root);
  for (const name of names) write(root, `${MIGRATIONS}/${name}`, `-- ${name}\n`);
  git(root, 'init', '-q');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  return root;
}

function run(root: string, ...args: string[]) {
  const r = spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const BASE = ['0000_initial.sql', '0001_second.sql', '0002_third.sql'];

describe('check-migrations', () => {
  it('passes a unique, contiguous set', () => {
    const root = repo(BASE);
    expect(run(root).status).toBe(0);
    expect(run(root, '--base', 'HEAD').status).toBe(0);
  });

  it('passes a new migration appended after the base', () => {
    const root = repo(BASE);
    write(root, `${MIGRATIONS}/0003_fourth.sql`, '-- new\n');
    expect(run(root, '--base', 'HEAD').status).toBe(0);
  });

  it('fails two migrations that share a number, as two merged PRs would leave', () => {
    const root = repo([...BASE, '0003_pins.sql']);
    write(root, `${MIGRATIONS}/0003_users.sql`, '-- clash\n');
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain('0003 is used by 0003_pins.sql and 0003_users.sql');
  });

  it('fails a gap in the numbering', () => {
    const root = repo(BASE);
    write(root, `${MIGRATIONS}/0004_skipped.sql`, '-- gap\n');
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain('0004_skipped.sql: expected number 0003');
  });

  it('fails a file name that does not follow NNNN_snake_case.sql', () => {
    const root = repo(BASE);
    write(root, `${MIGRATIONS}/0003-Bad Name.sql`, '-- bad\n');
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain('0003-Bad Name.sql: name must match NNNN_snake_case.sql');
  });

  it('fails a migration from the base that was renumbered', () => {
    const root = repo(BASE);
    renameSync(join(root, MIGRATIONS, '0002_third.sql'), join(root, MIGRATIONS, '0003_third.sql'));
    write(root, `${MIGRATIONS}/0002_inserted.sql`, '-- inserted before\n');
    const r = run(root, '--base', 'HEAD');
    expect(r.status).toBe(1);
    expect(r.out).toContain('0002_third.sql exists on the base and was renamed or removed');
  });

  it('fails a migration from the base whose content changed', () => {
    const root = repo(BASE);
    write(root, `${MIGRATIONS}/0001_second.sql`, '-- edited\n');
    const r = run(root, '--base', 'HEAD');
    expect(r.status).toBe(1);
    expect(r.out).toContain('0001_second.sql exists on the base and was edited');
  });

  it('skips the base comparison for the all-zero sha of a first push', () => {
    const root = repo(BASE);
    expect(run(root, '--base', '0'.repeat(40)).status).toBe(0);
  });
});
