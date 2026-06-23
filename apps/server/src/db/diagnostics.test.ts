import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test/db.js';

import {
  countTableRows,
  quickCheck,
  readDbSize,
  readDbstatBytes,
  readJournalMode,
  vacuumInto,
} from './diagnostics.js';

describe('db/diagnostics', () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  it('readDbSize reports consistent page-derived byte totals', () => {
    const size = readDbSize(t.handle);
    expect(size.pageCount).toBeGreaterThan(0);
    expect(size.pageSize).toBeGreaterThan(0);
    expect(size.totalBytes).toBe(size.pageCount * size.pageSize);
    expect(size.freelistBytes).toBe(size.freelistCount * size.pageSize);
  });

  it('readJournalMode reports WAL (set by createDb)', () => {
    expect(readJournalMode(t.handle)).toBe('wal');
  });

  it('quickCheck reports ok on a healthy database', () => {
    expect(quickCheck(t.handle)).toBe('ok');
  });

  it('countTableRows counts real tables and returns null for missing ones', () => {
    expect(countTableRows(t.handle, 'memory')).toBe(0);
    t.handle.raw
      .prepare(
        `INSERT INTO memory (id, scope, project_id, type, title, content, tags, status, replaces, created_at, last_seen_at)
         VALUES ('01TEST', 'global', NULL, 'project', 'diag test', 'diag test', '[]', 'active', '[]', 1, 1)`,
      )
      .run();
    expect(countTableRows(t.handle, 'memory')).toBe(1);
    expect(countTableRows(t.handle, 'no_such_table')).toBeNull();
    expect(countTableRows(t.handle, 'bad"name')).toBeNull();
  });

  it('readDbstatBytes returns per-table bytes or null when dbstat is unavailable', () => {
    const bytes = readDbstatBytes(t.handle);
    if (bytes !== null) {
      expect(bytes.get('memory')).toBeGreaterThan(0);
    } else {
      expect(bytes).toBeNull();
    }
  });

  it('vacuumInto produces an openable copy of the database', () => {
    const dest = join(t.dataDir, 'backup.db');
    vacuumInto(t.handle, dest);
    expect(existsSync(dest)).toBe(true);
    expect(statSync(dest).size).toBeGreaterThan(0);

    const copy = new Database(dest, { readonly: true });
    try {
      const row = copy.prepare<[], { v: number }>('SELECT COUNT(*) AS v FROM memory').get();
      expect(row?.v).toBe(0);
    } finally {
      copy.close();
    }
  });
});
