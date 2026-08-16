import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../db/schema/index.js';

import { createTestDb } from './db.js';
import { ALL_TABLES } from './schema-inventory.js';

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

/**
 * Every trigger a table-rebuild migration must recreate. A dropped trigger
 * is silent — new rows stop being FTS/vec-indexed with no error anywhere —
 * so this is the guard the `procedural`-type table-rebuild migration
 * (improve-recall-relevance) depends on: run this test before and after
 * writing that migration and confirm the set is unchanged.
 */
const EXPECTED_TRIGGERS: Record<string, string[]> = {
  memory: [
    'memory_ai',
    'memory_ad',
    'memory_au',
    'memory_vec_status_sync',
    'memory_replaces_ai',
    'memory_replaces_au',
    'memory_replaces_ad',
  ],
  prompts: ['prompts_ai', 'prompts_ad', 'prompts_au'],
};

/**
 * Derived from the shared taxonomy in `schema-inventory.ts`, not restated: this
 * list and the source/derived registry in `invariants.test.ts` were two
 * hand-maintained copies of the same 29 names and drifted within one branch
 * (`memory_replaces`, `prompts_fts` and the three `oauth_*` tables were missing
 * here while the rest of this file already knew them). The vec0 shadow set is
 * pinned there too, so a sqlite-vec layout change is one edit.
 */
const EXPECTED_TABLES = [...ALL_TABLES];

/**
 * Shadow tables of FTS5 / vec0. Their INDEX set varies by extension version even
 * when the table set does not, so they are excluded from the index/PK/
 * WITHOUT-ROWID assertions below — a prefix on purpose here, because it is the
 * index set that is unpinnable, not the table set.
 */
const SHADOW_TABLE = /^(memory_fts|prompts_fts|memory_vec)/;

/**
 * Every index on a table we own, asserted as an EXACT set — a subset assertion
 * is what let `memory_entity_links`' composite PK exist in SQL but not in
 * Drizzle. `sql: null` marks a PK/UNIQUE autoindex, which is how a table
 * silently losing WITHOUT ROWID would show up. Normalized by `normalizeDdl`.
 */
