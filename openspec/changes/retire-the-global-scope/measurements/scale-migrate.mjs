/**
 * The `retire-the-global-scope` migration, measured at scale.
 *
 * Usage (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/retire-the-global-scope/measurements/scale-migrate.mjs \
 *     --fixture <fixtureDir> --variant <set|loop|rebuild|id-is-partition|insert-first|runner|boot> [--work <dir>] [--json <path>]
 *
 * Three instruments, never mixed in one series (CLAUDE.md, "one instrument per
 * series, named"):
 *
 *   I1  BODY-ISOLATED — this file's default. Replicates `db/migrate.ts`'s
 *       envelope in-process (`PRAGMA foreign_keys = OFF` → `BEGIN IMMEDIATE` →
 *       statements → `PRAGMA foreign_key_check` → `COMMIT` →
 *       `PRAGMA foreign_keys = ON`) so each statement group can be timed
 *       separately. It is NOT a boot.
 *   I2  RUNNER-WHOLE-BODY (`--variant runner`) — the real `migrate()` over a
 *       real `.sql` file. One number, no breakdown; the control that I1's
 *       envelope replication is faithful.
 *   I3  FULL-BOOT (`--variant boot`) — the real `createDb()`: pragmas,
 *       `migrate()`, `ANALYZE`, query-tokenizer tables. This is the number an
 *       operator actually waits on.
 *
 * Every run asserts correctness, and every comparison asserts a NON-EMPTY count
 * on both sides — an "unchanged" or "identical" claim over two empty sets proves
 * nothing (CLAUDE.md).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
// This directory is outside every workspace package, so the driver has to be
// resolved from the one that declares it.
const serverRequire = createRequire(join(REPO, 'apps', 'server', 'package.json'));
const Database = serverRequire('better-sqlite3');
const sqliteVec = serverRequire('sqlite-vec');
const REAL_MIGRATIONS = join(REPO, 'apps', 'server', 'src', 'db', 'migrations');
const BODY_SQL = join(HERE, 'scale-migration-body.sql');
const GLOBAL_PARTITION = '__global__';
/** Blob-identity sample size. Fixed, so the cost of the check does not scale. */
const BLOB_SAMPLE = 64;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}

const fixture = arg('fixture');
const variant = arg('variant', 'set');
if (!fixture) throw new Error('--fixture is required');

const work = arg('work', mkdtempSync(join(tmpdir(), 'scale-migrate-')));
if (existsSync(work)) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
cpSync(fixture, work, { recursive: true });

const dbPath = join(work, 'data.db');
const walPath = `${dbPath}-wal`;
const sizeOf = (p) => (existsSync(p) ? statSync(p).size : 0);

