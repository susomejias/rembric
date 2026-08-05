/**
 * Is the migration safe to interrupt at scale?
 *
 * Usage (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/retire-the-global-scope/measurements/scale-crash.mjs \
 *     --fixture <fixtureDir> --kill-after <ms> [--work <dir>]
 *
 * At 200 000 global rows the body runs for minutes with no output, and the
 * plausible operator response to a silent boot is `Ctrl-C` or a container
 * restart. That makes crash-safety a scale question, not a unit-test question:
 * the ledger row is written INSIDE the transaction (`db/migrate.ts:108`), so an
 * interrupted migration must leave the database exactly as it was AND must not
 * be recorded as applied.
 *
 * The probe SIGKILLs the migrating process mid-body — SIGKILL, not SIGTERM, so
 * no handler can tidy up and what survives is only what SQLite's own recovery
 * guarantees. It then re-opens the file, asserts nothing moved, and runs the
 * migration again to completion.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const serverRequire = createRequire(join(REPO, 'apps', 'server', 'package.json'));
const Database = serverRequire('better-sqlite3');
const sqliteVec = serverRequire('sqlite-vec');
const REAL_MIGRATIONS = join(REPO, 'apps', 'server', 'src', 'db', 'migrations');
const BODY_SQL = join(HERE, 'scale-migration-body.sql');
const MIGRATION_NAME = '0031_retire_global_scope.sql';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}

const fixture = arg('fixture');
if (!fixture) throw new Error('--fixture is required');
const killAfterMs = Number(arg('kill-after', '500'));
const work = arg('work', mkdtempSync(join(tmpdir(), 'scale-crash-')));
if (existsSync(work)) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
cpSync(fixture, work, { recursive: true });
const dbPath = join(work, 'data.db');

const staged = mkdtempSync(join(tmpdir(), 'scale-crash-migrations-'));
for (const f of readdirSync(REAL_MIGRATIONS)) {
  if (f.endsWith('.sql')) cpSync(join(REAL_MIGRATIONS, f), join(staged, f));
}
cpSync(BODY_SQL, join(staged, MIGRATION_NAME));

const open = () => {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');
  return db;
};
const count = (db, table, where = '') =>
  db.prepare(`SELECT count(*) c FROM ${table} ${where ? `WHERE ${where}` : ''}`).get().c;
const snap = (db) => ({
  memory: count(db, 'memory'),
  memoryGlobal: count(db, 'memory', "scope='global'"),
  memory_vec: count(db, 'memory_vec'),
  memory_vec_global: count(db, 'memory_vec', "partition_key='__global__'"),
  memory_entities: count(db, 'memory_entities'),
  memory_entities_global: count(db, 'memory_entities', "scope='global'"),
  memory_entity_links: count(db, 'memory_entity_links'),
  confirmations: count(db, 'confirmations'),
  projects: count(db, 'projects'),
  migrations: count(db, '_migrations'),
});

const b = open();
const before = snap(b);
b.close();

// The child does exactly what a boot does; it is killed while the body runs.
const child = `
  import { createRequire } from 'node:module';
  const r = createRequire(${JSON.stringify(join(REPO, 'apps', 'server', 'package.json'))});
  const D = r('better-sqlite3');
  const vec = r('sqlite-vec');
  const { migrate } = await import(${JSON.stringify(join(REPO, 'apps/server/src/db/migrate.ts'))});
  const db = new D(${JSON.stringify(dbPath)});
  vec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  process.stdout.write('READY\\n');
  migrate(db, { migrationsDir: ${JSON.stringify(staged)} });
  db.close();
`;
const childPath = join(work, 'crash-child.mjs');
(await import('node:fs')).writeFileSync(childPath, child);

// `tsx` is invoked directly rather than through `pnpm … exec`: the wrapper adds
// process layers a SIGKILL to the top pid does not reach, and the first attempt
// at this probe "passed" only because the kill hit the wrapper while the real
// migration ran to completion underneath. `detached` gives the child its own
// process group so the kill takes the whole tree, and the timer starts on the
// child's own READY line rather than on spawn, so tsx's ~1.5 s start-up is not
// counted against `--kill-after`.
const killer = await new Promise((resolve) => {
  const proc = spawn(join(REPO, 'apps', 'server', 'node_modules', '.bin', 'tsx'), [childPath], {
    cwd: join(REPO, 'apps', 'server'),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let killed = false;
  proc.stderr.on('data', (d) => {
    stderr += String(d);
  });
  proc.stdout.on('data', (d) => {
    if (!String(d).includes('READY') || killed) return;
    setTimeout(() => {
      killed = true;
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, killAfterMs);
  });
  proc.on('exit', (code, signal) => resolve({ stderr, code, signal, killed }));
});

const a = open();
const afterCrash = snap(a);
const walBytes = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
const integrityAfterCrash = a
  .prepare('PRAGMA integrity_check')
  .all()
  .map((r) => r.integrity_check);
const ledger = a
  .prepare('SELECT count(*) c FROM _migrations WHERE filename = ?')
  .get(MIGRATION_NAME).c;
a.close();

// Boot 2: the retry an operator gets by restarting the container.
const { migrate } = await import(join(REPO, 'apps/server/src/db/migrate.ts'));
const db2 = open();
db2.pragma('journal_mode = WAL');
const t = process.hrtime.bigint();
const retry = migrate(db2, { migrationsDir: staged });
const retryMs = Number(process.hrtime.bigint() - t) / 1e6;
const afterRetry = snap(db2);
const integrityAfterRetry = db2
  .prepare('PRAGMA integrity_check')
  .all()
  .map((r) => r.integrity_check);
db2.close();

const assertions = [
  ['fixture was non-empty', before.memory > 0 && before.memoryGlobal > 0],
  ['the child was actually SIGKILLed', killer.signal === 'SIGKILL'],
  ['the kill landed mid-body (migration was not recorded)', ledger === 0],
  [
    'every counted total is unchanged after the crash',
    JSON.stringify(afterCrash) === JSON.stringify(before),
  ],
  [
    'global rows still present after the crash (nothing half-moved)',
    afterCrash.memoryGlobal === before.memoryGlobal,
  ],
  ['integrity_check ok after the crash', integrityAfterCrash.join(',') === 'ok'],
  ['boot 2 applies the migration', retry.applied.includes(MIGRATION_NAME)],
  ['boot 2 leaves zero global rows', afterRetry.memoryGlobal === 0],
  [
    'boot 2 conserves the memory total, non-zero',
    afterRetry.memory === before.memory && afterRetry.memory > 0,
  ],
  [
    'boot 2 leaves the global vec partition empty, total conserved and non-zero',
    afterRetry.memory_vec_global === 0 &&
      afterRetry.memory_vec === before.memory_vec &&
      afterRetry.memory_vec > 0,
  ],
  ['integrity_check ok after boot 2', integrityAfterRetry.join(',') === 'ok'],
];

rmSync(staged, { recursive: true, force: true });
const report = {
  fixture,
  killAfterMs,
  child: {
    exitCode: killer.code,
    signal: killer.signal,
    killSent: killer.killed,
    stderrTail: (killer.stderr ?? '').trim().split('\n').slice(-2).join(' | '),
  },
  before,
  afterCrash,
  afterRetry,
  walBytesLeftBehind: walBytes,
  ledgerRowsForMigration: ledger,
  retryMs: Number(retryMs.toFixed(1)),
  integrityAfterCrash,
  integrityAfterRetry,
  assertions: assertions.map(([name, ok]) => ({ name, ok })),
  failures: assertions.filter(([, ok]) => !ok).map(([name]) => name),
};
rmSync(work, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.failures.length > 0) process.exit(3);
