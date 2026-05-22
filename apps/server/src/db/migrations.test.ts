import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test/index.js';

import { migrate } from './migrate.js';

const fullMigrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

describe('migration 0011_summary_length_check', () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.cleanup());

  it('rejects a direct INSERT with summary > 2000 chars via SQLITE_CONSTRAINT_CHECK', () => {
    const raw = db.handle.raw;
    raw
      .prepare(
        "INSERT INTO tokens (id, name, hash, scope, created_at) VALUES ('tok1', 'tok1-name', 'h', '*', 0)",
      )
      .run();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO sessions (id, token_id, agent, started_at, summary, status) VALUES ('s1', 'tok1', 'claude', 0, ?, 'active')",
        )
        .run('a'.repeat(2001)),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects a direct UPDATE that would push summary over 2000 chars', () => {
    const raw = db.handle.raw;
    raw
      .prepare(
        "INSERT INTO tokens (id, name, hash, scope, created_at) VALUES ('tok2', 'tok2-name', 'h', '*', 0)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO sessions (id, token_id, agent, started_at, summary, status) VALUES ('s2', 'tok2', 'claude', 0, 'short', 'active')",
      )
      .run();
    expect(() =>
      raw.prepare("UPDATE sessions SET summary = ? WHERE id = 's2'").run('a'.repeat(2001)),
    ).toThrow(/CHECK constraint failed/);
    const after = raw.prepare("SELECT summary FROM sessions WHERE id = 's2'").get() as {
      summary: string;
    };
    expect(after.summary).toBe('short');
  });

  it('accepts summary at exactly 2000 chars and NULL summary', () => {
    const raw = db.handle.raw;
    raw
      .prepare(
        "INSERT INTO tokens (id, name, hash, scope, created_at) VALUES ('tok3', 'tok3-name', 'h', '*', 0)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO sessions (id, token_id, agent, started_at, summary, status) VALUES ('s3a', 'tok3', 'claude', 0, ?, 'active')",
      )
      .run('a'.repeat(2000));
    raw
      .prepare(
        "INSERT INTO sessions (id, token_id, agent, started_at, summary, status) VALUES ('s3b', 'tok3', 'claude', 0, NULL, 'active')",
      )
      .run();
    const rows = raw
      .prepare("SELECT id, length(summary) AS len FROM sessions WHERE id IN ('s3a','s3b')")
      .all() as Array<{ id: string; len: number | null }>;
    expect(rows.find((r) => r.id === 's3a')?.len).toBe(2000);
    expect(rows.find((r) => r.id === 's3b')?.len).toBeNull();
  });

  it('preserves the three sessions indexes after the table-rebuild', () => {
    const raw = db.handle.raw;
    const indexes = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((r) => r.name);
    expect(names).toContain('sessions_token_status_idx');
    expect(names).toContain('sessions_project_started_idx');
    expect(names).toContain('sessions_status_started_idx');
  });
});

// Regression for the production incident where 0011 failed with
// `FOREIGN KEY constraint failed` because `sessions` is a FK parent
// (prompts/memory/confirmations all reference it) and the table-rebuild
// dance dropped a populated parent under `foreign_keys=ON`. The fix is
// `PRAGMA defer_foreign_keys = ON` at the top of the migration.
describe('migration 0011 with referencing children', () => {
  let dataDir: string;
  let slicedDir: string;
  let raw: Database.Database;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-mig11-data-'));
    slicedDir = mkdtempSync(join(tmpdir(), 'rembric-mig11-slice-'));

    const all = readdirSync(fullMigrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of all) {
      if (f.startsWith('0011_')) break;
      copyFileSync(join(fullMigrationsDir, f), join(slicedDir, f));
    }

    raw = new Database(join(dataDir, 'data.db'));
    sqliteVec.load(raw);
    raw.pragma('journal_mode = WAL');
    raw.pragma('synchronous = NORMAL');
    raw.pragma('foreign_keys = ON');
    raw.pragma('busy_timeout = 5000');

    migrate(raw, { migrationsDir: slicedDir });
  });

  afterEach(() => {
    try {
      raw.close();
    } catch {
      // ignore
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(slicedDir, { recursive: true, force: true });
  });

  it('rebuilds sessions cleanly when prompts/memory/confirmations reference it', () => {
    raw
      .prepare(
        "INSERT INTO tokens (id, name, hash, scope, created_at) VALUES ('tok1', 'tok1-name', 'h', '*', 0)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO projects (id, slug, display_name, created_at) VALUES ('proj1', 'proj1', 'proj1', 0)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO sessions (id, token_id, project_id, agent, started_at, summary, status) VALUES ('sess1', 'tok1', 'proj1', 'claude', 0, 'short', 'active')",
      )
      .run();

    // FK children referencing sess1
    raw
      .prepare(
        "INSERT INTO prompts (id, session_id, project_id, title, content, tags, replaces, created_at) VALUES ('p1', 'sess1', 'proj1', 'untitled', 'body', '[]', '[]', 0)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO memory (id, scope, project_id, type, content, created_at, session_id) VALUES ('m1', 'project', 'proj1', 'fact', 'body', 0, 'sess1')",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO confirmations (id, memory_id, event_ts, session_id) VALUES ('c1', 'm1', 0, 'sess1')",
      )
      .run();

    const before = raw
      .prepare<[], { filename: string }>('SELECT filename FROM _migrations')
      .all()
      .map((r) => r.filename);
    expect(before).not.toContain('0011_summary_length_check.sql');

    // Re-run migrations against the FULL dir → only 0011 is new and runs.
    const result = migrate(raw, { migrationsDir: fullMigrationsDir });
    expect(result.applied).toEqual(['0011_summary_length_check.sql']);

    // FK integrity after the rebuild.
    const fkViolations = raw.prepare('PRAGMA foreign_key_check').all();
    expect(fkViolations).toEqual([]);

    // Children still point at the rebuilt session row.
    const session = raw
      .prepare<
        [],
        { id: string; summary: string | null }
      >("SELECT id, summary FROM sessions WHERE id = 'sess1'")
      .get();
    expect(session).toEqual({ id: 'sess1', summary: 'short' });

    const childSessIds = raw
      .prepare<[], { src: string; sid: string | null }>(
        `SELECT 'prompts' AS src, session_id AS sid FROM prompts WHERE id = 'p1'
         UNION ALL SELECT 'memory', session_id FROM memory WHERE id = 'm1'
         UNION ALL SELECT 'confirmations', session_id FROM confirmations WHERE id = 'c1'`,
      )
      .all();
    for (const row of childSessIds) {
      expect(row.sid).toBe('sess1');
    }

    // CHECK constraint is now in effect.
    expect(() =>
      raw.prepare("UPDATE sessions SET summary = ? WHERE id = 'sess1'").run('a'.repeat(2001)),
    ).toThrow(/CHECK constraint failed/);
  });
});