/** Applied to every connection this probe opens, mirroring `db/client.ts`. */
function openLikeClient(path, { readonly = false } = {}) {
  const db = new Database(path, readonly ? { readonly: true } : undefined);
  sqliteVec.load(db);
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -65536');
  db.pragma('mmap_size = 268435456');
  db.pragma('temp_store = MEMORY');
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

const count = (db, table, where = '') =>
  db.prepare(`SELECT count(*) c FROM ${table} ${where ? `WHERE ${where}` : ''}`).get().c;

function snapshot(db) {
  return {
    memory: count(db, 'memory'),
    memoryGlobal: count(db, 'memory', "scope='global'"),
    memoryProject: count(db, 'memory', "scope='project'"),
    memoryInControlProjects: count(
      db,
      'memory',
      "project_id IN (SELECT id FROM projects WHERE slug LIKE 'pre-existing-%')",
    ),
    memory_vec: count(db, 'memory_vec'),
    memory_vec_global: count(db, 'memory_vec', `partition_key='${GLOBAL_PARTITION}'`),
    memory_fts: count(db, 'memory_fts'),
    memory_entities: count(db, 'memory_entities'),
    memory_entities_global: count(db, 'memory_entities', "scope='global'"),
    memory_entity_links: count(db, 'memory_entity_links'),
    memory_relations: count(db, 'memory_relations'),
    confirmations: count(db, 'confirmations'),
    sessions: count(db, 'sessions'),
    sessions_null_project: count(db, 'sessions', 'project_id IS NULL'),
    projects: count(db, 'projects'),
    consolidation_runs: count(db, 'consolidation_runs'),
    consolidation_runs_global: count(db, 'consolidation_runs', "scope='global'"),
  };
}

/** Sample the ex-global vectors so blob survival is checked at scale, not at 16 rows. */
function sampleBlobs(db) {
  const ids = db
    .prepare(`SELECT memory_id FROM memory_vec WHERE partition_key = ? ORDER BY memory_id`)
    .all(GLOBAL_PARTITION)
    .map((r) => r.memory_id);
  const stride = Math.max(1, Math.floor(ids.length / BLOB_SAMPLE));
  const picked = [];
  for (let i = 0; i < ids.length && picked.length < BLOB_SAMPLE; i += stride) picked.push(ids[i]);
  const stmt = db.prepare('SELECT embedding FROM memory_vec WHERE memory_id = ?');
  return picked.map((id) => ({ id, blob: Buffer.from(stmt.get(id).embedding) }));
}

const before = (() => {
  const db = openLikeClient(dbPath, { readonly: true });
  const snap = snapshot(db);
  const blobs = sampleBlobs(db);
  const controlProjectIds = db
    .prepare("SELECT id FROM projects WHERE slug LIKE 'pre-existing-%'")
    .all()
    .map((r) => r.id);
  db.close();
  return { snap, blobs, controlProjectIds };
})();

const statements = readFileSync(BODY_SQL, 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(
    (s) =>
      s.length > 0 && !s.split('\n').every((l) => l.trim() === '' || l.trim().startsWith('--')),
  );

/** Statement-group label, so the breakdown names what it timed. */
function labelOf(sql) {
  const s = sql
    .replace(/^--.*$/gm, '')
    .trim()
    .replace(/\s+/g, ' ');
  if (/^ALTER TABLE/i.test(s)) return 'alter-projects-is_default';
  if (/^INSERT INTO `projects`/i.test(s)) return 'insert-default-project';
  if (/^UPDATE `memory`/i.test(s)) return 'update-memory';
  if (/^UPDATE `memory_entities`/i.test(s)) return 'update-memory_entities';
  if (/^UPDATE `sessions`/i.test(s)) return 'update-sessions';
  if (/^UPDATE `prompts`/i.test(s)) return 'update-prompts';
  if (/^UPDATE `consolidation_runs`/i.test(s)) return 'update-consolidation_runs';
  if (/^CREATE TABLE `_vec_repartition`/i.test(s)) return 'vec-create-stash';
  if (/^INSERT INTO `_vec_repartition`/i.test(s)) return 'vec-fill-stash';
  if (/^DELETE FROM `memory_vec`/i.test(s)) return 'vec-delete-global';
  if (/^INSERT INTO `memory_vec`/i.test(s)) return 'vec-insert-repointed';
  if (/^DROP TABLE `_vec_repartition`/i.test(s)) return 'vec-drop-stash';
  return s.slice(0, 40);
}

const VEC_LABELS = new Set([
  'vec-create-stash',
  'vec-fill-stash',
  'vec-delete-global',
  'vec-insert-repointed',
  'vec-drop-stash',
]);

/**
 * WAL high-water mark. No sampler is needed and an in-process one would report
 * nothing anyway (better-sqlite3 is synchronous, so a `setInterval` cannot fire
 * while the body holds the event loop). Two facts make a single post-COMMIT stat
 * exact: no checkpoint can run inside an open write transaction, so the WAL only
 * grows during the body; and a checkpoint never shrinks the file (only
 * `wal_checkpoint(TRUNCATE)` does, and nothing on this path calls it). The
 * measurement therefore has to happen BEFORE any `close()` — better-sqlite3's
 * close checkpoints and unlinks the WAL.
 */
let result;

if (variant === 'boot' || variant === 'runner') {
  const stagedMigrations = mkdtempSync(join(tmpdir(), 'scale-migrations-'));
  for (const f of readdirSync(REAL_MIGRATIONS)) {
    if (f.endsWith('.sql')) cpSync(join(REAL_MIGRATIONS, f), join(stagedMigrations, f));
  }
  cpSync(BODY_SQL, join(stagedMigrations, '0031_retire_global_scope.sql'));

  let elapsedMs;
  let walHigh = 0;
  if (variant === 'boot') {
    const { createDb } = await import(join(REPO, 'apps/server/src/db/index.ts'));
    const t = process.hrtime.bigint();
    const handle = createDb({ dataDir: work, migrationsDir: stagedMigrations });
    elapsedMs = Number(process.hrtime.bigint() - t) / 1e6;
    walHigh = sizeOf(walPath);
    handle.close();
  } else {
    const { migrate } = await import(join(REPO, 'apps/server/src/db/migrate.ts'));
    const db = openLikeClient(dbPath);
    const t = process.hrtime.bigint();
    const r = migrate(db, { migrationsDir: stagedMigrations });
    elapsedMs = Number(process.hrtime.bigint() - t) / 1e6;
    walHigh = sizeOf(walPath);
    if (!r.applied.includes('0031_retire_global_scope.sql')) {
      throw new Error(`runner did not apply the migration: ${JSON.stringify(r)}`);
    }
    db.close();
  }
  const walPeak = walHigh;
  rmSync(stagedMigrations, { recursive: true, force: true });
  result = { totalMs: elapsedMs, statements: [], groups: {}, walPeakBytes: walPeak };
} else {
  const db = openLikeClient(dbPath);
  const timings = [];

  const fkWasOn = db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1;
  if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
  const tTotal = process.hrtime.bigint();
  try {
    db.exec('BEGIN IMMEDIATE');

    for (const stmt of statements) {
      const label = labelOf(stmt);
      if (VEC_LABELS.has(label) && variant !== 'set') continue;
      // Variant E: give the default project the literal id `__global__`, which
      // is what `partitionKeyFor` already writes for every ex-global vector — so
      // `memory_vec` needs no statement at all. Everything downstream still
      // reads `(SELECT id FROM projects WHERE is_default = 1)`.
      const sql =
        variant === 'id-is-partition' && label === 'insert-default-project'
          ? `INSERT INTO \`projects\` (\`id\`, \`slug\`, \`display_name\`, \`is_default\`, \`created_at\`)
             SELECT '${GLOBAL_PARTITION}',
                    (WITH RECURSIVE cand(n, slug) AS (
                        SELECT 1, 'default'
                        UNION ALL SELECT n + 1, 'default-' || (n + 1) FROM cand WHERE n < 1000
                     ) SELECT slug FROM cand WHERE slug NOT IN (SELECT slug FROM \`projects\`) LIMIT 1),
                    'Default', 1, unixepoch('subsec') * 1000
              WHERE NOT EXISTS (SELECT 1 FROM \`projects\` WHERE \`is_default\` = 1)`
          : stmt;
      const t = process.hrtime.bigint();
      db.exec(sql);
      timings.push({ label, ms: Number(process.hrtime.bigint() - t) / 1e6 });
    }

    const newProjectId = db.prepare('SELECT id FROM projects WHERE is_default = 1').get().id;

    if (variant === 'loop') {
      // Variant A: DELETE + re-INSERT one row at a time, as design.md's step 9
      // reads literally. Not expressible in a `.sql` migration file.
      const t0 = process.hrtime.bigint();
      const ids = db
        .prepare(
          'SELECT memory_id, status, type, embedding FROM memory_vec WHERE partition_key = ?',
        )
        .all(GLOBAL_PARTITION);
      timings.push({
        label: 'loop-read-global-rows',
        ms: Number(process.hrtime.bigint() - t0) / 1e6,
      });
      const del = db.prepare('DELETE FROM memory_vec WHERE memory_id = ?');
      const ins = db.prepare(
        'INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) VALUES (?, ?, ?, ?, ?)',
      );
      const t1 = process.hrtime.bigint();
      for (const r of ids) {
        del.run(r.memory_id);
        ins.run(r.memory_id, newProjectId, r.status, r.type, r.embedding);
      }
      timings.push({ label: 'loop-delete-insert', ms: Number(process.hrtime.bigint() - t1) / 1e6 });
    } else if (variant === 'insert-first') {
      // Variant C: skip the stash entirely — re-INSERT at the new partition
      // while the old row is still there, then DELETE. Only viable if vec0 does
      // not enforce memory_id uniqueness across partitions.
      const t = process.hrtime.bigint();
      db.exec(
        `INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding)
         SELECT memory_id, '${newProjectId}', status, type, embedding
           FROM memory_vec WHERE partition_key = '${GLOBAL_PARTITION}'`,
      );
      timings.push({ label: 'insert-first-copy', ms: Number(process.hrtime.bigint() - t) / 1e6 });
      const t2 = process.hrtime.bigint();
      db.exec(`DELETE FROM memory_vec WHERE partition_key = '${GLOBAL_PARTITION}'`);
      timings.push({
        label: 'insert-first-delete',
        ms: Number(process.hrtime.bigint() - t2) / 1e6,
      });
    } else if (variant === 'rebuild') {
      // Variant D: the recipe migration 0014 already used — stash EVERY vector,
      // DROP the vtable, recreate it, reinsert with the global partition key
      // remapped. Touches 10% more rows than the targeted forms but never asks
      // vec0 to delete from a populated partition, which is where the targeted
      // forms spend most of their time.
      const step = (label, sql) => {
        const t = process.hrtime.bigint();
        db.exec(sql);
        timings.push({ label, ms: Number(process.hrtime.bigint() - t) / 1e6 });
      };
      step(
        'rebuild-create-stash',
        `CREATE TABLE _vec_rebuild (
           memory_id TEXT PRIMARY KEY, partition_key TEXT NOT NULL,
           status TEXT NOT NULL, type TEXT NOT NULL, embedding BLOB NOT NULL)`,
      );
      step(
        'rebuild-fill-stash',
        `INSERT INTO _vec_rebuild (memory_id, partition_key, status, type, embedding)
         SELECT memory_id,
                CASE WHEN partition_key = '${GLOBAL_PARTITION}' THEN '${newProjectId}' ELSE partition_key END,
                status, type, embedding
           FROM memory_vec`,
      );
      step('rebuild-drop-vtable', 'DROP TABLE memory_vec');
      // Declaration copied verbatim from 0014_hybrid_search_vec_rebuild.sql.
      step(
        'rebuild-create-vtable',
        `CREATE VIRTUAL TABLE \`memory_vec\` USING vec0(
            memory_id TEXT PRIMARY KEY,
            partition_key TEXT partition key,
            status TEXT,
            type TEXT,
            embedding FLOAT[768]
        )`,
      );
      step(
        'rebuild-reinsert',
        `INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding)
         SELECT memory_id, partition_key, status, type, embedding FROM _vec_rebuild`,
      );
      step('rebuild-drop-stash', 'DROP TABLE _vec_rebuild');
    }

    const tFk = process.hrtime.bigint();
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    timings.push({ label: 'foreign_key_check', ms: Number(process.hrtime.bigint() - tFk) / 1e6 });
    if (violations.length > 0) throw new Error(`FK violations: ${JSON.stringify(violations)}`);

    const tCommit = process.hrtime.bigint();
    db.exec('COMMIT');
    timings.push({ label: 'COMMIT', ms: Number(process.hrtime.bigint() - tCommit) / 1e6 });
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    db.close();
    const failure = { fixture, variant, failed: true, error: String(err), timings };
    const jp = arg('json');
    if (jp) writeFileSync(jp, `${JSON.stringify(failure, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exit(2);
  }
  const totalMs = Number(process.hrtime.bigint() - tTotal) / 1e6;
  const walPeak = sizeOf(walPath);
  if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
  db.close();

  const groups = {};
  for (const t of timings) groups[t.label] = (groups[t.label] ?? 0) + t.ms;
  result = { totalMs, statements: timings, groups, walPeakBytes: walPeak };
}

const dbSizeAfterBody = sizeOf(dbPath);
const walSizeAfterClose = sizeOf(walPath);

const db = openLikeClient(dbPath);
const after = snapshot(db);
const newProject = db
  .prepare('SELECT id, slug, display_name FROM projects WHERE is_default = 1')
  .get();
const defaultCount = count(db, 'projects', 'is_default = 1');
const vecOrphanPartitions = db
  .prepare('SELECT count(*) c FROM memory_vec WHERE partition_key NOT IN (SELECT id FROM projects)')
  .get().c;
const vecAtDefaultPartition = count(db, 'memory_vec', `partition_key = '${newProject.id}'`);
const pages = {
  pageSize: db.pragma('page_size', { simple: true }),
  pageCount: db.pragma('page_count', { simple: true }),
  freelistCount: db.pragma('freelist_count', { simple: true }),
};

const blobStmt = db.prepare('SELECT embedding, partition_key FROM memory_vec WHERE memory_id = ?');
const cosStmt = db.prepare(
  'SELECT vec_distance_cosine(?, embedding) d FROM memory_vec WHERE memory_id = ?',
);
let blobsChecked = 0;
let blobBytesIdentical = 0;
let blobCosineZero = 0;
let blobInNewPartition = 0;
for (const s of before.blobs) {
  const row = blobStmt.get(s.id);
  if (!row) continue;
  blobsChecked += 1;
  if (Buffer.from(row.embedding).equals(s.blob)) blobBytesIdentical += 1;
  if (row.partition_key === newProject.id) blobInNewPartition += 1;
  if (cosStmt.get(s.blob, s.id).d === 0) blobCosineZero += 1;
}

const integrity = db
  .prepare('PRAGMA integrity_check')
  .all()
  .map((r) => r.integrity_check);
let ftsIntegrity = 'ok';
try {
  db.exec("INSERT INTO memory_fts(memory_fts) VALUES('integrity-check')");
} catch (err) {
  ftsIntegrity = String(err);
}
const fkAfter = db.prepare('PRAGMA foreign_key_check').all();

// Dense kNN inside the NEW partition, plus the control kNN inside a
// pre-existing project's partition that must also return rows.
const qv = Buffer.from(blobStmt.get(before.blobs[0].id).embedding);
const knn = db
  .prepare(
    `SELECT memory_id AS id, distance FROM memory_vec
      WHERE embedding MATCH ? AND k = 10 AND partition_key = ? AND status = 'active'
      ORDER BY distance`,
  )
  .all(qv, newProject.id);
const controlPartition = before.controlProjectIds[0];
const controlProbe = db
  .prepare('SELECT embedding FROM memory_vec WHERE partition_key = ? LIMIT 1')
  .get(controlPartition);
const controlKnn = controlProbe
  ? db
      .prepare(
        `SELECT memory_id AS id, distance FROM memory_vec
          WHERE embedding MATCH ? AND k = 10 AND partition_key = ? AND status = 'active'
          ORDER BY distance`,
      )
      .all(Buffer.from(controlProbe.embedding), controlPartition)
  : [];

// Is the file growth the body leaves behind recoverable? `/dashboard/maintenance`
// exposes VACUUM, so an operator has a remedy — but only if it reclaims.
let vacuum = null;
if (process.argv.includes('--vacuum')) {
  const t = process.hrtime.bigint();
  db.exec('VACUUM');
  vacuum = {
    ms: Number(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1),
    bytesAfter: sizeOf(dbPath),
  };
}
db.close();

const assertions = [
  ['memory total conserved', after.memory === before.snap.memory],
  ['memory total non-zero', after.memory > 0],
  ['zero rows at scope=global', after.memoryGlobal === 0],
  ['global population was non-zero before', before.snap.memoryGlobal > 0],
  [
    'every ex-global row now points at the new default project',
    after.memoryProject === before.snap.memory,
  ],
  [
    'control population (pre-existing projects) unchanged',
    after.memoryInControlProjects === before.snap.memoryInControlProjects,
  ],
  ['control population non-zero', after.memoryInControlProjects > 0],
  ['memory_vec total conserved', after.memory_vec === before.snap.memory_vec],
  ['memory_vec total non-zero', after.memory_vec > 0],
  // Variant E makes `__global__` the default project's real id, so the global
  // sentinel partition is SUPPOSED to stay populated. The property that has to
  // hold in every variant is the weaker one: no vector sits at a partition key
  // that is not a live project id.
  variant === 'id-is-partition'
    ? ['every vector sits at a live project id', vecOrphanPartitions === 0]
    : ['memory_vec global partition empty', after.memory_vec_global === 0],
  ['memory_vec global partition was non-empty before', before.snap.memory_vec_global > 0],
  ['no vector at a partition key that is not a project id', vecOrphanPartitions === 0],
  [
    'every ex-global vector now sits at the default project partition',
    vecAtDefaultPartition === before.snap.memory_vec_global,
  ],
  ['memory_fts total conserved', after.memory_fts === before.snap.memory_fts],
  ['memory_fts total non-zero', after.memory_fts > 0],
  ['memory_entities total conserved', after.memory_entities === before.snap.memory_entities],
  ['memory_entities zero at scope=global', after.memory_entities_global === 0],
  ['memory_entities global was non-zero before', before.snap.memory_entities_global > 0],
  ['memory_entity_links conserved', after.memory_entity_links === before.snap.memory_entity_links],
  ['memory_relations conserved', after.memory_relations === before.snap.memory_relations],
  ['confirmations conserved', after.confirmations === before.snap.confirmations],
  ['sessions conserved', after.sessions === before.snap.sessions],
  ['sessions NULL project_id repointed', after.sessions_null_project === 0],
  ['sessions had NULL project_id before', before.snap.sessions_null_project > 0],
  ['exactly one is_default project', defaultCount === 1],
  ['projects grew by exactly one', after.projects === before.snap.projects + 1],
  [
    'finished consolidation_runs keep scope=global (D16)',
    after.consolidation_runs_global > 0 &&
      after.consolidation_runs_global < before.snap.consolidation_runs_global,
  ],
  ['foreign_key_check empty', fkAfter.length === 0],
  ['integrity_check ok', integrity.length === 1 && integrity[0] === 'ok'],
  ['memory_fts integrity-check ok', ftsIntegrity === 'ok'],
  ['blob sample non-empty', blobsChecked >= Math.min(BLOB_SAMPLE, before.snap.memory_vec_global)],
  ['sampled blobs byte-identical', blobsChecked > 0 && blobBytesIdentical === blobsChecked],
  ['sampled blobs cosine distance 0', blobsChecked > 0 && blobCosineZero === blobsChecked],
  [
    'sampled blobs live in the new partition',
    blobsChecked > 0 && blobInNewPartition === blobsChecked,
  ],
  ['dense kNN in the new partition returns rows', knn.length > 0],
  ['control kNN in a pre-existing partition returns rows', controlKnn.length > 0],
];

const report = {
  fixture,
  variant,
  instrument:
    variant === 'boot'
      ? 'I3 FULL-BOOT (createDb: pragmas + migrate + ANALYZE + query-tokenizer)'
      : variant === 'runner'
        ? 'I2 RUNNER-WHOLE-BODY (real migrate() over a real .sql file)'
        : 'I1 BODY-ISOLATED (envelope replicated in-process, per-statement timing)',
  before: before.snap,
  after,
  newProject,
  timingMs: result.groups,
  totalMs: Number(result.totalMs.toFixed(3)),
  vecGroupMs: Number(
    Object.entries(result.groups)
      .filter(
        ([k]) => k.startsWith('vec-') || k.startsWith('loop-') || k.startsWith('insert-first-'),
      )
      .reduce((a, [, v]) => a + v, 0)
      .toFixed(3),
  ),
  bytes: {
    dbBeforeBody: sizeOf(join(fixture, 'data.db')),
    walBeforeBody: sizeOf(join(fixture, 'data.db-wal')),
    dbAfterBody: dbSizeAfterBody,
    walAfterClose: walSizeAfterClose,
    walPeak: result.walPeakBytes,
  },
  blobs: {
    checked: blobsChecked,
    byteIdentical: blobBytesIdentical,
    cosineZero: blobCosineZero,
    inNewPartition: blobInNewPartition,
  },
  knnRows: knn.length,
  controlKnnRows: controlKnn.length,
  ftsIntegrity,
  integrity,
  vecOrphanPartitions,
  vecAtDefaultPartition,
  pages,
  vacuum,
  assertions: assertions.map(([name, ok]) => ({ name, ok })),
  failures: assertions.filter(([, ok]) => !ok).map(([name]) => name),
};

const jsonPath = arg('json');
if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
}
// `--keep` leaves the migrated copy in place so another probe can read it
// (scale-rollback.mjs needs a post-migration database, not a number).
if (!process.argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.failures.length > 0) process.exit(3);
