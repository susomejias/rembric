import { join } from 'node:path';

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { embeddingInput } from '../embeddings/embedder.js';
import {
  assertDataLossGuard,
  DataLossGuardError,
  writeStateMarker,
} from '../server/data-loss-guard.js';
import { EmbeddingWorker } from '../services/embedding-worker.js';
import { extractEntities } from '../services/entities.js';
import { EntityBackfillWorker } from '../services/entity-backfill-worker.js';
import { MemoryService } from '../services/memory.js';
import { SLUG_REGEX } from '../services/projects.js';
import { projectScope } from '../services/scope.js';
import { doctorReport } from '../test/doctor.js';
import { FakeEmbedder } from '../test/embedder.js';
import { createMigrationFixture, type MigrationFixture } from '../test/migration-fixture.js';
import { DERIVED_TABLES, SHADOW_TABLE_NAMES, SOURCE_TABLES } from '../test/schema-inventory.js';

import { createDiagnostics } from './diagnostics.js';
import { migrate, splitStatements } from './migrate.js';
import { createRepositories } from './repositories/index.js';
import { decodeEmbedding } from './repositories/vectors-repository.js';

import { createDb, type DbHandle } from './index.js';

/**
 * 0031 repoints every previously-global row onto a newly created default
 * project. Its `memory_vec` step is the one whose omission is silent and
 * permanent — `findMissingEmbeddings` is an anti-join over ABSENT rows, so a
 * vector left at a dead partition key is never re-embedded, reads as zero
 * backlog, and disappears from the dense branch while FTS keeps returning the
 * memory. Hence the partition assertions below, each with the non-vacuity
 * control that makes it more than a comparison over an empty table.
 *
 * The corpus is built against the pre-0031 schema through the real services, so
 * `memory_fts`, `memory_vec`, `memory_entities` and `memory_entity_links` carry
 * production-shaped rows. `projects` rows are inserted raw: the Drizzle schema
 * already declares `is_default`, so a `select()` over `projects` cannot run
 * before the column exists.
 */

const MIGRATION = '0031_default_project.sql';

const GLOBAL_ROWS = 16;
const ALPHA_ROWS = 5;

/**
 * Every table whose total the migration must conserve, derived from the one
 * schema inventory rather than hand-listed — so a table added later is inside
 * the census by construction instead of falling silently outside it. `projects`
 * and `_migrations` grow by construction; shadow tables are vec0/fts5 internals
 * with their own row accounting.
 */
const CENSUS_EXCLUDED = new Set(['projects', '_migrations', ...SHADOW_TABLE_NAMES]);
const CENSUS_TABLES = [...SOURCE_TABLES, ...Object.keys(DERIVED_TABLES)]
  .filter((t) => !CENSUS_EXCLUDED.has(t))
  .sort();

type Census = Record<string, number>;

let fx: MigrationFixture;
let embedder: FakeEmbedder;

const open = (onProgress?: (line: string) => void): DbHandle => fx.open(onProgress);

function insertProject(handle: DbHandle, id: string, slug: string): void {
  handle.raw
    .prepare(
      `INSERT INTO projects (id, slug, display_name, archived_at, created_at) VALUES (?, ?, NULL, NULL, 1000)`,
    )
    .run(id, slug);
}

function census(handle: DbHandle): Census {
  // Restricted to what exists at this checkpoint: the fixture stages only the
  // migrations up to 0031, so a table a LATER migration creates is absent by
  // construction and counting it would fail the census rather than test 0031.
  // A table that vanished across the migration still fails, as a key the after
  // census lacks.
  const present = new Set(
    handle.raw
      .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => r.name),
  );
  const out: Census = {};
  for (const t of CENSUS_TABLES) {
    if (!present.has(t)) continue;
    out[t] = handle.raw.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${t}`).get()?.n ?? 0;
  }
  return out;
}

function one<T>(handle: DbHandle, sql: string, ...params: unknown[]): T | undefined {
  return handle.raw.prepare<unknown[], T>(sql).get(...params);
}

function scalar(handle: DbHandle, sql: string, ...params: unknown[]): number {
  return one<{ v: number }>(handle, sql, ...params)?.v ?? 0;
}

function defaultProject(handle: DbHandle): { id: string; slug: string; display_name: string } {
  const row = one<{ id: string; slug: string; display_name: string }>(
    handle,
    `SELECT id, slug, display_name FROM projects WHERE is_default = 1`,
  );
  expect(row, 'no default project').toBeDefined();
  return row!;
}

/**
 * A pre-0031 global memory row with its derived vec and entity rows, all
 * written with SQL. Neither `MemoryService` nor the two backfill workers can
 * produce this state any more: the `Scope` union has one arm, and the workers
 * skip a row that belongs to no project. Constructing the state directly is
 * what keeps this migration testable against the shape it exists to migrate.
 * `memory_fts` is trigger-maintained and still tracks the insert.
 */
function insertGlobalMemory(
  handle: DbHandle,
  row: { id: string; type: string; title: string; content: string; topicKey?: string },
  embedding?: Float32Array,
): string {
  handle.raw
    .prepare(
      `INSERT INTO memory (id, scope, project_id, type, title, content, tags, status, replaces,
                           created_at, last_seen_at, topic_key)
       VALUES (?, 'global', NULL, ?, ?, ?, '[]', 'active', '[]', ?, ?, ?)`,
    )
    .run(row.id, row.type, row.title, row.content, Date.now(), Date.now(), row.topicKey ?? null);

  if (embedding) {
    handle.raw
      .prepare(
        `INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding)
         VALUES (?, '__global__', 'active', ?, ?)`,
      )
      .run(
        row.id,
        row.type,
        Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
      );
  }

  for (const e of extractEntities(row.title, row.content)) {
    const existing = handle.raw
      .prepare<[string, string], { id: string }>(
        `SELECT id FROM memory_entities
          WHERE scope = 'global' AND project_id IS NULL AND kind = ? AND value = ?`,
      )
      .get(e.kind, e.value);
    const entityId = existing?.id ?? ulid();
    if (!existing) {
      handle.raw
        .prepare(
          `INSERT INTO memory_entities (id, scope, project_id, kind, value, created_at)
           VALUES (?, 'global', NULL, ?, ?, ?)`,
        )
        .run(entityId, e.kind, e.value, Date.now());
    }
    handle.raw
      .prepare(`INSERT OR IGNORE INTO memory_entity_links (entity_id, memory_id) VALUES (?, ?)`)
      .run(entityId, row.id);
  }
  handle.raw
    .prepare(`INSERT OR REPLACE INTO memory_entity_scan (memory_id, scanned_at) VALUES (?, ?)`)
    .run(row.id, Date.now());
  return row.id;
}

function scratchTables(handle: DbHandle): string[] {
  return handle.raw
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE name LIKE '\\_%' ESCAPE '\\' AND name <> '_migrations'
         UNION ALL
         SELECT name FROM sqlite_temp_master WHERE name LIKE '\\_%' ESCAPE '\\'`,
    )
    .all()
    .map((r) => r.name);
}