const EXPECTED_INDEXES: { name: string; sql: string | null }[] = [
  {
    name: 'confirmations_memory_id_idx',
    sql: 'CREATE INDEX confirmations_memory_id_idx ON confirmations (memory_id)',
  },
  {
    name: 'confirmations_memory_verdict_ts_idx',
    sql: 'CREATE INDEX confirmations_memory_verdict_ts_idx ON confirmations (memory_id, verdict, event_ts)',
  },
  {
    name: 'confirmations_session_idx',
    sql: 'CREATE INDEX confirmations_session_idx ON confirmations (session_id)',
  },
  {
    name: 'consolidation_ops_run_id_idx',
    sql: 'CREATE INDEX consolidation_ops_run_id_idx ON consolidation_ops (run_id)',
  },
  {
    name: 'consolidation_runs_started_at_idx',
    sql: 'CREATE INDEX consolidation_runs_started_at_idx ON consolidation_runs (started_at)',
  },
  {
    name: 'dashboard_sessions_expires_at_idx',
    sql: 'CREATE INDEX dashboard_sessions_expires_at_idx ON dashboard_sessions (expires_at)',
  },
  {
    name: 'memory_created_at_idx',
    sql: 'CREATE INDEX memory_created_at_idx ON memory (created_at)',
  },
  {
    name: 'memory_entities_identity_idx',
    sql: 'CREATE UNIQUE INDEX memory_entities_identity_idx ON memory_entities (scope, project_id, kind, value)',
  },
  {
    name: 'memory_entity_links_memory_idx',
    sql: 'CREATE INDEX memory_entity_links_memory_idx ON memory_entity_links (memory_id)',
  },
  {
    name: 'memory_relations_judgment_id_unique',
    sql: 'CREATE UNIQUE INDEX memory_relations_judgment_id_unique ON memory_relations (judgment_id)',
  },
  {
    name: 'memory_relations_source_status_idx',
    sql: 'CREATE INDEX memory_relations_source_status_idx ON memory_relations (source_id, status)',
  },
  {
    name: 'memory_relations_status_created_idx',
    sql: 'CREATE INDEX memory_relations_status_created_idx ON memory_relations (status, created_at)',
  },
  {
    name: 'memory_relations_target_status_idx',
    sql: 'CREATE INDEX memory_relations_target_status_idx ON memory_relations (target_id, status)',
  },
  {
    name: 'memory_scope_project_status_created_idx',
    sql: 'CREATE INDEX memory_scope_project_status_created_idx ON memory (scope, project_id, status, created_at)',
  },
  {
    name: 'memory_scope_seen_idx',
    sql: 'CREATE INDEX memory_scope_seen_idx ON memory (scope, project_id, COALESCE(last_seen_at, created_at) DESC)',
  },
  { name: 'memory_session_idx', sql: 'CREATE INDEX memory_session_idx ON memory (session_id)' },
  {
    name: 'memory_status_created_idx',
    sql: 'CREATE INDEX memory_status_created_idx ON memory (status, created_at)',
  },
  {
    name: 'memory_type_in_scope_idx',
    sql: 'CREATE INDEX memory_type_in_scope_idx ON memory (scope, project_id, type)',
  },
  {
    name: 'memory_relations_created_at_idx',
    sql: 'CREATE INDEX memory_relations_created_at_idx ON memory_relations (created_at)',
  },
  {
    name: 'prompts_created_active_idx',
    sql: 'CREATE INDEX prompts_created_active_idx ON prompts (created_at) WHERE deleted_at IS NULL',
  },
  {
    name: 'prompts_deleted_idx',
    sql: 'CREATE INDEX prompts_deleted_idx ON prompts (deleted_at) WHERE deleted_at IS NOT NULL',
  },
  {
    name: 'sessions_active_transport_idx',
    sql: "CREATE INDEX sessions_active_transport_idx ON sessions (token_id, project_id, COALESCE(last_activity_at, started_at) DESC) WHERE status = 'active' AND deleted_at IS NULL",
  },
  {
    name: 'memory_topic_key_active_idx',
    sql: "CREATE INDEX memory_topic_key_active_idx ON memory (scope, project_id, topic_key) WHERE status = 'active' AND topic_key IS NOT NULL",
  },
  {
    name: 'memory_topic_key_active_uidx',
    sql: "CREATE UNIQUE INDEX memory_topic_key_active_uidx ON memory (scope, COALESCE(project_id, ''), topic_key) WHERE status = 'active' AND topic_key IS NOT NULL",
  },
  {
    name: 'oauth_authorization_codes_hash_idx',
    sql: 'CREATE INDEX oauth_authorization_codes_hash_idx ON oauth_authorization_codes (hash)',
  },
  {
    name: 'oauth_tokens_family_idx',
    sql: 'CREATE INDEX oauth_tokens_family_idx ON oauth_tokens (family_id)',
  },
  {
    name: 'oauth_tokens_hash_idx',
    sql: 'CREATE INDEX oauth_tokens_hash_idx ON oauth_tokens (hash)',
  },
  {
    name: 'projects_archived_idx',
    sql: 'CREATE INDEX projects_archived_idx ON projects (archived_at)',
  },
  {
    name: 'projects_is_default_uidx',
    sql: 'CREATE UNIQUE INDEX projects_is_default_uidx ON projects(is_default) WHERE is_default = 1',
  },
  {
    name: 'projects_slug_unique',
    sql: 'CREATE UNIQUE INDEX projects_slug_unique ON projects (slug)',
  },
  {
    name: 'prompts_project_created_idx',
    sql: 'CREATE INDEX prompts_project_created_idx ON prompts (project_id, created_at)',
  },
  { name: 'prompts_session_idx', sql: 'CREATE INDEX prompts_session_idx ON prompts (session_id)' },
  {
    name: 'sessions_project_started_idx',
    sql: 'CREATE INDEX sessions_project_started_idx ON sessions (project_id, started_at)',
  },
  {
    name: 'sessions_status_started_idx',
    sql: 'CREATE INDEX sessions_status_started_idx ON sessions (status, started_at)',
  },
  {
    name: 'sessions_token_status_idx',
    sql: 'CREATE INDEX sessions_token_status_idx ON sessions (token_id, status)',
  },
  { name: 'sqlite_autoindex__migrations_1', sql: null },
  { name: 'sqlite_autoindex_confirmations_1', sql: null },
  { name: 'sqlite_autoindex_consolidation_ops_1', sql: null },
  { name: 'sqlite_autoindex_consolidation_runs_1', sql: null },
  { name: 'sqlite_autoindex_dashboard_sessions_1', sql: null },
  { name: 'sqlite_autoindex_memory_1', sql: null },
  { name: 'sqlite_autoindex_memory_entities_1', sql: null },
  { name: 'sqlite_autoindex_memory_relations_1', sql: null },
  { name: 'sqlite_autoindex_oauth_authorization_codes_1', sql: null },
  { name: 'sqlite_autoindex_oauth_clients_1', sql: null },
  { name: 'sqlite_autoindex_oauth_tokens_1', sql: null },
  { name: 'sqlite_autoindex_projects_1', sql: null },
  { name: 'sqlite_autoindex_prompts_1', sql: null },
  { name: 'sqlite_autoindex_sessions_1', sql: null },
  { name: 'sqlite_autoindex_tokens_1', sql: null },
  { name: 'tokens_name_unique', sql: 'CREATE UNIQUE INDEX tokens_name_unique ON tokens (name)' },
];

