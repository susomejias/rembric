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

describe('migration 0012_drop_summary_length_check (summary CHECK removed)', () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.cleanup());

  it('no longer rejects a direct INSERT with an oversized summary (the 0011 CHECK was dropped)', () => {
    const raw = db.handle.raw;
    raw
      .prepare(
        "INSERT INTO tokens (id, name, hash, scope, created_at) VALUES ('tok1', 'tok1-name', 'h', '*', 0)",
      )
      .run();
    // > the old 2000 cap and > the new 10000 server cap: the DB no longer
    // enforces length; the cap lives only in SUMMARY_MAX_CHARS server-side.
    expect(() =>
      raw
        .prepare(
          "INSERT INTO sessions (id, token_id, agent, started_at, summary, status) VALUES ('s1', 'tok1', 'claude', 0, ?, 'active')",
        )
        .run('a'.repeat(20_000)),
    ).not.toThrow();
    const len = (
      raw.prepare("SELECT length(summary) AS len FROM sessions WHERE id = 's1'").get() as {
        len: number;
      }
    ).len;
    expect(len).toBe(20_000);
  });

  it('no longer rejects a direct UPDATE with an oversized summary', () => {
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
      raw.prepare("UPDATE sessions SET summary = ? WHERE id = 's2'").run('a'.repeat(20_000)),
    ).not.toThrow();
  });

  it('accepts a 2000-char summary (old cap) and NULL summary unchanged', () => {
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

// Prod-safety for 0014: the memory_vec rebuild must run over a POPULATED
// 2-column vec0 table without losing embeddings or corrupting the vtable's
// shadow tables (the failure mode of ALTER…RENAME), and must derive the new
// partition_key/status/type metadata correctly from the joined memory rows.
describe('migration 0014_hybrid_search_vec_rebuild over populated data', () => {
  let dataDir: string;
  let slicedDir: string;
  let raw: Database.Database;

  const vec = (a: number, b: number): Buffer => {
    const v = new Float32Array(768);
    v[0] = a;
    v[1] = b;
    return Buffer.from(v.buffer);
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-mig14-data-'));
    slicedDir = mkdtempSync(join(tmpdir(), 'rembric-mig14-slice-'));
    const all = readdirSync(fullMigrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of all) {
      if (f.startsWith('0014_')) break;
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

  it('preserves every embedding byte-for-byte and derives metadata, without corrupting the vtable', () => {
    // Pre-0014 state: a project + a global and a project memory (different
    // statuses/types) each with a 2-column memory_vec row.
    raw
      .prepare(
        "INSERT INTO projects (id, slug, display_name, created_at) VALUES ('proj1', 'proj1', 'proj1', 0)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO memory (id, scope, project_id, type, content, status, created_at) VALUES ('g1', 'global', NULL, 'user', 'global one', 'active', 0)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO memory (id, scope, project_id, type, content, status, created_at) VALUES ('p1', 'project', 'proj1', 'project', 'project one', 'superseded', 0)",
      )
      .run();
    const embG = vec(1, 0);
    const embP = vec(0, 1);
    raw.prepare('INSERT INTO memory_vec (memory_id, embedding) VALUES (?, ?)').run('g1', embG);
    raw.prepare('INSERT INTO memory_vec (memory_id, embedding) VALUES (?, ?)').run('p1', embP);

    // Apply 0014 (and anything after) over the populated 2-column table.
    const result = migrate(raw, { migrationsDir: fullMigrationsDir });
    expect(result.applied).toContain('0014_hybrid_search_vec_rebuild.sql');

    // No FK damage and the rebuild scratch table is gone.
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const leftover = raw
      .prepare("SELECT name FROM sqlite_master WHERE name = '_memory_vec_rebuild'")
      .all();
    expect(leftover).toEqual([]);

    // Both vectors survived, with metadata derived from the memory rows.
    const rows = raw
      .prepare<
        [],
        { memory_id: string; partition_key: string; status: string; type: string }
      >('SELECT memory_id, partition_key, status, type FROM memory_vec ORDER BY memory_id')
      .all();
    expect(rows).toEqual([
      { memory_id: 'g1', partition_key: '__global__', status: 'active', type: 'user' },
      { memory_id: 'p1', partition_key: 'proj1', status: 'superseded', type: 'project' },
    ]);

    // Embeddings are byte-identical (no re-embedding, no precision loss).
    const backG = raw
      .prepare<
        [string],
        { embedding: Buffer }
      >('SELECT embedding FROM memory_vec WHERE memory_id = ?')
      .get('g1');
    expect(Buffer.compare(backG!.embedding, embG)).toBe(0);

    // The status-sync trigger mirrors memory.status into the vec row.
    raw.prepare("UPDATE memory SET status = 'archived' WHERE id = 'g1'").run();
    const synced = raw
      .prepare<[string], { status: string }>('SELECT status FROM memory_vec WHERE memory_id = ?')
      .get('g1');
    expect(synced!.status).toBe('archived');

    // The rebuilt vtable answers a partition+status-filtered kNN (proves the
    // shadow tables are intact — ALTER…RENAME would have left them dangling).
    const hits = raw
      .prepare<[Buffer, string], { memory_id: string }>(
        `SELECT memory_id FROM memory_vec
         WHERE embedding MATCH ? AND k = 5 AND partition_key = ? AND status = 'superseded'`,
      )
      .all(vec(0, 1), 'proj1');
    expect(hits.map((h) => h.memory_id)).toEqual(['p1']);
  });

  it('is a no-op-safe rebuild when memory_vec is empty', () => {
    const result = migrate(raw, { migrationsDir: fullMigrationsDir });
    expect(result.applied).toContain('0014_hybrid_search_vec_rebuild.sql');
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // Fresh inserts use the new 5-column shape.
    raw
      .prepare(
        "INSERT INTO memory (id, scope, project_id, type, title, content, status, created_at) VALUES ('g2', 'global', NULL, 'user', 'g2 title', 'x', 'active', 0)",
      )
      .run();
    expect(() =>
      raw
        .prepare(
          'INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) VALUES (?, ?, ?, ?, ?)',
        )
        .run('g2', '__global__', 'active', 'user', vec(1, 1)),
    ).not.toThrow();
  });
});

describe('migration 0015_tidy_consolidation_journal over populated data', () => {
  let dataDir: string;
  let slicedDir: string;
  let raw: Database.Database;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-mig15-data-'));
    slicedDir = mkdtempSync(join(tmpdir(), 'rembric-mig15-slice-'));
    const all = readdirSync(fullMigrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of all) {
      if (f.startsWith('0015_')) break;
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

  it('drops the llm_* columns, backfills NULL scope, renames consolidation_id → run_id, and preserves every row', () => {
    // Pre-0015 state: the old shape still has llm_provider/llm_model and a
    // nullable scope; consolidation_ops still has the consolidation_id column.
    raw
      .prepare(
        "INSERT INTO consolidation_runs (id, started_at, llm_provider, llm_model, scope, summary) VALUES ('run-a', 0, 'openai', 'gpt-x', 'global', '{}')",
      )
      .run();
    // A legacy run that predates scope population (scope IS NULL → backfilled).
    raw
      .prepare(
        "INSERT INTO consolidation_runs (id, started_at, llm_provider, llm_model, scope, summary) VALUES ('run-legacy', 0, NULL, NULL, NULL, NULL)",
      )
      .run();
    // A historical merge op and a decay op (must survive renderable/undoable).
    raw
      .prepare(
        "INSERT INTO consolidation_ops (id, consolidation_id, op_type, affected_ids, created_id, applied_at) VALUES ('op-merge', 'run-a', 'merge', '[\"m1\",\"m2\"]', 'm3', 0)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO consolidation_ops (id, consolidation_id, op_type, affected_ids, applied_at) VALUES ('op-decay', 'run-legacy', 'decay', '[\"m4\"]', 0)",
      )
      .run();

    const result = migrate(raw, { migrationsDir: fullMigrationsDir });
    expect(result.applied).toContain('0015_tidy_consolidation_journal.sql');
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // consolidation_runs lost the two llm columns and gained a NOT NULL scope.
    const runCols = raw
      .prepare<[], { name: string; notnull: number }>('PRAGMA table_info(consolidation_runs)')
      .all();
    const runColNames = runCols.map((c) => c.name);
    expect(runColNames).not.toContain('llm_provider');
    expect(runColNames).not.toContain('llm_model');
    expect(runCols.find((c) => c.name === 'scope')!.notnull).toBe(1);

    // consolidation_ops renamed the FK column and recreated its index.
    const opCols = raw
      .prepare<[], { name: string }>('PRAGMA table_info(consolidation_ops)')
      .all()
      .map((c) => c.name);
    expect(opCols).toContain('run_id');
    expect(opCols).not.toContain('consolidation_id');
    const idx = raw
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='consolidation_ops'",
      )
      .all()
      .map((r) => r.name);
    expect(idx).toContain('consolidation_ops_run_id_idx');
    expect(idx).not.toContain('consolidation_ops_consolidation_id_idx');

    // Every run row preserved; the NULL-scope legacy row backfilled to 'unknown'.
    const runs = raw
      .prepare<
        [],
        { id: string; scope: string }
      >('SELECT id, scope FROM consolidation_runs ORDER BY id')
      .all();
    expect(runs).toEqual([
      { id: 'run-a', scope: 'global' },
      { id: 'run-legacy', scope: 'unknown' },
    ]);

    // Every op row preserved with its run_id intact (historical merge included).
    const ops = raw
      .prepare<
        [],
        { id: string; run_id: string; op_type: string }
      >('SELECT id, run_id, op_type FROM consolidation_ops ORDER BY id')
      .all();
    expect(ops).toEqual([
      { id: 'op-decay', run_id: 'run-legacy', op_type: 'decay' },
      { id: 'op-merge', run_id: 'run-a', op_type: 'merge' },
    ]);
  });

  it('migration simulation: a fully-populated prod-like DB upgrades with no data loss and no corruption', () => {
    // Seed every table 0015 could plausibly interact with — the rebuilt
    // parent (consolidation_runs), its child (consolidation_ops), plus a
    // representative spread of unrelated tables — so PRAGMA integrity_check
    // and foreign_key_check below cover the WHOLE file, not just the two
    // touched tables.
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
        "INSERT INTO sessions (id, token_id, project_id, agent, started_at, summary, status) VALUES ('sess1', 'tok1', 'proj1', 'claude', 0, ?, 'active')",
      )
      .run('s'.repeat(1500));
    raw
      .prepare(
        "INSERT INTO prompts (id, session_id, project_id, title, content, tags, replaces, created_at) VALUES ('p1', 'sess1', 'proj1', 'untitled', 'body', '[]', '[]', 0)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO memory (id, scope, project_id, type, content, created_at, session_id) VALUES ('m1', 'project', 'proj1', 'fact', 'project body', 0, 'sess1')",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO memory (id, scope, project_id, type, content, created_at) VALUES ('m2', 'global', NULL, 'user', 'global body', 0)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO confirmations (id, memory_id, event_ts, session_id) VALUES ('c1', 'm1', 0, 'sess1')",
      )
      .run();
    raw
      .prepare(
        'INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) VALUES (?, ?, ?, ?, ?)',
      )
      .run('m1', 'proj1', 'active', 'fact', Buffer.from(new Float32Array(768).buffer));
    raw
      .prepare(
        "INSERT INTO consolidation_runs (id, started_at, llm_provider, llm_model, scope, summary) VALUES ('run-a', 0, 'openai', 'gpt-x', 'project:proj1', '{}')",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO consolidation_runs (id, started_at, llm_provider, llm_model, scope, summary) VALUES ('run-legacy', 0, NULL, NULL, NULL, NULL)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO consolidation_ops (id, consolidation_id, op_type, affected_ids, created_id, applied_at) VALUES ('op-merge', 'run-a', 'merge', '[\"m1\"]', 'm2', 0)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO consolidation_ops (id, consolidation_id, op_type, affected_ids, created_id, applied_at) VALUES ('op-orphan', 'run-a', 'orphan_promote', '[\"m1\",\"m2\"]', 'judg-1', 0)",
      )
      .run();

    const TABLES = [
      'tokens',
      'projects',
      'sessions',
      'prompts',
      'memory',
      'confirmations',
      'memory_vec',
      'consolidation_runs',
      'consolidation_ops',
    ];
    const countAll = () =>
      Object.fromEntries(
        TABLES.map((t) => [
          t,
          raw.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n,
        ]),
      );
    const before = countAll();

    const result = migrate(raw, { migrationsDir: fullMigrationsDir });
    expect(result.applied).toContain('0015_tidy_consolidation_journal.sql');

    // No corruption anywhere in the file, and no dangling foreign keys.
    expect(raw.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // No row vanished from any table.
    expect(countAll()).toEqual(before);

    // Unrelated tables are byte-identical (0015 must not touch them).
    expect(
      raw.prepare<[], { content: string }>("SELECT content FROM memory WHERE id = 'm1'").get()!
        .content,
    ).toBe('project body');
    expect(
      raw
        .prepare<[], { summary: string | null }>("SELECT summary FROM sessions WHERE id = 'sess1'")
        .get()!.summary?.length,
    ).toBe(1500);

    // The legacy NULL-scope run was backfilled; every op kept its run_id.
    expect(
      raw
        .prepare<
          [],
          { scope: string }
        >("SELECT scope FROM consolidation_runs WHERE id = 'run-legacy'")
        .get()!.scope,
    ).toBe('unknown');
    expect(
      raw
        .prepare<
          [],
          { run_id: string }
        >("SELECT run_id FROM consolidation_ops WHERE id = 'op-orphan'")
        .get()!.run_id,
    ).toBe('run-a');
  });
});

// Regression for the production incident where 0011 failed with
// `FOREIGN KEY constraint failed` because `sessions` is a FK parent
// (prompts/memory/confirmations all reference it) and the table-rebuild
// dance dropped a populated parent under `foreign_keys=ON`. The fix is
// `PRAGMA defer_foreign_keys = ON` at the top of the migration.
describe('migrations 0011 + 0012 with referencing children', () => {
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
        "INSERT INTO sessions (id, token_id, project_id, agent, started_at, summary, status) VALUES ('sess1', 'tok1', 'proj1', 'claude', 0, ?, 'active')",
      )
      .run('a'.repeat(2000));

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

    // Re-run migrations against the FULL dir → 0011 and 0012 are new and run.
    // Both rebuild `sessions` while it is a populated FK parent, so this
    // exercises the FK-safe dance for both migrations.
    const result = migrate(raw, { migrationsDir: fullMigrationsDir });
    expect(result.applied).toEqual([
      '0011_summary_length_check.sql',
      '0012_drop_summary_length_check.sql',
      '0013_oauth_tables.sql',
      '0014_hybrid_search_vec_rebuild.sql',
      '0015_tidy_consolidation_journal.sql',
      '0016_add_memory_title.sql',
      '0017_oauth_project_binding.sql',
      '0018_unique_topic_key_active_index.sql',
      '0019_memory_scope_seen_index.sql',
      '0020_fix_fts_delete_triggers.sql',
      '0021_memory_replaces_table.sql',
      '0022_session_last_activity.sql',
      '0023_memory_entities.sql',
      '0024_confirmation_verdict.sql',
    ]);

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
    // The 2000-char summary survives both rebuilds verbatim (loss-free).
    expect(session?.id).toBe('sess1');
    expect(session?.summary?.length).toBe(2000);

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

    // After 0012 the summary CHECK is gone — an oversized direct UPDATE
    // succeeds at the DB level (the cap is enforced server-side only).
    expect(() =>
      raw.prepare("UPDATE sessions SET summary = ? WHERE id = 'sess1'").run('a'.repeat(20_000)),
    ).not.toThrow();
  });
});

// Prod-safety for 0016: the title backfill must produce a 1..100-char NON-EMPTY
// title for EVERY pre-existing row — including adversarial content the DB never
// forbade (empty/whitespace, markdown-only first line, CRLF, over-100) — or the
// CHECK(length(title) BETWEEN 1 AND 100) aborts the irreversible migration.
describe('migration 0016_add_memory_title backfill over adversarial content', () => {
  let dataDir: string;
  let slicedDir: string;
  let raw: Database.Database;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-mig16-data-'));
    slicedDir = mkdtempSync(join(tmpdir(), 'rembric-mig16-slice-'));
    for (const f of readdirSync(fullMigrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      if (f.startsWith('0016_')) break;
      copyFileSync(join(fullMigrationsDir, f), join(slicedDir, f));
    }
    raw = new Database(join(dataDir, 'data.db'));
    sqliteVec.load(raw);
    raw.pragma('foreign_keys = ON');
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

  it('backfills a valid 1..100-char title for every adversarial pre-0016 row', () => {
    // Pre-0016 schema has `content NOT NULL` but no non-empty CHECK, so each of
    // these is a legal legacy row the backfill must survive.
    const rows: Array<{ id: string; content: string }> = [
      { id: 'normal', content: '**Bold lead** then body' },
      { id: 'empty', content: '' },
      { id: 'blank', content: '   ' },
      { id: 'markdown-only', content: '### \nreal second line' },
      { id: 'crlf', content: 'first line\r\nsecond' },
      { id: 'long', content: 'x'.repeat(250) },
    ];
    const ins = raw.prepare(
      "INSERT INTO memory (id, scope, project_id, type, content, status, created_at) VALUES (?, 'global', NULL, 'user', ?, 'active', 0)",
    );
    for (const r of rows) ins.run(r.id, r.content);

    const result = migrate(raw, { migrationsDir: fullMigrationsDir });
    expect(result.applied).toContain('0016_add_memory_title.sql');
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    const titles = new Map(
      raw
        .prepare<[], { id: string; title: string }>('SELECT id, title FROM memory')
        .all()
        .map((r) => [r.id, r.title]),
    );
    expect(titles.size).toBe(rows.length);
    for (const [, title] of titles) {
      expect(title.length).toBeGreaterThanOrEqual(1);
      expect(title.length).toBeLessThanOrEqual(100);
    }
    // Empty/whitespace fall through to the 'untitled' floor; no trailing CR.
    expect(titles.get('empty')).toBe('untitled');
    expect(titles.get('blank')).toBe('untitled');
    expect(titles.get('crlf')).toBe('first line');
    expect(titles.get('normal')).toBe('Bold lead** then body');
    expect(titles.get('long')).toBe('x'.repeat(100));
  });
});

describe('migration 0017_oauth_project_binding', () => {
  let dataDir: string;
  let slicedDir: string;
  let raw: Database.Database;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-mig17-data-'));
    slicedDir = mkdtempSync(join(tmpdir(), 'rembric-mig17-slice-'));

    // Everything strictly before 0017 → oauth tables exist, binding does not.
    const all = readdirSync(fullMigrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of all) {
      if (f.startsWith('0017_')) break;
      copyFileSync(join(fullMigrationsDir, f), join(slicedDir, f));
    }

    raw = new Database(join(dataDir, 'data.db'));
    sqliteVec.load(raw);
    raw.pragma('journal_mode = WAL');
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

  it('adds project_id and revokes every pre-existing token (force re-consent)', () => {
    raw
      .prepare(
        "INSERT INTO oauth_tokens (id, kind, hash, client_id, family_id, scope, subject, expires_at, created_at) VALUES ('t-legacy', 'access', 'h', 'c1', 'f1', 'mcp', 'op', 9999999999999, 0)",
      )
      .run();

    const result = migrate(raw, { migrationsDir: fullMigrationsDir });
    expect(result.applied).toContain('0017_oauth_project_binding.sql');

    // The additive column exists...
    const cols = raw
      .prepare<[], { name: string }>('PRAGMA table_info(oauth_tokens)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('project_id');

    // ...and the legacy token is now revoked (NULL project_id + revoked).
    const row = raw
      .prepare<
        [],
        { revoked_at: number | null; project_id: string | null }
      >("SELECT revoked_at, project_id FROM oauth_tokens WHERE id = 't-legacy'")
      .get();
    expect(row?.project_id).toBeNull();
    expect(row?.revoked_at).not.toBeNull();
  });
});

describe('fresh install vs staged upgrade', () => {
  const dirs: string[] = [];
  const conns: Database.Database[] = [];

  function open(dataDir: string): Database.Database {
    const raw = new Database(join(dataDir, 'data.db'));
    sqliteVec.load(raw);
    raw.pragma('journal_mode = WAL');
    raw.pragma('synchronous = NORMAL');
    raw.pragma('foreign_keys = ON');
    raw.pragma('busy_timeout = 5000');
    conns.push(raw);
    return raw;
  }

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function schemaObjects(raw: Database.Database): { type: string; name: string; sql: string }[] {
    return raw
      .prepare<[], { type: string; name: string; sql: string | null }>(
        `SELECT type, name, sql FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type, name`,
      )
      .all()
      .map((r) => ({
        type: r.type,
        name: r.name,
        sql: (r.sql ?? '').replace(/`/g, '').replace(/\s+/g, ' ').trim(),
      }));
  }

  afterEach(() => {
    for (const c of conns.splice(0)) {
      try {
        c.close();
      } catch {
        // ignore
      }
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('reaches an identical sqlite_master, indexes included, from every migration cut-point', () => {
    const fresh = schemaObjects(
      (() => {
        const raw = open(tempDir('rembric-fresh-'));
        migrate(raw, { migrationsDir: fullMigrationsDir });
        return raw;
      })(),
    );

    const all = readdirSync(fullMigrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const cut of all.slice(1)) {
      const slicedDir = tempDir('rembric-slice-');
      for (const f of all) {
        if (f === cut) break;
        copyFileSync(join(fullMigrationsDir, f), join(slicedDir, f));
      }
      const raw = open(tempDir('rembric-upgraded-'));
      migrate(raw, { migrationsDir: slicedDir });
      migrate(raw, { migrationsDir: fullMigrationsDir });

      expect(
        schemaObjects(raw),
        `upgrade stopping before ${cut} diverges from a fresh install`,
      ).toEqual(fresh);
    }
  });
});
