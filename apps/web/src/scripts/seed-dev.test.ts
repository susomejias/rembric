import { ProjectsService } from '@rembric/core';
import { TokensService } from '@rembric/core';
import { createRepositories, projectScope } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test/index.js';

import { runSeed } from './seed-dev.js';

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...extra };
}

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => db.cleanup());

function countTokenProjects(): number {
  const row = db.handle.raw.prepare('SELECT count(*) AS n FROM token_projects').get() as {
    n: number;
  };
  return row.n;
}

describe('runSeed', () => {
  it('seeds a fresh DB with the expected entity counts', () => {
    const result = runSeed({ handle: db.handle, reset: false, log: () => {} });

    expect(result.skipped).toBe(false);
    expect(result.counts).toEqual({
      projects: 20,
      tokens: 3,
      memories: 35,
      endedSessions: 3,
      activeSessions: 2,
      pendingJudgments: 1,
    });
    expect(result.adminTokenPlaintext).toMatch(/^.{20,}$/);
    expect(result.readerTokenPlaintext).toMatch(/^.{20,}$/);
    expect(result.writerTokenPlaintext).toMatch(/^.{20,}$/);

    const projects = new ProjectsService(createRepositories(db.handle.db));
    const demo = projects.findBySlug('demo');
    expect(demo).toBeDefined();
    expect(demo!.displayName).toBe('Demo Project');
  });

  it('is idempotent: second run without --reset is a no-op', () => {
    runSeed({ handle: db.handle, reset: false, log: () => {} });

    const second = runSeed({ handle: db.handle, reset: false, log: () => {} });
    expect(second.skipped).toBe(true);
    expect(second.counts).toBeUndefined();
  });

  it('--reset wipes the previous seed and reseeds when env gate is satisfied', () => {
    runSeed({ handle: db.handle, reset: false, log: () => {} });

    const projects = new ProjectsService(createRepositories(db.handle.db));
    expect(projects.findBySlug('demo')).toBeDefined();

    const result = runSeed({
      handle: db.handle,
      reset: true,
      env: env({ REMBRIC_ALLOW_DESTRUCTIVE_SEED: '1' }),
      log: () => {},
    });

    expect(result.skipped).toBe(false);
    expect(result.refused).toBeUndefined();
    expect(result.counts!.projects).toBe(20);
    expect(result.counts!.tokens).toBe(3);
    expect(result.counts!.memories).toBe(35);
    expect(result.counts!.pendingJudgments).toBe(1);
  });

  it('--reset does not violate FK constraints when entity links/scan rows exist (regression: add-entity-index)', () => {
    runSeed({ handle: db.handle, reset: false, log: () => {} });

    const repos = createRepositories(db.handle.db);
    const projects = new ProjectsService(repos);
    const demo = projects.findBySlug('demo');
    expect(demo).toBeDefined();
    const someMemory = repos.memory.searchMemoryIds({
      scope: projectScope(demo!.id),
      status: 'active',
      limit: 1,
      offset: 0,
    })[0];
    expect(someMemory).toBeDefined();
    repos.entities.linkMemory(
      someMemory!,
      demo!.id,
      [{ kind: 'path', value: 'docs/docker.md' }],
      new Date(),
    );

    expect(() =>
      runSeed({
        handle: db.handle,
        reset: true,
        env: env({ REMBRIC_ALLOW_DESTRUCTIVE_SEED: '1' }),
        log: () => {},
      }),
    ).not.toThrow();
    expect(db.handle.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('--reset does not violate FK constraints when a token names a set of projects (regression: grant-tokens-multiple-projects)', () => {
    runSeed({ handle: db.handle, reset: false, log: () => {} });

    const repos = createRepositories(db.handle.db);
    const projects = new ProjectsService(repos);
    const demo = projects.findBySlug('demo');
    expect(demo).toBeDefined();
    const extra = projects.create({ slug: 'seed-reset-extra' });
    new TokensService(repos, db.handle.db).create({
      name: 'seed-reset-set-token',
      projects: [demo!, extra],
      access: 'write',
    });
    expect(countTokenProjects(), 'nothing to regress against').toBe(2);

    expect(() =>
      runSeed({
        handle: db.handle,
        reset: true,
        env: env({ REMBRIC_ALLOW_DESTRUCTIVE_SEED: '1' }),
        log: () => {},
      }),
    ).not.toThrow();
    expect(countTokenProjects()).toBe(0);
  });

  it('--reset without REMBRIC_ALLOW_DESTRUCTIVE_SEED=1 refuses and preserves data', () => {
    runSeed({ handle: db.handle, reset: false, log: () => {} });

    const projects = new ProjectsService(createRepositories(db.handle.db));
    const before = projects.findBySlug('demo');
    expect(before).toBeDefined();
    const beforeId = before!.id;

    const lines: string[] = [];
    const result = runSeed({
      handle: db.handle,
      reset: true,
      env: env(),
      log: (l) => lines.push(l),
    });

    expect(result.refused).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.counts).toBeUndefined();
    expect(lines).toContain(
      '[seed-dev] --reset requires REMBRIC_ALLOW_DESTRUCTIVE_SEED=1; refusing to wipe',
    );

    const after = projects.findBySlug('demo');
    expect(after).toBeDefined();
    expect(after!.id).toBe(beforeId);
  });

  it('--reset with REMBRIC_ALLOW_DESTRUCTIVE_SEED set to a non-1 value also refuses', () => {
    runSeed({ handle: db.handle, reset: false, log: () => {} });

    const result = runSeed({
      handle: db.handle,
      reset: true,
      env: env({ REMBRIC_ALLOW_DESTRUCTIVE_SEED: 'true' }),
      log: () => {},
    });

    expect(result.refused).toBe(true);
  });

  it('emits the plaintext tokens via the log sink exactly once', () => {
    const lines: string[] = [];
    const result = runSeed({ handle: db.handle, reset: false, log: (l) => lines.push(l) });

    const adminCount = lines.filter((l) => l.includes(result.adminTokenPlaintext!)).length;
    const readerCount = lines.filter((l) => l.includes(result.readerTokenPlaintext!)).length;
    const writerCount = lines.filter((l) => l.includes(result.writerTokenPlaintext!)).length;
    expect(adminCount).toBe(1);
    expect(readerCount).toBe(1);
    expect(writerCount).toBe(1);
  });

  it('a --reset always leaves exactly one default project, including on a database that lost it', () => {
    const projects = new ProjectsService(createRepositories(db.handle.db));
    const before = db.handle.raw
      .prepare('SELECT count(*) AS n FROM projects WHERE is_default = 1')
      .get() as { n: number };
    expect(before.n).toBe(1);

    const reset = runSeed({
      handle: db.handle,
      reset: true,
      env: env({ REMBRIC_ALLOW_DESTRUCTIVE_SEED: '1' }),
      log: () => {},
    });
    expect(reset.refused).toBeUndefined();

    const kept = db.handle.raw.prepare('SELECT slug FROM projects WHERE is_default = 1').all() as {
      slug: string;
    }[];
    expect(kept).toHaveLength(1);
    expect(projects.list().length).toBeGreaterThan(1);

    db.handle.raw.exec('UPDATE projects SET is_default = 0');
    const healRun = runSeed({
      handle: db.handle,
      reset: true,
      env: env({ REMBRIC_ALLOW_DESTRUCTIVE_SEED: '1' }),
      log: () => {},
    });
    expect(healRun.refused).toBeUndefined();
    const healed = db.handle.raw
      .prepare('SELECT count(*) AS n FROM projects WHERE is_default = 1')
      .get() as { n: number };
    expect(healed.n).toBe(1);
  });
});
