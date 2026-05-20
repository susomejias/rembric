import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test/index.js';

import {
  assertDataLossGuard,
  DataLossGuardError,
  readStateMarker,
  writeStateMarker,
} from './data-loss-guard.js';

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => db.cleanup());

describe('data-loss guard', () => {
  it('first boot (no marker) writes a marker and proceeds', () => {
    expect(readStateMarker(db.dataDir)).toBeNull();

    const result = assertDataLossGuard({
      dataDir: db.dataDir,
      db: db.handle.db,
      env: {},
      log: () => {},
    });

    expect(result.previous).toBeNull();
    expect(result.shrunkTables).toHaveLength(0);
    expect(result.bypassed).toBe(false);

    const marker = readStateMarker(db.dataDir);
    expect(marker).not.toBeNull();
    expect(marker!.version).toBe(1);
    expect(marker!.counts).toEqual({
      memory: 0,
      projects: 0,
      sessions: 0,
      tokens: 0,
      prompts: 0,
    });
  });

  it('stable counts pass without bypass and refresh marker timestamp', () => {
    writeStateMarker(db.dataDir, {
      memory: 0,
      projects: 0,
      sessions: 0,
      tokens: 0,
      prompts: 0,
    });
    const before = readStateMarker(db.dataDir)!.last_seen_at;

    // wait a tick so last_seen_at can change
    const result = assertDataLossGuard({
      dataDir: db.dataDir,
      db: db.handle.db,
      env: {},
      log: () => {},
    });

    expect(result.shrunkTables).toHaveLength(0);
    const after = readStateMarker(db.dataDir)!.last_seen_at;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('mass row loss without env throws DataLossGuardError and preserves the marker', () => {
    writeStateMarker(db.dataDir, {
      memory: 80,
      projects: 5,
      sessions: 30,
      tokens: 4,
      prompts: 1,
    });

    let thrown: unknown = null;
    try {
      assertDataLossGuard({
        dataDir: db.dataDir,
        db: db.handle.db,
        env: {},
        log: () => {},
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DataLossGuardError);
    const e = thrown as DataLossGuardError;
    expect(e.shrunkTables.map((s) => s.table)).toEqual(
      expect.arrayContaining(['memory', 'projects', 'sessions', 'tokens']),
    );

    const stillThere = readStateMarker(db.dataDir);
    expect(stillThere!.counts.memory).toBe(80);
  });

  it('mass row loss WITH REMBRIC_ALLOW_DATA_SHRINKAGE=1 passes and rewrites marker', () => {
    writeStateMarker(db.dataDir, {
      memory: 80,
      projects: 5,
      sessions: 30,
      tokens: 4,
      prompts: 1,
    });

    const lines: string[] = [];
    const result = assertDataLossGuard({
      dataDir: db.dataDir,
      db: db.handle.db,
      env: { REMBRIC_ALLOW_DATA_SHRINKAGE: '1' },
      log: (l) => lines.push(l),
    });

    expect(result.bypassed).toBe(true);
    expect(result.shrunkTables.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('data-loss guard bypassed'))).toBe(true);

    const fresh = readStateMarker(db.dataDir);
    expect(fresh!.counts.memory).toBe(0);
  });

  it('corrupted marker is treated as missing (first-boot semantics)', () => {
    writeFileSync(join(db.dataDir, '.rembric-state.json'), '{ not valid json');

    expect(readStateMarker(db.dataDir)).toBeNull();

    const result = assertDataLossGuard({
      dataDir: db.dataDir,
      db: db.handle.db,
      env: {},
      log: () => {},
    });

    expect(result.previous).toBeNull();
    expect(existsSync(join(db.dataDir, '.rembric-state.json'))).toBe(true);
  });

  it('marker with unknown version is treated as missing', () => {
    writeFileSync(
      join(db.dataDir, '.rembric-state.json'),
      JSON.stringify({
        version: 999,
        last_seen_at: Date.now(),
        counts: { memory: 80, projects: 5, sessions: 30, tokens: 4, prompts: 1 },
      }),
    );

    const result = assertDataLossGuard({
      dataDir: db.dataDir,
      db: db.handle.db,
      env: {},
      log: () => {},
    });

    expect(result.previous).toBeNull();
    expect(result.shrunkTables).toHaveLength(0);
  });

  it('single-table shrinkage below threshold triggers refusal', () => {
    writeStateMarker(db.dataDir, {
      memory: 100,
      projects: 0,
      sessions: 0,
      tokens: 0,
      prompts: 0,
    });

    let thrown: unknown = null;
    try {
      assertDataLossGuard({
        dataDir: db.dataDir,
        db: db.handle.db,
        env: {},
        log: () => {},
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DataLossGuardError);
    const e = thrown as DataLossGuardError;
    expect(e.shrunkTables.map((s) => s.table)).toEqual(['memory']);
  });
});
