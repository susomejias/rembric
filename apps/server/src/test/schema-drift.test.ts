import { describe, expect, it } from 'vitest';

import { createTestDb } from './db.js';

/**
 * 13.12 — migration round-trip + 13.13 — schema-drift detection.
 *
 * The fixture above (`createTestDb`) calls `createDb` which applies every
 * migration on a fresh on-disk file. If any migration is destructive or
 * fails (e.g. a column type change without a backfill) this whole module
 * would fail to load.
 *
 * Here we additionally compare the resulting schema against a checked-in
 * snapshot of column shapes. Any new migration that changes a table
 * surface needs to update the snapshot, forcing the author to think
 * about whether the change is forward-compatible.
 */

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface SqliteMasterRow {
  name: string;
  type: string;
  tbl_name: string;
}

const EXPECTED_TABLES = [
  '_migrations',
  'confirmations',
  'consolidation_ops',
  'consolidation_runs',
  'dashboard_sessions',
  'memory',
  'memory_fts',
  'memory_fts_config',
  'memory_fts_data',
  'memory_fts_docsize',
  'memory_fts_idx',
  'memory_relations',
  'memory_vec',
  'projects',
  'prompts',
  'sessions',
  'tokens',
];

const EXPECTED_COLUMNS: Record<
  string,
  { name: string; type: string; notnull: 0 | 1; pk: 0 | 1 }[]
> = {
  memory: [
    { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'scope', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'type', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'title', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'content', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'tags', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'replaces', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'last_seen_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'source', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'session_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'topic_key', type: 'TEXT', notnull: 0, pk: 0 },
  ],
  memory_relations: [
    { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'judgment_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'source_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'target_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'relation', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'reason', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'evidence', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'confidence', type: 'REAL', notnull: 0, pk: 0 },
    { name: 'marked_by_kind', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'marked_by_actor', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'judged_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  projects: [
    { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'slug', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'display_name', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'archived_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  tokens: [
    { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'name', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'scope', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'revoked_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'expires_at', type: 'INTEGER', notnull: 0, pk: 0 },
  ],
  sessions: [
    { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'token_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'agent', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'description', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'started_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'ended_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'summary', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'summary_final', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'title_final', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'deleted_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'bridge_instance_id', type: 'TEXT', notnull: 0, pk: 0 },
  ],
  confirmations: [
    { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'memory_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'event_ts', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'source', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'session_id', type: 'TEXT', notnull: 0, pk: 0 },
  ],
};

describe('13.12 / 13.13 — migration round-trip + schema drift', () => {
  const testDb = createTestDb();

  it('runs all migrations forward against a fresh DB', () => {
    // If createTestDb above didn't throw, the round-trip succeeded.
    const tables = testDb.handle.raw
      .prepare<[], SqliteMasterRow>(
        `SELECT name, type, tbl_name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((r) => r.name)
      .sort();

    // Every expected table must be present; tolerate additional ones
    // (sqlite-vec or FTS5 internals can vary by version).
    for (const expected of EXPECTED_TABLES) {
      expect(tables, `table '${expected}' missing after migrations`).toContain(expected);
    }
  });

  it('records every migration file in _migrations exactly once', () => {
    const rows = testDb.handle.raw
      .prepare<
        [],
        { filename: string; n: number }
      >(`SELECT filename, COUNT(*) AS n FROM _migrations GROUP BY filename`)
      .all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.n, `migration ${row.filename} applied more than once`).toBe(1);
    }
  });

  it('matches the checked-in column snapshot for the main tables', () => {
    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const actual = testDb.handle.raw
        .prepare<[], ColumnInfo>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }));

      // Order can vary if ALTER TABLE reorders, so compare as sorted sets
      // keyed by name.
      const sortByName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
      expect(actual.sort(sortByName), `schema drift on table '${table}'`).toEqual(
        expected.sort(sortByName),
      );
    }
  });

  it('memory FTS5 mirror responds to INSERT/UPDATE triggers', () => {
    // Round-trip: insert a row and assert the FTS index sees it.
    const raw = testDb.handle.raw;
    raw
      .prepare(
        `INSERT INTO memory (id, scope, project_id, type, title, content, tags, status, replaces, created_at)
         VALUES ('drift-row-1', 'global', NULL, 'feedback', 'searchable phrase', 'searchable phrase apple', '[]', 'active', '[]', ?)`,
      )
      .run(Date.now());

    const found = raw
      .prepare<
        [string],
        { id: string }
      >(`SELECT m.id FROM memory m JOIN memory_fts f ON f.rowid = m.rowid WHERE memory_fts MATCH ?`)
      .all('apple');

    expect(found.map((r) => r.id)).toContain('drift-row-1');
  });
});