/**
 * Live in migration SQL only, deliberately — NOT omissions to be "fixed".
 * drizzle-kit 0.27.2 splits an `sql` index expression on its commas and
 * back-quotes each fragment as an identifier, so it emits invalid DDL for both
 * (verified). `memory_topic_key_active_uidx` additionally needs to be an
 * expression index to enforce its uniqueness across NULL project_id at all.
 */
const DRIZZLE_INEXPRESSIBLE_INDEXES = [
  'memory_scope_seen_idx',
  'memory_topic_key_active_uidx',
  // Expression column (COALESCE) plus a partial WHERE. `.where()` alone is
  // expressible — `memory_topic_key_active_idx` is declared — but an `sql`
  // index COLUMN is what drizzle-kit mangles, so this joins the other two.
  'sessions_active_transport_idx',
];

/** Same category: no Drizzle release models `WITHOUT ROWID`. */
const EXPECTED_WITHOUT_ROWID_TABLES = [
  'memory_entity_links',
  'memory_entity_scan',
  'memory_replaces',
  'token_projects',
];

/** Backtick quoting and line breaks are formatting, not schema. */
function normalizeDdl(ddl: string | null): string | null {
  return ddl === null ? null : ddl.replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

// `pk` is the 1-based position within the primary key, so a composite PK reads
// 1, 2, … — that ordering is load-bearing for `memory_entity_links`.
const EXPECTED_COLUMNS: Record<
  string,
  { name: string; type: string; notnull: 0 | 1; pk: number }[]
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
    { name: 'is_default', type: 'INTEGER', notnull: 1, pk: 0 },
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
    { name: 'last_activity_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'last_work_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'last_summary_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'last_nudge_at', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'last_turn_report_at', type: 'INTEGER', notnull: 0, pk: 0 },
  ],
  confirmations: [
    { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'memory_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'event_ts', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'source', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'session_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'verdict', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'reason', type: 'TEXT', notnull: 0, pk: 0 },
  ],
  memory_entities: [
    { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'scope', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'kind', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  memory_entity_links: [
    { name: 'entity_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'memory_id', type: 'TEXT', notnull: 1, pk: 2 },
  ],
  memory_entity_scan: [
    { name: 'memory_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'scanned_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ],
  token_projects: [
    { name: 'token_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 2 },
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

    for (const expected of EXPECTED_TABLES) {
      expect(tables, `table '${expected}' missing after migrations`).toContain(expected);
    }

    // Exact set, shadows included: tolerating unclassified tables is how
    // `memory_replaces`, `prompts_fts` and the three `oauth_*` tables stayed
    // unenumerated here while the rest of the file already knew them. The vec0
    // shadows used to be exempt for varying by extension version; they are now
    // pinned in `schema-inventory.ts`, so an upgrade fails in one place.
    expect(tables).toEqual([...EXPECTED_TABLES].sort());
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

  it('matches the checked-in index snapshot exactly', () => {
    const actual = testDb.handle.raw
      .prepare<[], SqliteMasterRow & { sql: string | null }>(
        `SELECT name, type, tbl_name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name`,
      )
      .all()
      .filter((r) => !SHADOW_TABLE.test(r.tbl_name))
      .map((r) => ({ name: r.name, sql: normalizeDdl(r.sql) }));

    expect(actual).toEqual(
      [...EXPECTED_INDEXES]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((i) => ({
          name: i.name,
          sql: normalizeDdl(i.sql),
        })),
    );
  });

  it('every index in the DB is declared in the Drizzle schema, bar the allow-list', () => {
    const declared = new Set<string>();
    for (const value of Object.values(schema)) {
      if (!is(value, SQLiteTable)) continue;
      for (const idx of getTableConfig(value).indexes) declared.add(idx.config.name);
    }

    const undeclared = EXPECTED_INDEXES.filter(
      (i) =>
        i.sql !== null && !declared.has(i.name) && !DRIZZLE_INEXPRESSIBLE_INDEXES.includes(i.name),
    ).map((i) => i.name);
    expect(undeclared, 'index lives in migration SQL only — declare it or allow-list it').toEqual(
      [],
    );

    const phantom = [...declared].filter((name) => !EXPECTED_INDEXES.some((i) => i.name === name));
    expect(phantom, 'index declared in Drizzle but absent from the DB').toEqual([]);
  });

  it('every Drizzle table declares the primary key the DB actually has', () => {
    for (const value of Object.values(schema)) {
      if (!is(value, SQLiteTable)) continue;
      const config = getTableConfig(value);
      if (SHADOW_TABLE.test(config.name)) continue;

      const composite = config.primaryKeys[0];
      const declared = composite
        ? composite.columns.map((c) => c.name)
        : config.columns.filter((c) => c.primary).map((c) => c.name);

      const actual = testDb.handle.raw
        .prepare<[], ColumnInfo>(`PRAGMA table_info(${config.name})`)
        .all()
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);

      expect(declared, `primary key drift on '${config.name}'`).toEqual(actual);
    }
  });

  it('keeps WITHOUT ROWID on the tables that declare it', () => {
    const actual = testDb.handle.raw
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%WITHOUT ROWID%' ORDER BY name`,
      )
      .all()
      .map((r) => r.name)
      .filter((name) => !SHADOW_TABLE.test(name));

    expect(actual).toEqual([...EXPECTED_WITHOUT_ROWID_TABLES].sort());
  });

  it('every expected trigger on memory and prompts survives migration', () => {
    const rows = testDb.handle.raw
      .prepare<
        [],
        SqliteMasterRow
      >(`SELECT name, type, tbl_name FROM sqlite_master WHERE type = 'trigger'`)
      .all();
    for (const [table, expected] of Object.entries(EXPECTED_TRIGGERS)) {
      const actual = rows.filter((r) => r.tbl_name === table).map((r) => r.name);
      for (const name of expected) {
        expect(actual, `trigger '${name}' missing on '${table}' after migrations`).toContain(name);
      }
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
