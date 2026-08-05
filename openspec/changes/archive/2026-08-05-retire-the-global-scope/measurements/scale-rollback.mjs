/**
 * Does the cheap alternative preserve the rollback behaviour the design measured?
 *
 * Usage (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/retire-the-global-scope/measurements/scale-rollback.mjs \
 *     --fixture <fixtureDir> [--work <dir>]
 *
 * design.md D5 records, as a measured property of the shipped shape: after the
 * migration "the old dense read on `__global__` returns **0**". Variant E in
 * scale.md (give the default project the literal id `__global__`, so `memory_vec`
 * needs no statement at all) is ~6x faster at 200k — but it leaves every ex-global
 * vector sitting at exactly the partition key the OLD binary's global dense branch
 * queries. This probe runs the old binary's own query shapes against both
 * migrated databases and reports what each returns.
 *
 * The query shapes are copied from the code a rolled-back image would execute:
 *   - `knnByQueryVector` (`db/repositories/vectors-repository.ts:113-131`)
 *   - `knnCandidates`'s hydration join (`:80-92`), which joins `memory` with NO
 *     scope predicate — the reason a stale partition is a leak and not just a
 *     dangling row.
 * Both are run verbatim in shape, so the result is a fact about that code path
 * and not about a paraphrase of it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const serverRequire = createRequire(join(REPO, 'apps', 'server', 'package.json'));
const Database = serverRequire('better-sqlite3');
const sqliteVec = serverRequire('sqlite-vec');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}
const fixture = arg('fixture');
if (!fixture) throw new Error('--fixture is required');
const workRoot = arg('work', mkdtempSync(join(tmpdir(), 'scale-rollback-')));

const results = {};
for (const variant of ['set', 'id-is-partition']) {
  const work = join(workRoot, variant);
  const r = spawnSync(
    'pnpm',
    [
      '--filter',
      '@rembric/server',
      'exec',
      'tsx',
      join(HERE, 'scale-migrate.mjs'),
      '--fixture',
      fixture,
      '--variant',
      variant,
      '--work',
      work,
      '--keep',
    ],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`migration ${variant} failed: ${r.stderr?.slice(-2000)}`);

  const db = new Database(join(work, 'data.db'));
  sqliteVec.load(db);
  const defaultProject = db.prepare('SELECT id, slug FROM projects WHERE is_default = 1').get();
  const probe = db.prepare('SELECT embedding FROM memory_vec LIMIT 1').get();
  const qv = Buffer.from(probe.embedding);

  // The old binary's global sparse read: `scopeWhere` for global scope.
  const oldGlobalRows = db.prepare("SELECT count(*) c FROM memory WHERE scope = 'global'").get().c;

  // The old binary's global DENSE read, shape-for-shape.
  const oldDense = db
    .prepare(
      `SELECT memory_id AS id, distance FROM memory_vec
        WHERE embedding MATCH ? AND k = 10 AND partition_key = '__global__' AND status = 'active'
        ORDER BY distance`,
    )
    .all(qv);

  // What the old binary would then SHOW: the hydration join carries no scope
  // predicate, so whatever the dense branch returned becomes a result row.
  const hydrated = oldDense.length
    ? db
        .prepare(
          `SELECT m.id AS id, m.scope AS scope, m.project_id AS projectId
             FROM json_each(?) je
             JOIN memory_vec v ON v.memory_id = je.value
             JOIN memory m ON m.id = je.value`,
        )
        .all(JSON.stringify(oldDense.map((n) => n.id)))
    : [];

  // Control that must pass in BOTH arms: the new default project's own dense read
  // returns rows, so a zero above is a real zero and not a broken probe.
  const newDense = db
    .prepare(
      `SELECT memory_id AS id FROM memory_vec
        WHERE embedding MATCH ? AND k = 10 AND partition_key = ? AND status = 'active'
        ORDER BY distance`,
    )
    .all(qv, defaultProject.id);

  results[variant] = {
    defaultProject,
    oldGlobalSparseRows: oldGlobalRows,
    oldGlobalDenseRows: oldDense.length,
    hydratedRows: hydrated.length,
    hydratedScopes: [...new Set(hydrated.map((h) => h.scope))],
    hydratedProjectIsDefault: hydrated.every((h) => h.projectId === defaultProject.id),
    newPartitionDenseRows: newDense.length,
  };
  db.close();
  rmSync(work, { recursive: true, force: true });
}

const shipped = results.set;
const alt = results['id-is-partition'];
const assertions = [
  [
    'control: the shipped shape still serves a dense read in the new partition',
    shipped.newPartitionDenseRows > 0,
  ],
  [
    'control: the alternative still serves a dense read in the new partition',
    alt.newPartitionDenseRows > 0,
  ],
  [
    "shipped shape reproduces design.md D5's measured 0 on the old dense global read",
    shipped.oldGlobalDenseRows === 0,
  ],
  [
    'both shapes leave zero rows readable by the old sparse global read',
    shipped.oldGlobalSparseRows === 0 && alt.oldGlobalSparseRows === 0,
  ],
  [
    'the alternative does NOT reproduce it — the old dense global read returns rows',
    alt.oldGlobalDenseRows > 0,
  ],
  [
    'and those rows hydrate as project-scoped rows through a global read',
    alt.hydratedRows > 0 && alt.hydratedScopes.join(',') === 'project',
  ],
];

if (!existsSync(workRoot)) throw new Error('work root vanished');
rmSync(workRoot, { recursive: true, force: true });
process.stdout.write(
  `${JSON.stringify(
    {
      fixture,
      results,
      assertions: assertions.map(([name, ok]) => ({ name, ok })),
      failures: assertions.filter(([, ok]) => !ok).map(([name]) => name),
    },
    null,
    2,
  )}\n`,
);
