import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectsService } from '../services/projects.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { runSeed } from './seed-dev.js';

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => db.cleanup());

describe('runSeed', () => {
  it('seeds a fresh DB with the expected entity counts', () => {
    const result = runSeed({ handle: db.handle, reset: false, log: () => {} });

    expect(result.skipped).toBe(false);
    expect(result.counts).toEqual({
      projects: 1,
      tokens: 3,
      memories: 23,
      endedSessions: 3,
      activeSessions: 2,
      pendingJudgments: 1,
    });
    expect(result.adminTokenPlaintext).toMatch(/^.{20,}$/);
    expect(result.readerTokenPlaintext).toMatch(/^.{20,}$/);
    expect(result.writerTokenPlaintext).toMatch(/^.{20,}$/);

    const projects = new ProjectsService(db.handle.db);
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

  it('--reset wipes the previous seed and reseeds', () => {
    runSeed({ handle: db.handle, reset: false, log: () => {} });

    // Confirm pre-state.
    const projects = new ProjectsService(db.handle.db);
    expect(projects.findBySlug('demo')).toBeDefined();

    // Reset + reseed.
    const result = runSeed({ handle: db.handle, reset: true, log: () => {} });

    expect(result.skipped).toBe(false);
    expect(result.counts!.projects).toBe(1);
    expect(result.counts!.tokens).toBe(3);
    expect(result.counts!.memories).toBe(23);
    expect(result.counts!.pendingJudgments).toBe(1);
  });

  it('emits the plaintext tokens via the log sink exactly once', () => {
    const lines: string[] = [];
    const result = runSeed({ handle: db.handle, reset: false, log: (l) => lines.push(l) });

    // Each plaintext appears in exactly one log line.
    const adminCount = lines.filter((l) => l.includes(result.adminTokenPlaintext!)).length;
    const readerCount = lines.filter((l) => l.includes(result.readerTokenPlaintext!)).length;
    const writerCount = lines.filter((l) => l.includes(result.writerTokenPlaintext!)).length;
    expect(adminCount).toBe(1);
    expect(readerCount).toBe(1);
    expect(writerCount).toBe(1);
  });
});