/**
 * Global + project memories with embeddings and entity links, sessions and
 * prompts on the null-`project_id` axis, and both a finished and a live global
 * consolidation run. Returns the ids the assertions address.
 */
async function buildCorpus(): Promise<{
  alphaId: string;
  globalIds: string[];
  alphaIds: string[];
  census: Census;
  /** Rows carrying `scope = 'global'` before the migration — the population that had to move. */
  globalMemoryRows: number;
  vectorsBefore: Map<string, Buffer>;
}> {
  const handle = open();
  const alphaId = '01PROJECTALPHA';
  insertProject(handle, alphaId, 'alpha');
  handle.raw.exec(`
    INSERT INTO tokens (id, name, hash, scope, project_id, created_at)
      VALUES ('01TOKADMIN', 'admin', 's1$aa$bb', '*', NULL, 1000);
    INSERT INTO sessions (id, token_id, project_id, agent, started_at)
      VALUES ('01SESSNULL1', '01TOKADMIN', NULL, 'test', 1001),
             ('01SESSNULL2', '01TOKADMIN', NULL, 'test', 1002),
             ('01SESSALPHA', '01TOKADMIN', '01PROJECTALPHA', 'test', 1003);
    INSERT INTO prompts (id, session_id, project_id, content, title, created_at)
      VALUES ('01PROMPTNULL', '01SESSNULL1', NULL, 'a prompt', 'a prompt', 1004),
             ('01PROMPTALPHA', '01SESSALPHA', '01PROJECTALPHA', 'other', 'other', 1005);
    INSERT INTO consolidation_runs (id, started_at, finished_at, scope, summary)
      VALUES ('01RUNDONE', 1006, 1007, 'global', '{}');
    INSERT INTO consolidation_runs (id, started_at, finished_at, scope, summary)
      VALUES ('01RUNLIVE', 1008, NULL, 'global', NULL);
  `);

  const repos = createRepositories(handle.db);
  const memory = new MemoryService(repos, handle.db);
  const globalIds: string[] = [];
  for (let i = 0; i < GLOBAL_ROWS; i++) {
    const title = `Global memory ${i}`;
    const content = `previously global fact ${i} about src/global-${i}.ts and the deploy runbook`;
    globalIds.push(
      insertGlobalMemory(
        handle,
        {
          id: `01GLOBALMEMORY${String(i).padStart(6, '0')}`,
          type: 'reference',
          title,
          content,
          // Crosses `memory_topic_key_active_uidx`: the repointing changes these
          // rows' key under it, so a populated destination would collide.
          ...(i < 4 ? { topicKey: `topic-${i}` } : {}),
        },
        await embedder.embed(embeddingInput(title, content)),
      ),
    );
  }
  const alphaIds: string[] = [];
  for (let i = 0; i < ALPHA_ROWS; i++) {
    const m = memory.save(
      {
        type: 'reference',
        title: `Alpha memory ${i}`,
        content: `project-local fact ${i} about src/alpha-${i}.ts and the deploy runbook`,
        topicKey: i < 4 ? `topic-${i}` : undefined,
      },
      projectScope(alphaId),
    );
    alphaIds.push(m.id);
  }

  const embeddings = new EmbeddingWorker({ repos, embedder, batchSize: 100 });
  for (let i = 0; i < 10; i++) {
    const { processed } = await embeddings.processBatch({ force: true });
    if (processed === 0) break;
  }
  const entities = new EntityBackfillWorker({ repos, tx: handle.db, batchSize: 100 });
  for (let i = 0; i < 10; i++) {
    if (entities.processBatch({ force: true }).processed === 0) break;
  }

  const vectorsBefore = new Map(
    handle.raw
      .prepare<[], { memory_id: string; embedding: Buffer }>(
        `SELECT memory_id, embedding FROM memory_vec WHERE partition_key = '__global__'`,
      )
      .all()
      .map((r) => [r.memory_id, Buffer.from(r.embedding)]),
  );

  const snapshot = census(handle);
  const globalMemoryRows = scalar(
    handle,
    `SELECT count(*) AS v FROM memory WHERE scope = 'global'`,
  );
  handle.close();
  return { alphaId, globalIds, alphaIds, census: snapshot, globalMemoryRows, vectorsBefore };
}

