import { copyFileSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from './index.js';

/**
 * 0029 rebuilds a table that is an FK parent of two populated children, so
 * the interesting cases are only observable against a database migrated to
 * 0028 first and then stepped forward. The migrations directory is staged
 * file by file to reach that pre-migration state.
 */

const MIGRATION = '0029_tokens_project_binding.sql';
const SOURCE_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

type Row = Record<string, unknown>;

let dataDir: string;
let migrationsDir: string;

function stagePreMigration(): void {
  for (const f of readdirSync(SOURCE_DIR)) {
    if (f.endsWith('.sql') && f < MIGRATION) {
      copyFileSync(join(SOURCE_DIR, f), join(migrationsDir, f));
    }
  }
}

function stage0029(): void {
  copyFileSync(join(SOURCE_DIR, MIGRATION), join(migrationsDir, MIGRATION));
}

function unstage0029(): void {
  unlinkSync(join(migrationsDir, MIGRATION));
}

function open(): DbHandle {
  return createDb({ dataDir, migrationsDir });
}

function seeded(): void {
  const handle = open();
  handle.raw.exec(`
    INSERT INTO projects (id, slug, display_name, archived_at, created_at)
      VALUES ('01PROJECTALPHA', 'alpha', NULL, NULL, 1000);
    INSERT INTO tokens (id, name, hash, scope, project_id, created_at, expires_at, revoked_at)
      VALUES
        ('01TOKADMIN',  'admin',  's1$aa$bb', '*',             NULL, 1000, NULL, NULL),
        ('01TOKREADER', 'reader', 's1$cc$dd', 'read:*',        NULL, 1001, 2000, NULL),
        ('01TOKLEGACY', 'legacy', 's1$ee$ff', 'project:alpha', NULL, 1002, NULL, 1500);
    INSERT INTO sessions (id, token_id, project_id, agent, started_at)
      VALUES ('01SESSION', '01TOKADMIN', '01PROJECTALPHA', 'test', 1003);
    INSERT INTO dashboard_sessions (id, token_id, csrf_secret, created_at, expires_at, last_seen_at)
      VALUES ('01DASHSESSION', '01TOKADMIN', 'secret', 1004, 9999, 1004);
    INSERT INTO projects (id, slug, display_name, archived_at, created_at)
      VALUES ('01PROJECTBETA', 'beta', NULL, NULL, 1000);
  `);
  handle.close();
}

function tokenRows(handle: DbHandle): Row[] {
  return handle.raw.prepare<[], Row>('SELECT * FROM tokens ORDER BY id').all();
}

function tokensDdl(handle: DbHandle): string {
  return (
    handle.raw
      .prepare<
        [],
        { sql: string }
      >(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tokens'`)
      .get()?.sql ?? ''
  );
}

function insertToken(handle: DbHandle, id: string, scope: string, projectId: string | null): void {
  handle.raw
    .prepare(
      `INSERT INTO tokens (id, name, hash, scope, project_id, created_at, expires_at, revoked_at)
         VALUES (?, ?, 's1$aa$bb', ?, ?, 2000, NULL, NULL)`,
    )
    .run(id, id, scope, projectId);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-0029-data-'));
  migrationsDir = mkdtempSync(join(tmpdir(), 'rembric-0029-migrations-'));
  stagePreMigration();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(migrationsDir, { recursive: true, force: true });
});

describe('migration 0029 — tokens project binding', () => {
  it('preserves every pre-existing row verbatim, including the malformed legacy scope', () => {
    seeded();
    const pre = open();
    const before = tokenRows(pre);
    pre.close();
    expect(before).toHaveLength(3);

    stage0029();
    const handle = open();
    try {
      expect(tokenRows(handle)).toEqual(before);
      expect(
        handle.raw
          .prepare<[], Row>(`SELECT scope, project_id FROM tokens WHERE id = '01TOKLEGACY'`)
          .get(),
      ).toEqual({ scope: 'project:alpha', project_id: null });
    } finally {
      handle.close();
    }
  });

  it('drops the FK parent without dangling either child table', () => {
    seeded();
    stage0029();
    const handle = open();
    try {
      expect(handle.raw.prepare<[], Row>('PRAGMA foreign_key_check').all()).toEqual([]);
      const counts = handle.raw
        .prepare<
          [],
          { sessions: number; dashboard: number }
        >(`SELECT (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM dashboard_sessions) AS dashboard`)
        .get();
      expect(counts).toEqual({ sessions: 1, dashboard: 1 });
    } finally {
      handle.close();
    }
  });

  it('keeps exactly tokens_name_unique and the primary-key autoindex', () => {
    seeded();
    stage0029();
    const handle = open();
    try {
      const names = handle.raw
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tokens' ORDER BY name`,
        )
        .all()
        .map((r) => r.name);
      expect(names).toEqual(['sqlite_autoindex_tokens_1', 'tokens_name_unique']);
    } finally {
      handle.close();
    }
  });

  it('rejects a scope string that names a different project than project_id', () => {
    seeded();
    stage0029();
    const handle = open();
    try {
      expect(() =>
        insertToken(handle, '01DRIFT', 'project:01PROJECTBETA', '01PROJECTALPHA'),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        insertToken(handle, '01AGREEW', 'project:01PROJECTALPHA', '01PROJECTALPHA'),
      ).not.toThrow();
      expect(() =>
        insertToken(handle, '01AGREER', 'read:project:01PROJECTALPHA', '01PROJECTALPHA'),
      ).not.toThrow();
      expect(() => insertToken(handle, '01UNBOUND', 'project:alpha', null)).not.toThrow();
      expect(() =>
        handle.raw
          .prepare(`UPDATE tokens SET scope = 'project:01PROJECTBETA' WHERE id = '01AGREEW'`)
          .run(),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      handle.close();
    }
  });

  it('still rejects a slug in project_id, and still accepts a real project id', () => {
    seeded();
    stage0029();
    const handle = open();
    try {
      expect(() =>
        insertToken(handle, '01FKOK', 'project:01PROJECTALPHA', '01PROJECTALPHA'),
      ).not.toThrow();
      expect(() => insertToken(handle, '01FKBAD', 'project:alpha', 'alpha')).toThrow(
        /FOREIGN KEY constraint failed/,
      );
    } finally {
      handle.close();
    }
  });

  it('re-applies nothing on a second boot', () => {
    seeded();
    stage0029();
    open().close();

    const handle = open();
    try {
      expect(
        handle.raw
          .prepare<
            [string],
            { n: number }
          >(`SELECT count(*) AS n FROM _migrations WHERE filename = ?`)
          .get(MIGRATION)?.n,
      ).toBe(1);
      expect(tokensDdl(handle).match(/tokens_project_scope_check/g)).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('aborts cleanly, leaving no partial table, when a pre-existing row violates the CHECK', () => {
    seeded();
    const pre = open();
    // Only reachable by hand-editing: no writer produces a disagreeing pair.
    insertToken(pre, '01HANDEDIT', 'project:01PROJECTBETA', '01PROJECTALPHA');
    pre.close();

    stage0029();
    expect(() => open()).toThrow(/CHECK constraint failed/);

    unstage0029();
    const handle = open();
    try {
      expect(
        handle.raw
          .prepare<
            [string],
            { n: number }
          >(`SELECT count(*) AS n FROM _migrations WHERE filename = ?`)
          .get(MIGRATION)?.n,
      ).toBe(0);
      expect(
        handle.raw
          .prepare<
            [],
            { n: number }
          >(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'tokens_new'`)
          .get()?.n,
      ).toBe(0);
      expect(tokensDdl(handle)).not.toContain('tokens_project_scope_check');
      expect(tokenRows(handle)).toHaveLength(4);
    } finally {
      handle.close();
    }
  });
});
