// Measures, on a synthetic corpus: one archive transaction (task 7.1), the reconcile batch size (7.2)
// and the restored-judgment exclusion read the deadline step makes once per sweep call (7.3).
// Run from packages/core: ARCHIVE_SCRATCH=$(mktemp -d) pnpm exec tsx ../../openspec/changes/freeze-archived-projects-in-consolidation/measurements/archive-cost.mts
import { constants, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRATCH = process.env.ARCHIVE_SCRATCH;
if (!SCRATCH) throw new Error('set ARCHIVE_SCRATCH to a mktemp -d directory outside the workspace');

const ROOT = new URL('../../../../', import.meta.url);
const repoFile = (rel: string) => import(new URL(rel, ROOT).href);
const db = await repoFile('packages/db/src/index.ts');
const core = await repoFile('packages/core/src/index.ts');
const { buildCorpus, DEFAULT_ARGS } = await repoFile('apps/web/src/scripts/seed-volumetric.ts');
const coreRequire = createRequire(new URL('packages/core/package.json', ROOT));
const { ulid } = await import(pathToFileURL(coreRequire.resolve('ulid')).href);

const MEMORIES = Number(process.env.MEMORIES ?? 50_000);
const TARGET = 'vol-0';
const REPEATS = Number(process.env.REPEATS ?? 3);
const BATCH_SIZES = [50, 100, 200, 400, 800];
const BATCH_SAMPLES = 10;
const BUDGET_MS = 50;

const openDb = (dir: string) =>
  db.createDb({ dataDir: dir, onMigrationProgress: () => {}, onStartupLog: () => {} });

function baseCorpus(): string {
  const dir = join(SCRATCH!, `corpus-${MEMORIES}`);
  if (existsSync(join(dir, 'built.ok'))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const handle = openDb(dir);
  buildCorpus({
    handle,
    args: { ...DEFAULT_ARGS, dataDir: dir, memories: MEMORIES, relations: 0 },
    log: () => {},
  });
  handle.close();
  writeFileSync(join(dir, 'built.ok'), 'ok\n');
  return dir;
}

let seq = 0;
function clone(from: string): { handle: any; path: string } {
  const path = join(SCRATCH!, `clone-${++seq}`);
  mkdirSync(path, { recursive: true });
  copyFileSync(join(from, 'data.db'), join(path, 'data.db'), constants.COPYFILE_FICLONE);
  return { handle: openDb(path), path };
}

function dispose(c: { handle: any; path: string }): void {
  c.handle.close();
  rmSync(c.path, { recursive: true, force: true });
}

function withPending(from: string, pending: number): string {
  const dir = join(SCRATCH!, `pending-${MEMORIES}-${pending}`);
  if (existsSync(join(dir, 'built.ok'))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(from, 'data.db'), join(dir, 'data.db'));
  const handle = openDb(dir);
  const repos = db.createRepositories(handle.db);
  const project = repos.projects.findBySlug(TARGET)!;
  const ids: string[] = handle.raw
    .prepare("SELECT id FROM memory WHERE scope = 'project' AND project_id = ? AND status = 'active' ORDER BY id")
    .all(project.id)
    .map((r: { id: string }) => r.id);
  const relations = new core.RelationsService(repos, handle.db);
  handle.db.transaction(() => {
    let made = 0;
    for (let gap = 1; made < pending; gap++) {
      for (let i = 0; i + gap < ids.length && made < pending; i++, made++) {
        relations.createPending({ sourceId: ids[i]!, targetId: ids[i + gap]! });
      }
    }
  });
  handle.close();
  writeFileSync(join(dir, 'built.ok'), 'ok\n');
  return dir;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const fmt = (n: number) => n.toFixed(1);
const lines: string[] = [];
const out = (line: string) => {
  lines.push(line);
  console.log(line);
};

const base = baseCorpus();
out(`corpus: ${MEMORIES} memories (seed-volumetric, relations 0), archived project: ${TARGET}`);
out(`instrument: wall clock of the named call, performance.now(), one fresh clone per sample`);

out('');
out('## 7.1 archive transaction (ProjectsService.archive: archived_at + orphan + journal)');
for (const pending of [1_000, 10_000]) {
  const dir = withPending(base, pending);
  const samples: number[] = [];
  for (let r = 0; r < REPEATS; r++) {
    const c = clone(dir);
    const repos = db.createRepositories(c.handle.db);
    const projects = new core.ProjectsService(repos, undefined, c.handle.db);
    const id = repos.projects.findBySlug(TARGET)!.id;
    const t0 = performance.now();
    projects.archive(id);
    samples.push(performance.now() - t0);
    const left = c.handle.raw
      .prepare(
        "SELECT count(*) AS n FROM memory_relations r JOIN memory m ON m.id = r.source_id WHERE r.status = 'pending' AND m.project_id = ?",
      )
      .get(id).n;
    if (left !== 0) throw new Error(`archive left ${left} pending`);
    dispose(c);
  }
  out(`pending=${pending}: min ${fmt(Math.min(...samples))} ms, max ${fmt(Math.max(...samples))} ms over ${REPEATS} runs`);
}

out('');
out(`## 7.2 reconcile batch transaction (one orphanPendingOnProjectArchive batch), target p95 <= ${BUDGET_MS} ms`);
const big = withPending(base, 10_000);
let chosen = 0;
for (const size of BATCH_SIZES) {
  const c = clone(big);
  const repos = db.createRepositories(c.handle.db);
  const id = repos.projects.findBySlug(TARGET)!.id;
  repos.projects.setArchivedAt(id, new Date(), true);
  const relations = new core.RelationsService(repos, c.handle.db);
  const samples: number[] = [];
  for (let i = 0; i < BATCH_SAMPLES; i++) {
    const t0 = performance.now();
    const n = c.handle.db.transaction(() =>
      core.orphanPendingOnProjectArchive(repos, relations, {
        projectId: id,
        at: new Date(),
        origin: 'reconcile',
        limit: size,
      }),
    );
    samples.push(performance.now() - t0);
    if (n !== size) throw new Error(`batch ${size} closed ${n}`);
  }
  dispose(c);
  const p95 = pct(samples, 95);
  if (p95 <= BUDGET_MS) chosen = size;
  out(`batch=${size}: p50 ${fmt(pct(samples, 50))} ms, p95 ${fmt(p95)} ms, max ${fmt(Math.max(...samples))} ms (${BATCH_SAMPLES} batches, 10 000 pending)`);
}
out(`largest batch within p95 <= ${BUDGET_MS} ms: ${chosen}`);

out('');
out('## 7.3 restored-judgment exclusion read (listOrphaningsRevertedWithin), once per sweep call');
for (const opsCount of [1_000, 10_000, 100_000]) {
  const c = clone(base);
  const repos = db.createRepositories(c.handle.db);
  const now = Date.now();
  c.handle.db.transaction(() => {
    const runId = ulid(now);
    repos.consolidation.insertRun({ id: runId, startedAt: new Date(now), finishedAt: new Date(now), scope: 'maintenance', summary: '{}' });
    for (let i = 0; i < opsCount; i++) {
      const opId = ulid(now + i);
      repos.consolidation.insertOp({
        id: opId,
        runId,
        opType: 'orphan_promote',
        affectedIds: ['a', 'b'],
        createdId: `j${i}`,
        reasoning: i % 2 === 0 ? `orphaned: ${core.PROJECT_ARCHIVE_ORPHAN_REASON}` : 'orphaned: unjudged after 1209600000ms deadline',
        appliedAt: new Date(now),
      });
      if (i % 10 === 0) repos.consolidation.markReverted(opId, new Date(now));
    }
  });
  const relations = new core.RelationsService(repos, c.handle.db);
  const samples: number[] = [];
  let found = 0;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    found = relations.listOrphaningsRevertedWithin(core.PROJECT_ARCHIVE_ORPHANING_PREFIX, 14 * 86_400_000).length;
    samples.push(performance.now() - t0);
  }
  dispose(c);
  out(`ops=${opsCount} (every tenth reverted, half archive orphanings): p50 ${fmt(pct(samples, 50))} ms, p95 ${fmt(pct(samples, 95))} ms, ${found} ids`);
}

const target = new URL('./archive-cost.txt', import.meta.url);
writeFileSync(target, `${lines.join('\n')}\n`);