beforeEach(() => {
  fx = createMigrationFixture(MIGRATION);
  embedder = new FakeEmbedder();
  fx.stagePrior();
});

afterEach(() => fx.cleanup());

describe('migration 0031 — the default project (correctness)', () => {
  it('conserves every counted table, repoints every global row, and leaves the DB consistent', async () => {
    const before = await buildCorpus();
    expect(before.census['memory']).toBe(GLOBAL_ROWS + ALPHA_ROWS);
    expect(before.vectorsBefore.size).toBe(GLOBAL_ROWS);
    // Non-vacuity: the population that had to move was itself ≥ 16 rows, which a
    // total over global + alpha cannot tell from zero global rows.
    expect(before.globalMemoryRows).toBeGreaterThanOrEqual(16);

    fx.stage();
    const handle = open();
    try {
      expect(census(handle)).toEqual(before.census);
      expect(CENSUS_TABLES).toContain('memory_vec');

      expect(scalar(handle, `SELECT count(*) AS v FROM memory WHERE scope = 'global'`)).toBe(0);
      expect(scalar(handle, `SELECT count(*) AS v FROM memory WHERE project_id IS NULL`)).toBe(0);

      const dflt = defaultProject(handle);
      expect(scalar(handle, `SELECT count(*) AS v FROM memory WHERE project_id = ?`, dflt.id)).toBe(
        before.globalMemoryRows,
      );
      expect(
        scalar(handle, `SELECT count(*) AS v FROM memory WHERE project_id = ?`, before.alphaId),
      ).toBe(ALPHA_ROWS);
      expect(scalar(handle, `SELECT count(*) AS v FROM projects`)).toBe(2);

      expect(scalar(handle, `SELECT count(*) AS v FROM sessions WHERE project_id IS NULL`)).toBe(0);
      expect(scalar(handle, `SELECT count(*) AS v FROM prompts WHERE project_id IS NULL`)).toBe(0);
      // Unbound `*` tokens are not a scope: 0029's CHECK depends on the null.
      expect(scalar(handle, `SELECT count(*) AS v FROM tokens WHERE project_id IS NULL`)).toBe(1);

      // The journal keeps what happened; only the live run is repointed, and it
      // carries the scope string every reader parses rather than a bare id.
      expect(
        one<{ scope: string }>(
          handle,
          `SELECT scope FROM consolidation_runs WHERE id = '01RUNDONE'`,
        ),
      ).toEqual({ scope: 'global' });
      expect(
        one<{ scope: string }>(
          handle,
          `SELECT scope FROM consolidation_runs WHERE id = '01RUNLIVE'`,
        ),
      ).toEqual({ scope: `project:${dflt.id}` });
      expect(
        createRepositories(handle.db).consolidation.recentRunExists(`project:${dflt.id}`, 0),
      ).toBe(true);

      expect(handle.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(one<{ integrity_check: string }>(handle, 'PRAGMA integrity_check')).toEqual({
        integrity_check: 'ok',
      });
      expect(scalar(handle, `SELECT count(*) AS v FROM projects WHERE is_default = 1`)).toBe(1);
      expect(dflt.display_name).toBe('Default');
      // The migration is the one place a project is created outside
      // `ProjectsService.create`; a slug it would refuse is existing-but-unmintable.
      expect(SLUG_REGEX.test(dflt.slug)).toBe(true);
      expect(scratchTables(handle)).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('is idempotent: re-executing the repointing statements creates no second default and moves nothing', async () => {
    await buildCorpus();
    fx.stage();
    const first = open();
    const dflt = defaultProject(first);
    const after = census(first);

    // The runner's own splitter, so the replay cannot disagree with it about
    // what a statement is. The two DDL statements are once-only by nature — the
    // control below proves it — so the replay starts at the third, which is
    // where the idempotency guard governs.
    const statements = splitStatements(fx.source());
    expect(() => first.raw.exec(statements[0]!)).toThrow(/duplicate column name/);

    let report = '';
    for (const stmt of statements.slice(2)) {
      if (/^-->\s*report:/m.test(stmt)) {
        report = first.raw.prepare(stmt).pluck().get() as string;
        continue;
      }
      first.raw.exec(stmt);
    }

    try {
      expect(scalar(first, `SELECT count(*) AS v FROM projects WHERE is_default = 1`)).toBe(1);
      expect(scalar(first, `SELECT count(*) AS v FROM projects`)).toBe(2);
      expect(defaultProject(first).id).toBe(dflt.id);
      expect(report).toBe(
        `repointed 0 previously-global memory row(s) into the default project ${dflt.slug}`,
      );
      expect(census(first)).toEqual(after);
    } finally {
      first.close();
    }
  });

  it('rejects a second default project at the database, not only in the migration', async () => {
    await buildCorpus();
    fx.stage();
    const handle = open();
    try {
      const dflt = defaultProject(handle);
      insertProject(handle, '01PROJECTGAMMA', 'gamma');
      expect(() =>
        handle.raw.prepare(`UPDATE projects SET is_default = 1 WHERE id = '01PROJECTGAMMA'`).run(),
      ).toThrow(/UNIQUE constraint failed/);
      expect(defaultProject(handle).id).toBe(dflt.id);
      expect(scalar(handle, `SELECT count(*) AS v FROM projects WHERE is_default = 1`)).toBe(1);
    } finally {
      handle.close();
    }
  });

  it('rolls the whole body back on a fault mid-body and applies in full on the next boot', async () => {
    const before = await buildCorpus();

    // Injected after the `memory` UPDATE and before the vec step, so rows have
    // already moved inside the transaction when it fires. The marker is asserted
    // present, or editing the body turns the substitution into a silent no-op
    // and the test passes having injected nothing.
    const marker = '\n--> statement-breakpoint\n--> progress: repointing the entity index';
    const body = fx.source();
    expect(body).toContain(marker);
    fx.stage(
      body.replace(
        marker,
        `\n--> statement-breakpoint\nINSERT INTO projects (id, slug, display_name, is_default, created_at) VALUES ('boom', 'boom', 'boom', 1, 1);${marker}`,
      ),
    );
    expect(() => open()).toThrow(/UNIQUE constraint failed/);

    // Unstaged so reopening cannot reattempt it: what follows is the state the
    // rolled-back transaction left behind.
    fx.unstage();
    const faulted = open();
    try {
      expect(census(faulted)).toEqual(before.census);
      expect(scalar(faulted, `SELECT count(*) AS v FROM memory WHERE scope = 'global'`)).toBe(
        before.globalMemoryRows,
      );
      // The rollback is total: even the ALTER that opened the body is gone.
      expect(
        faulted.raw
          .prepare<[], { name: string }>(`PRAGMA table_info(projects)`)
          .all()
          .map((c) => c.name),
      ).not.toContain('is_default');
      expect(
        scalar(faulted, `SELECT count(*) AS v FROM _migrations WHERE filename = ?`, MIGRATION),
      ).toBe(0);
      expect(scratchTables(faulted)).toEqual([]);
    } finally {
      faulted.close();
    }

    fx.stage();
    const retried = open();
    try {
      expect(census(retried)).toEqual(before.census);
      expect(
        scalar(retried, `SELECT count(*) AS v FROM _migrations WHERE filename = ?`, MIGRATION),
      ).toBe(1);
      expect(scalar(retried, `SELECT count(*) AS v FROM memory WHERE scope = 'global'`)).toBe(0);
      expect(scalar(retried, `SELECT count(*) AS v FROM projects WHERE is_default = 1`)).toBe(1);
      expect(scratchTables(retried)).toEqual([]);
    } finally {
      retried.close();
    }
  });

  it('probes for a free slug instead of guessing one, renaming nothing', () => {
    const pre = open();
    for (const [i, slug] of ['default', 'global', 'personal', 'default-2', 'default-3'].entries()) {
      insertProject(pre, `01PROJECTTAKEN${i}`, slug);
    }
    const existing = pre.raw
      .prepare(`SELECT id, slug, display_name, archived_at, created_at FROM projects ORDER BY id`)
      .all();
    pre.close();

    fx.stage();
    const handle = open();
    try {
      expect(defaultProject(handle).slug).toBe('default-4');
      expect(
        handle.raw
          .prepare(
            `SELECT id, slug, display_name, archived_at, created_at FROM projects WHERE is_default = 0 ORDER BY id`,
          )
          .all(),
      ).toEqual(existing);
      expect(scalar(handle, `SELECT count(*) AS v FROM projects WHERE is_default = 1`)).toBe(1);
      expect(scalar(handle, `SELECT count(DISTINCT slug) AS v FROM projects`)).toBe(6);
      expect(scalar(handle, `SELECT count(*) AS v FROM projects`)).toBe(6);
    } finally {
      handle.close();
    }
  });

  it('still mints a unique slug when every bounded candidate is taken', () => {
    const pre = open();
    const ins = pre.raw.prepare(
      `INSERT INTO projects (id, slug, display_name, archived_at, created_at) VALUES (?, ?, NULL, NULL, 1000)`,
    );
    // The probe's recursive CTE stops at 1000 candidates. Past the bound the
    // subquery is NULL and `projects.slug` is NOT NULL, so without the final
    // fallback the server never boots and says neither which slug nor why.
    pre.raw.transaction(() => {
      ins.run('p0000', 'default');
      for (let n = 2; n <= 1000; n++) ins.run(`p${String(n).padStart(4, '0')}`, `default-${n}`);
    })();
    pre.close();

    fx.stage();
    const handle = open();
    try {
      const dflt = defaultProject(handle);
      expect(SLUG_REGEX.test(dflt.slug)).toBe(true);
      expect(scalar(handle, `SELECT count(*) AS v FROM projects WHERE slug = ?`, dflt.slug)).toBe(
        1,
      );
      expect(scalar(handle, `SELECT count(*) AS v FROM projects WHERE is_default = 1`)).toBe(1);
      expect(scalar(handle, `SELECT count(DISTINCT slug) AS v FROM projects`)).toBe(1001);
    } finally {
      handle.close();
    }
  });

  it('creates the default project on an installation with nothing to repoint', () => {
    const pre = open();
    insertProject(pre, '01PROJECTALPHA', 'alpha');
    pre.close();

    fx.stage();
    const handle = open();
    try {
      expect(scalar(handle, `SELECT count(*) AS v FROM memory`)).toBe(0);
      const dflt = defaultProject(handle);
      expect(dflt.slug).toBe('default');
      expect(scalar(handle, `SELECT count(*) AS v FROM projects WHERE is_default = 1`)).toBe(1);
      // The resolution half of this scenario (a path-less `/mcp` resolving here)
      // lands with the resolver retargeting; what exists now is that the row is
      // addressable by the slug the report named.
      expect(
        one<{ id: string }>(handle, `SELECT id FROM projects WHERE slug = ?`, dflt.slug)?.id,
      ).toBe(dflt.id);
    } finally {
      handle.close();
    }
  });

  it('never adopts a pre-existing project slugged `default`, and leaves its memories alone', () => {
    const pre = open();
    insertProject(pre, '01PROJECTOWNED', 'default');
    const repos = createRepositories(pre.db);
    const memoryService = new MemoryService(repos, pre.db);
    for (let i = 0; i < 3; i++) {
      memoryService.save(
        {
          type: 'user',
          title: `Owned ${i}`,
          content: `the operator's own default project row ${i}`,
        },
        projectScope('01PROJECTOWNED'),
      );
    }
    for (let i = 0; i < 4; i++) {
      insertGlobalMemory(pre, {
        id: `01GLOBALOWNED${String(i).padStart(7, '0')}`,
        type: 'user',
        title: `Global ${i}`,
        content: `previously global row ${i}`,
      });
    }
    pre.close();

    fx.stage();
    const handle = open();
    try {
      const dflt = defaultProject(handle);
      expect(dflt.id).not.toBe('01PROJECTOWNED');
      expect(dflt.slug).toBe('default-2');
      expect(
        one<{ is_default: number }>(
          handle,
          `SELECT is_default FROM projects WHERE id = '01PROJECTOWNED'`,
        ),
      ).toEqual({ is_default: 0 });

      // Unchanged AND non-zero: "unchanged" over an empty project proves nothing.
      const owned = scalar(
        handle,
        `SELECT count(*) AS v FROM memory WHERE project_id = '01PROJECTOWNED'`,
      );
      expect(owned).toBe(3);
      expect(owned).toBeGreaterThan(0);
      expect(scalar(handle, `SELECT count(*) AS v FROM memory WHERE project_id = ?`, dflt.id)).toBe(
        4,
      );
      expect(scalar(handle, `SELECT count(*) AS v FROM memory WHERE scope = 'global'`)).toBe(0);
    } finally {
      handle.close();
    }
  });

  it('does not trip the data-loss guard, while a 60% deletion still refuses the boot', async () => {
    const before = await buildCorpus();
    const pre = open();
    // An old binary's marker: the counts as they were before the upgrade.
    writeStateMarker(fx.dataDir, {
      memory: before.census['memory']!,
      projects: 1,
      sessions: before.census['sessions']!,
      tokens: 1,
      prompts: before.census['prompts']!,
    });
    pre.close();

    fx.stage();
    const handle = open();
    try {
      const result = assertDataLossGuard({
        dataDir: fx.dataDir,
        diagnostics: createDiagnostics(handle),
        env: {},
        log: () => {},
      });
      expect(result.shrunkTables).toEqual([]);
      expect(result.current.memory).toBe(before.census['memory']);

      // FKs off for the control only: the guard counts rows, and the children
      // this leaves dangling are not what is under test.
      handle.raw.pragma('foreign_keys = OFF');
      handle.raw.prepare(`DELETE FROM memory WHERE id IN (SELECT id FROM memory LIMIT 13)`).run();
      handle.raw.pragma('foreign_keys = ON');
      expect(scalar(handle, `SELECT count(*) AS v FROM memory`)).toBe(
        before.census['memory']! - 13,
      );
      expect(() =>
        assertDataLossGuard({
          dataDir: fx.dataDir,
          diagnostics: createDiagnostics(handle),
          env: {},
          log: () => {},
        }),
      ).toThrow(DataLossGuardError);
    } finally {
      handle.close();
    }
  });
});

describe('migration 0031 — duplicate global entities', () => {
  /**
   * `memory_entities_identity_idx` is UNIQUE over PLAIN columns, so two global
   * rows sharing `(kind, value)` are DISTINCT before the migration
   * (`project_id IS NULL`) and a live collision after it. No shipped path
   * creates the pair, and a manual UPDATE or a restored snapshot can — and the
   * failure is unrecoverable, because the ledger row is never written so every
   * subsequent boot dies the same way.
   */
  function withDuplicate(): { memoryIds: string[]; entityValue: string } {
    const handle = open();
    const repos = createRepositories(handle.db);
    const memoryIds = [0, 1].map((i) =>
      insertGlobalMemory(handle, {
        id: `01GLOBALDUPLICATE${String(i).padStart(3, '0')}`,
        type: 'reference',
        title: `Global ${i}`,
        content: `a note about src/shared.ts, number ${i}`,
      }),
    );
    const entities = new EntityBackfillWorker({ repos, tx: handle.db, batchSize: 100 });
    for (let i = 0; i < 5; i++) {
      if (entities.processBatch({ force: true }).processed === 0) break;
    }
    const original = one<{ id: string; kind: string; value: string }>(
      handle,
      `SELECT id, kind, value FROM memory_entities WHERE value = 'src/shared.ts'`,
    );
    expect(original, 'the extractor did not produce the entity under test').toBeDefined();

    // Accepted only because `project_id IS NULL` makes the identity index blind
    // to it — the control the assertion below rests on.
    handle.raw
      .prepare(
        `INSERT INTO memory_entities (id, scope, project_id, kind, value, created_at) VALUES ('dupe', 'global', NULL, ?, ?, 1)`,
      )
      .run(original!.kind, original!.value);
    handle.raw
      .prepare(`UPDATE memory_entity_links SET entity_id = 'dupe' WHERE memory_id = ?`)
      .run(memoryIds[1]);
    expect(
      scalar(
        handle,
        `SELECT count(*) AS v FROM memory_entities WHERE scope = 'global' AND value = 'src/shared.ts'`,
      ),
    ).toBe(2);
    handle.close();
    return { memoryIds, entityValue: original!.value };
  }

  it('collapses them onto one row and keeps every link reachable', () => {
    const { memoryIds, entityValue } = withDuplicate();
    fx.stage();
    const handle = open();
    try {
      const dflt = defaultProject(handle);
      expect(
        scalar(handle, `SELECT count(*) AS v FROM memory_entities WHERE value = ?`, entityValue),
      ).toBe(1);
      expect(scalar(handle, `SELECT count(*) AS v FROM memory_entities WHERE id = 'dupe'`)).toBe(0);
      expect(handle.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      // Both memories are still reachable through the surviving entity — the
      // collapse must not cost a link.
      const hits = createRepositories(handle.db).entities.findMemoriesByEntity({
        scope: projectScope(dflt.id),
        value: entityValue,
        limit: 10,
      });
      expect(hits.map((m) => m.id).sort()).toEqual([...memoryIds].sort());
    } finally {
      handle.close();
    }
  });

  it('is what makes the boot survivable at all: without the collapse the repoint collides', () => {
    withDuplicate();
    // The dedupe removed, everything else verbatim: this is the mutation 12.x
    // would apply, taken here so the guard's necessity is pinned by a test
    // rather than by the comment above the statement.
    const body = fx.source();
    const dedupe = body.slice(
      body.indexOf('CREATE TEMP TABLE `_entity_dupes`'),
      body.indexOf('DROP TABLE `_entity_dupes`;') + 'DROP TABLE `_entity_dupes`;'.length,
    );
    expect(dedupe).toContain('_entity_dupes');
    fx.stage(body.replace(dedupe, 'SELECT 1;'));
    expect(() => open()).toThrow(/UNIQUE constraint failed: memory_entities/);
  });
});

describe('migration 0031 — the dense index survives repartitioning', () => {
  it('carries every ex-global blob across byte-identically and at cosine distance 0', async () => {
    const before = await buildCorpus();
    fx.stage();
    const handle = open();
    try {
      const dflt = defaultProject(handle);
      expect(before.vectorsBefore.size).toBeGreaterThan(0);
      for (const [memoryId, expected] of before.vectorsBefore) {
        const row = one<{ embedding: Buffer; partition_key: string }>(
          handle,
          `SELECT embedding, partition_key FROM memory_vec WHERE memory_id = ?`,
          memoryId,
        );
        expect(row, `vector for ${memoryId} disappeared`).toBeDefined();
        expect(Buffer.compare(expected, Buffer.from(row!.embedding))).toBe(0);
        expect(row!.partition_key).toBe(dflt.id);
        expect(
          one<{ d: number }>(
            handle,
            `SELECT vec_distance_cosine(?, embedding) AS d FROM memory_vec WHERE memory_id = ?`,
            expected,
            memoryId,
          )?.d,
        ).toBe(0);
      }
    } finally {
      handle.close();
    }
  });

  it('leaves no vector at a partition key that is not a project id', async () => {
    await buildCorpus();
    fx.stage();
    const handle = open();
    try {
      expect(
        scalar(
          handle,
          `SELECT count(*) AS v FROM memory_vec WHERE partition_key NOT IN (SELECT id FROM projects)`,
        ),
      ).toBe(0);
      // Non-vacuity control: the same comparison over an empty table is free.
      expect(scalar(handle, `SELECT count(*) AS v FROM memory_vec`)).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  it('answers a dense kNN in the default partition, and in a pre-existing project as control', async () => {
    const before = await buildCorpus();
    fx.stage();
    const handle = open();
    try {
      const repos = createRepositories(handle.db);
      const dflt = defaultProject(handle);
      const queryVector = await embedder.embed('anything');
      expect(
        repos.vectors.knnByQueryVector({
          queryVector,
          partitionKeys: [dflt.id],
          status: 'active',
          rankWindowSize: 10,
        }).length,
      ).toBeGreaterThan(0);
      expect(
        repos.vectors.knnByQueryVector({
          queryVector,
          partitionKeys: [before.alphaId],
          status: 'active',
          rankWindowSize: 10,
        }).length,
      ).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  it('recalls a repointed memory through the search entry point on the dense branch alone', async () => {
    const before = await buildCorpus();
    fx.stage();
    const handle = open();
    try {
      const repos = createRepositories(handle.db);
      const dflt = defaultProject(handle);
      const target = [...before.vectorsBefore.keys()][3]!;
      const targetVector = decodeEmbedding(before.vectorsBefore.get(target)!);

      // A control native to the destination, saved after the migration, so a
      // green test cannot be a fixture where nothing was repointed.
      const control = new MemoryService(repos, handle.db).save(
        {
          type: 'user',
          title: 'Native control',
          content: 'saved into the default project after the upgrade',
        },
        projectScope(dflt.id),
      );
      await new EmbeddingWorker({ repos, embedder, batchSize: 10 }).processBatch({ force: true });
      const controlVector = decodeEmbedding(
        one<{ embedding: Buffer }>(
          handle,
          `SELECT embedding FROM memory_vec WHERE memory_id = ?`,
          control.id,
        )!.embedding,
      );

      // The query text matches nothing lexically, so the dense branch is the
      // only one that can return either row.
      const found = async (vector: Float32Array): Promise<string[]> => {
        const service = new MemoryService(repos, handle.db, undefined, () =>
          Promise.resolve(vector),
        );
        const out = await service.searchWithAbstention(
          { query: 'zqxjv unmatched token' },
          projectScope(dflt.id),
        );
        return out.memories.map((m) => m.id);
      };
      expect(await found(targetVector)).toContain(target);
      expect(await found(controlVector)).toContain(control.id);
      expect(
        scalar(
          handle,
          `SELECT count(*) AS v FROM memory WHERE id = ? AND project_id = ?`,
          target,
          dflt.id,
        ),
      ).toBe(1);
    } finally {
      handle.close();
    }
  });
});

describe('migration 0031 — derived state after the repointing', () => {
  it('drains both backlogs to zero and keeps the entity scan covering every memory', async () => {
    const before = await buildCorpus();
    fx.stage();
    const handle = open();
    try {
      // The anti-join behind `embeddings.backlog` detects an ABSENT vec row,
      // never a wrongly-partitioned one — necessary, and on its own not
      // sufficient, which is why the partition assertions above exist.
      const report = doctorReport(handle, fx.dataDir);
      expect(report.embeddings.backlog).toBe(0);
      expect(report.entities.backlog).toBe(0);
      expect(scalar(handle, `SELECT count(*) AS v FROM memory_entity_scan`)).toBe(
        before.census['memory'],
      );
      expect(scalar(handle, `SELECT count(*) AS v FROM memory`)).toBe(before.census['memory']);
      expect(
        scalar(handle, `SELECT count(*) AS v FROM memory_entities WHERE scope = 'global'`),
      ).toBe(0);
      expect(
        scalar(
          handle,
          `SELECT count(*) AS v FROM memory_entities WHERE project_id = ?`,
          defaultProject(handle).id,
        ),
      ).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  it('returns the repointed memories from an entity lookup in the default project', async () => {
    const before = await buildCorpus();
    fx.stage();
    const handle = open();
    try {
      const repos = createRepositories(handle.db);
      const dflt = defaultProject(handle);
      const hits = repos.entities.findMemoriesByEntity({
        scope: projectScope(dflt.id),
        value: 'src/global-3.ts',
        limit: 10,
      });
      expect(hits.map((m) => m.id)).toEqual([before.globalIds[3]]);
      // Still closed: the pre-existing project's own path is not reachable here.
      expect(
        repos.entities.findMemoriesByEntity({
          scope: projectScope(dflt.id),
          value: 'src/alpha-1.ts',
          limit: 10,
        }),
      ).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('needs no FTS action, measured by hit count rather than by comparing external content', async () => {
    const before = await buildCorpus();
    const pre = open();
    const hitsBefore = ftsHits(pre, 'runbook');
    pre.close();
    expect(hitsBefore).toBe(GLOBAL_ROWS + ALPHA_ROWS);

    fx.stage();
    const handle = open();
    try {
      expect(ftsHits(handle, 'runbook')).toBe(hitsBefore);
      expect(scalar(handle, `SELECT count(*) AS v FROM memory_fts`)).toBe(
        before.census['memory_fts'],
      );
    } finally {
      handle.close();
    }
  });
});

describe('migration 0031 — progress output', () => {
  it('emits each line before the statement it announces, inside the transaction', async () => {
    await buildCorpus();
    fx.stage();

    const raw = new Database(join(fx.dataDir, 'data.db'));
    sqliteVec.load(raw);
    raw.pragma('foreign_keys = ON');
    const count = (sql: string): number =>
      raw.prepare<[], { v: number }>(`SELECT count(*) AS v FROM ${sql}`).get()?.v ?? 0;
    const events: {
      line: string;
      inTransaction: boolean;
      hasColumn: boolean;
      globalMemory: number;
      globalEntities: number;
      stashExists: number;
      globalVec: number;
    }[] = [];
    try {
      const result = migrate(raw, {
        migrationsDir: fx.migrationsDir,
        onProgress: (line) => {
          events.push({
            line,
            inTransaction: raw.inTransaction,
            hasColumn: raw
              .prepare<[], { name: string }>(`PRAGMA table_info(projects)`)
              .all()
              .some((c) => c.name === 'is_default'),
            globalMemory: count(`memory WHERE scope = 'global'`),
            globalEntities: count(`memory_entities WHERE scope = 'global'`),
            stashExists: count(`sqlite_temp_master WHERE name = '_vec_repartition'`),
            globalVec: count(`memory_vec WHERE partition_key = '__global__'`),
          });
        },
      });

      expect(events.map((e) => e.line)).toEqual([
        `applying ${MIGRATION}`,
        'repointing the entity index',
        'repartitioning the dense vector index (the largest step: 73% of this migration at scale)',
        'checking foreign keys',
        'committing',
        `repointed ${GLOBAL_ROWS} previously-global memory row(s) into the default project default`,
      ]);
      // Ordering, not presence, and each line probed against the statement it
      // announces rather than against the body as a whole: emitting any of them
      // one statement EARLIER or one statement LATER changes one of these reads.
      expect(events[0]!.hasColumn).toBe(false);
      expect(events[0]!.inTransaction).toBe(false);
      expect(events[1]!.inTransaction).toBe(true);
      expect(events[1]!.globalMemory).toBe(0);
      expect(events[1]!.globalEntities).toBeGreaterThan(0);
      expect(events[2]!.inTransaction).toBe(true);
      expect(events[2]!.globalEntities).toBe(0);
      expect(events[2]!.stashExists).toBe(0);
      expect(events[2]!.globalVec).toBe(GLOBAL_ROWS);
      expect(events[3]!.inTransaction).toBe(true);
      expect(events[3]!.globalVec).toBe(0);
      expect(events[3]!.stashExists).toBe(0);
      // A report is post-hoc by definition: the transaction the FK gate could
      // still have vetoed is closed by the time it is emitted.
      expect(events[5]!.inTransaction).toBe(false);
      expect(result.applied).toContain(MIGRATION);
    } finally {
      raw.close();
    }
  });

  it('withholds the report when the transaction it summarises is rolled back', async () => {
    await buildCorpus();
    // A dangling FK the runner's own pre-commit gate must veto, appended AFTER
    // the report statement — so the report has already read as done. A summary
    // of work that was then discarded is worse than no summary.
    fx.stage(
      `${fx.source()}\n--> statement-breakpoint\nINSERT INTO sessions (id, token_id, project_id, agent, started_at) VALUES ('sX', 'no-such-token', NULL, 'x', 1);\n`,
    );
    const emitted: string[] = [];
    expect(() => open((line) => emitted.push(line))).toThrow(/foreign key violations/);
    expect(emitted).not.toContain(
      `repointed ${GLOBAL_ROWS} previously-global memory row(s) into the default project default`,
    );
    expect(emitted.some((l) => l.startsWith('repointed '))).toBe(false);
    // Control: the progress lines are in-transaction by design and DID arrive.
    expect(emitted).toContain('repointing the entity index');
  });

  it('refuses a report statement that reads as nothing rather than dropping it', async () => {
    await buildCorpus();
    fx.stage(
      fx
        .source()
        .replace(
          /--> report:\n[\s\S]*?;\n/,
          "--> report:\nSELECT slug FROM `projects` WHERE `slug` = 'no-such-project';\n",
        ),
    );
    expect(() => open()).toThrow(/'--> report:' statement returning no rows/);
  });

  it('restores the temp-storage pragmas it changed, so nothing after the migration sees them', async () => {
    await buildCorpus();
    fx.stage();

    const raw = new Database(join(fx.dataDir, 'data.db'));
    sqliteVec.load(raw);
    raw.pragma('foreign_keys = ON');
    // What `db/client.ts` pins process-wide, and what the migration must hand back.
    raw.pragma('temp_store = MEMORY');
    const before = {
      store: raw.pragma('temp_store', { simple: true }),
      dir: raw.pragma('temp_store_directory', { simple: true }),
    };
    let inside: { store: unknown; dir: unknown } | null = null;
    try {
      migrate(raw, {
        migrationsDir: fx.migrationsDir,
        onProgress: (line) => {
          if (line !== 'committing') return;
          inside = {
            store: raw.pragma('temp_store', { simple: true }),
            dir: raw.pragma('temp_store_directory', { simple: true }),
          };
        },
      });

      // `sqlite3_temp_directory` is a process-global, so leaving it set would
      // redirect every other connection's spill too.
      expect(inside).not.toBeNull();
      expect(inside!.store).toBe(1); // FILE, while the body runs
      expect(inside!.dir).toBe(fx.dataDir);
      expect(raw.pragma('temp_store', { simple: true })).toBe(before.store);
      expect(raw.pragma('temp_store_directory', { simple: true })).toBe(before.dir);
    } finally {
      raw.close();
    }
  });

  it('writes those lines to stderr by default and repeats none of them on the next boot', async () => {
    await buildCorpus();
    fx.stage();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const first = createDb({ dataDir: fx.dataDir, migrationsDir: fx.migrationsDir });
      const lines = spy.mock.calls.map((c) => String(c[0]));
      first.close();
      expect(lines).toContain(`[migrate] applying ${MIGRATION}`);
      expect(
        lines.some((l) => l.startsWith('[migrate] repartitioning the dense vector index')),
      ).toBe(true);
      expect(lines).toContain(
        `[migrate] repointed ${GLOBAL_ROWS} previously-global memory row(s) into the default project default`,
      );

      spy.mockClear();
      const second = createDb({ dataDir: fx.dataDir, migrationsDir: fx.migrationsDir });
      try {
        expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([]);
      } finally {
        second.close();
      }
    } finally {
      spy.mockRestore();
    }
  });
});

function ftsHits(handle: DbHandle, term: string): number {
  return (
    handle.raw
      .prepare<
        [string],
        { v: number }
      >(`SELECT count(*) AS v FROM memory m JOIN memory_fts f ON f.rowid = m.rowid WHERE memory_fts MATCH ?`)
      .get(term)?.v ?? 0
  );
}
