/**
 * The control for instrument I3 (FULL-BOOT).
 *
 * Usage (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/retire-the-global-scope/measurements/scale-boot-control.mjs \
 *     --fixture <fixtureDir> [--work <dir>]
 *
 * I3 measures `createDb()` on a boot that HAS the migration to apply. On its own
 * that number cannot be attributed: `createDb` also runs `ANALYZE`, builds the
 * query-tokenizer tables and pays whatever checkpointing the previous boot left
 * behind, and all of that scales with the corpus too. This probe boots the SAME
 * fixture with the SAME staged migrations directory MINUS the new migration, so
 * the difference is the migration's own contribution to first-boot latency.
 *
 * Reported as two boots, because they are two different questions:
 *   boot1  the migration-free boot on the un-migrated fixture (the baseline an
 *          operator already lives with today)
 *   boot2  a second boot on the same file, everything already applied (the
 *          steady-state boot they get from the second restart onwards)
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const REAL_MIGRATIONS = join(REPO, 'apps', 'server', 'src', 'db', 'migrations');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}

const fixture = arg('fixture');
if (!fixture) throw new Error('--fixture is required');
const work = arg('work', mkdtempSync(join(tmpdir(), 'scale-boot-control-')));
if (existsSync(work)) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
cpSync(fixture, work, { recursive: true });

const staged = mkdtempSync(join(tmpdir(), 'scale-migrations-control-'));
for (const f of readdirSync(REAL_MIGRATIONS)) {
  if (f.endsWith('.sql')) cpSync(join(REAL_MIGRATIONS, f), join(staged, f));
}

const { createDb } = await import(join(REPO, 'apps/server/src/db/index.ts'));
const sizeOf = (p) => (existsSync(p) ? statSync(p).size : 0);
const dbPath = join(work, 'data.db');

const t1 = process.hrtime.bigint();
const h1 = createDb({ dataDir: work, migrationsDir: staged });
const boot1Ms = Number(process.hrtime.bigint() - t1) / 1e6;
const applied1 = h1.raw.prepare('SELECT count(*) c FROM _migrations').get().c;
const memoryRows = h1.raw.prepare('SELECT count(*) c FROM memory').get().c;
const globalRows = h1.raw.prepare("SELECT count(*) c FROM memory WHERE scope='global'").get().c;
h1.close();

const t2 = process.hrtime.bigint();
const h2 = createDb({ dataDir: work, migrationsDir: staged });
const boot2Ms = Number(process.hrtime.bigint() - t2) / 1e6;
h2.close();

rmSync(staged, { recursive: true, force: true });
const report = {
  fixture,
  instrument: 'I3-CONTROL FULL-BOOT with no migration to apply',
  memoryRows,
  globalRows,
  migrationsAlreadyApplied: applied1,
  boot1Ms: Number(boot1Ms.toFixed(1)),
  boot2Ms: Number(boot2Ms.toFixed(1)),
  dbBytes: sizeOf(dbPath),
  assertions: [
    { name: 'fixture still holds global rows (nothing was migrated)', ok: globalRows > 0 },
    { name: 'memory non-empty', ok: memoryRows > 0 },
  ],
};
rmSync(work, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
