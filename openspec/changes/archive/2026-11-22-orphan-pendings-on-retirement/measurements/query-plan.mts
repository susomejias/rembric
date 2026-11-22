// Query plan and cost of RelationsRepository.listPendingTouchingAny, the helper's only read (design D2, task 2.2).
// Instrument: EXPLAIN QUERY PLAN of the statement Drizzle builds, and the wall clock of one warm one-id call.
// Run after retirement-cost.mts has cached its corpora: RETIRE_SCRATCH=<same dir> pnpm --filter @rembric/core exec tsx ../../openspec/changes/orphan-pendings-on-retirement/measurements/query-plan.mts
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const ROOT = new URL('../../../../', import.meta.url);
const db = await import(new URL('packages/db/src/index.ts', ROOT).href);
const req = createRequire(new URL('packages/db/package.json', ROOT));
const d = await import(pathToFileURL(req.resolve('drizzle-orm')).href);
const SCRATCH = process.env.RETIRE_SCRATCH;
if (!SCRATCH)
  throw new Error('set RETIRE_SCRATCH to the directory retirement-cost.mts built its corpora in');
for (const size of [1_000, 20_000, 50_000]) {
  const dir = `${SCRATCH}/vol-${size}`;
  const h = db.createDb({
    dataDir: dir,
    readonly: true,
    onMigrationProgress: () => {},
    onStartupLog: () => {},
  });
  // VERIFICATION READ: two active memories of the corpus.
  const ids = (
    h.raw
      .prepare(`SELECT id FROM memory WHERE status='active' ORDER BY id LIMIT 2 OFFSET 100`)
      .all() as { id: string }[]
  ).map((r) => r.id);
  const r = db.memoryRelations;
  const q = h.db
    .select({ judgmentId: r.judgmentId, sourceId: r.sourceId, targetId: r.targetId })
    .from(r)
    .where(
      d.and(
        d.eq(r.status, 'pending'),
        d.or(d.inArray(r.sourceId, ids), d.inArray(r.targetId, ids)),
      ),
    )
    .orderBy(r.createdAt, r.judgmentId)
    .toSQL();
  console.log(`vol-${size}`, q.sql);
  for (const row of h.raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as {
    detail: string;
  }[])
    console.log('  ', row.detail);
  const repos = db.createRepositories(h.db);
  for (let i = 0; i < 200; i++) repos.relations.listPendingTouchingAny([ids[0]]);
  const s: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const t0 = performance.now();
    repos.relations.listPendingTouchingAny([ids[0]]);
    s.push(performance.now() - t0);
  }
  s.sort((a, b) => a - b);
  console.log(
    `   one-id read, warm, 2000 calls: median ${s[1000]!.toFixed(4)} ms, p95 ${s[1900]!.toFixed(4)} ms`,
  );
  h.close();
}
