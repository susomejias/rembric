// Task group 9: the SHIPPED drain's cost per drain step, per sweep call, and per whole callback.
// Instruments are named in every table header and never tabulated together. No embedder is loaded.
// Run: DRAIN_SCRATCH=$(mktemp -d) TMPDIR=$DRAIN_SCRATCH pnpm --filter @rembric/core exec tsx ../../openspec/changes/drain-stale-save-time-pendings/measurements/drain-cost-shipped.mts [sizes...]
// Env: CORPUS_DIR reuses built corpora; BUDGETS=50,40 emulates other budgets through the drain clock seam;
//      CALLS filters call types by label prefix; CLONES and CALLS_PER_CLONE size the sample.
import { constants, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.DRAIN_SCRATCH;
if (!SCRATCH) throw new Error('set DRAIN_SCRATCH to a mktemp -d directory outside the workspace');
const CORPUS_DIR = process.env.CORPUS_DIR ?? SCRATCH;

const P = await import('./drain-prototype.mts');
const { db, core } = P;
const { buildCorpus, DEFAULT_ARGS, CORPUS_EPOCH_MS, SYNTHETIC_VECTOR_CAVEAT } = await import(
  new URL('apps/web/src/scripts/seed-volumetric.ts', P.ROOT).href
);

const SIZES = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => n > 0);
if (SIZES.length === 0) SIZES.push(1_000, 20_000, 50_000);
const BACKLOGS = [
  { label: '~600', relations: 14_400 },
  { label: '~5000', relations: 120_000 },
];
const SHIPPED_BUDGET: number = core.DRAIN_BUDGET_MS;
const BUDGETS = (process.env.BUDGETS ?? String(SHIPPED_BUDGET)).split(',').map(Number);
const CLONES = Number(process.env.CLONES ?? 3);
const CALLS_PER_CLONE = Number(process.env.CALLS_PER_CLONE ?? 10);
const CALL_FILTER = process.env.CALLS ?? '';
const LOADED = ['vol-shared', 'vol-0', 'vol-1', 'vol-2', 'vol-3', 'vol-4'];

function corpusDir(size: number, relations: number): string {
  const dir = join(CORPUS_DIR, `vol-${size}-${relations}`);
  if (existsSync(join(dir, 'built.ok'))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const handle = P.openDb(dir);
  buildCorpus({
    handle,
    args: { ...DEFAULT_ARGS, dataDir: dir, memories: size, relations },
    log: () => {},
  });
  handle.close();
  writeFileSync(join(dir, 'built.ok'), 'ok\n');
  return dir;
}

/** Memory timestamps move to today, so decay sees a corpus in use; relations keep their age, so the deadline step runs. */
function preparedDir(size: number, relations: number): string {
  const dir = join(SCRATCH!, `prep-${size}-${relations}`);
  if (existsSync(join(dir, 'prepared.ok'))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(corpusDir(size, relations), 'data.db'), join(dir, 'data.db'));
  const handle = P.openDb(dir);
  const shift = Date.now() - CORPUS_EPOCH_MS - 86_400_000;
  // SCRATCH WRITE on a private copy of the synthetic corpus, never a server database.
  handle.raw
    .prepare('UPDATE memory SET created_at = created_at + ?, last_seen_at = last_seen_at + ?')
    .run(shift, shift);
  handle.close();
  writeFileSync(join(dir, 'prepared.ok'), 'ok\n');
  return dir;
}

let cloneSeq = 0;
function clone(dir: string): { handle: any; path: string } {
  const path = join(SCRATCH!, `clone-${++cloneSeq}`);
  mkdirSync(path, { recursive: true });
  copyFileSync(join(dir, 'data.db'), join(path, 'data.db'), constants.COPYFILE_FICLONE);
  return { handle: P.openDb(path), path };
}

function dispose(c: { handle: any; path: string }): void {
  c.handle.close();
  rmSync(c.path, { recursive: true, force: true });
}

interface Timing {
  steps: number[];
  callMs: number;
  examined: number;
}

/** Instrument A brackets each drain step between its first repository read and the run's finishRun. */
function instrumentedRunner(handle: any, budgetMs: number, projectIds: string[] | null) {
  const repos = db.createRepositories(handle.db);
  const steps: number[] = [];
  let stepStart: number | null = null;
  const consolidation = Object.create(repos.consolidation);
  consolidation.latestFinishedRunSummary = (scope: string) => {
    stepStart = performance.now();
    return repos.consolidation.latestFinishedRunSummary(scope);
  };
  consolidation.finishRun = (id: string, at: Date, summary: string) => {
    if (stepStart !== null) steps.push(performance.now() - stepStart);
    stepStart = null;
    return repos.consolidation.finishRun(id, at, summary);
  };
  const projects = Object.create(repos.projects);
  if (projectIds) projects.listAllIds = () => projectIds;
  const scale = SHIPPED_BUDGET / budgetMs;
  const runner = new core.ConsolidationRunner({
    repos: { ...repos, consolidation, projects },
    tx: handle.db,
    relations: new core.RelationsService(repos, handle.db),
    projects: new core.ProjectsService(repos),
    agentSessions: new core.AgentSessionsService(repos, handle.db),
    minIntervalMs: 0,
    vectorIndexCurrent: () => true,
    ...(scale === 1 ? {} : { drainClock: () => performance.now() * scale }),
  });
  return { runner, steps, repos };
}

function quantiles(xs: number[]): string {
  return `p50 ${P.quantile(xs, 0.5).toFixed(1)}  p95 ${P.quantile(xs, 0.95).toFixed(1)}  max ${Math.max(...xs).toFixed(1)}`;
}

const out: string[] = [
  '# stale pending drain — cost of the SHIPPED step',
  `CAVEAT: ${SYNTHETIC_VECTOR_CAVEAT}. The vocabulary is tiny and the vectors are pseudo-random: this file measures cost, not correctness.`,
  'model inference: none — the drain reads stored vectors only, and no embedder is loaded in this process.',
  'corpus: pnpm run corpus:build generator (buildCorpus, seed 1) with --relations R: R relations between random pairs of one scope slot (i % 6), 25% pending, 5% orphaned, 70% judged. Six loaded projects plus the empty default project.',
  'preparation: memory created_at and last_seen_at shifted to today on a private copy, so the decay step sees a corpus in use and archives nothing; relation timestamps keep their generated age, so every pending row is past the deadline and the deadline step orphans its 50 rows per scope per run, as on an upgraded install with an aged backlog.',
  `runner: the shipped ConsolidationRunner (DRAIN_ROW_CAP ${core.DRAIN_ROW_CAP}, DRAIN_BUDGET_MS ${SHIPPED_BUDGET}, DRAIN_MAX_PAIR_CHARS ${core.DRAIN_MAX_PAIR_CHARS}), vectorIndexCurrent true, minIntervalMs 0 so repeated session-start sweeps are not throttled. An emulated budget B scales the drain clock seam by ${SHIPPED_BUDGET}/B; the shipped budget uses the plain clock.`,
  'Instrument A (drain step): wall clock from the step\'s first repository read to the run\'s finishRun, performance.now. "Drain per call" sums Instrument A over the steps of one sweep call — the figure the p95 <= 50 ms budget binds.',
  'Instrument B (whole callback): wall clock of one sweep call — sweepFor or runAll — including decay, deadline orphaning, the drain and the session purge. Never tabulated with Instrument A.',
  `sample: ${CLONES} fresh copy-on-write clones per row x ${CALLS_PER_CLONE} consecutive calls each, every call timed (the first call of each clone is cold).`,
  `node ${process.version}, ${process.platform}/${process.arch}`,
  '',
];

const callTypes = (ids: Map<string, string>) =>
  [
    {
      label: 'sweepFor, session start (default + vol-shared)',
      scopes: 2,
      extra: 0,
      run: (r: any) => r.sweepFor(ids.get('vol-shared')),
      list: null as string[] | null,
    },
    {
      label: 'runAll forced, 2 loaded projects',
      scopes: 2,
      extra: 0,
      run: (r: any) => r.runAll({ force: true }),
      list: LOADED.slice(0, 2).map((s) => ids.get(s)!),
    },
    {
      label: 'runAll forced, 7 projects (6 loaded + default)',
      scopes: 7,
      extra: 0,
      run: (r: any) => r.runAll({ force: true }),
      list: null,
    },
    {
      label: 'runAll forced, 10 projects (6 loaded + default + 3 empty)',
      scopes: 10,
      extra: 3,
      run: (r: any) => r.runAll({ force: true }),
      list: null,
    },
    {
      label: 'runAll forced, 50 projects (6 loaded + default + 43 empty)',
      scopes: 50,
      extra: 43,
      run: (r: any) => r.runAll({ force: true }),
      list: null,
    },
  ].filter((c) => CALL_FILTER === '' || c.label.startsWith(CALL_FILTER));

for (const size of process.env.MATRIX === '0' ? [] : SIZES) {
  for (const backlog of BACKLOGS) {
    const dir = preparedDir(size, backlog.relations);
    const probe = clone(dir);
    const repos = db.createRepositories(probe.handle.db);
    const ids = new Map<string, string>(LOADED.map((s) => [s, repos.projects.findBySlug(s).id]));
    // VERIFICATION READS (raw, read-only)
    const pendingIn = (projectId: string) => P.pendingIds(probe.handle, projectId).length as number;
    const plan = probe.handle.raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT r.judgment_id FROM memory_relations r JOIN memory ms ON ms.id = r.source_id JOIN memory mt ON mt.id = r.target_id
         WHERE r.status = 'pending' AND (r.created_at, r.judgment_id) > (?, ?) AND r.judgment_id NOT IN (SELECT value FROM json_each(?))
           AND ms.scope = 'project' AND ms.project_id = ? AND mt.scope = 'project' AND mt.project_id = ?
         ORDER BY r.created_at, r.judgment_id LIMIT ?`,
      )
      .all(0, '', '[]', ids.get('vol-shared'), ids.get('vol-shared'), 150)
      .map((r: any) => r.detail)
      .join(' | ');
    const defaultId = new core.ProjectsService(repos).getDefault().id;
    // VERIFICATION READ (raw, read-only): the indexed range alone, the selection shape without the project probe.
    const rangeOnly = probe.handle.raw.prepare(
      `SELECT r.judgment_id FROM memory_relations r JOIN memory ms ON ms.id = r.source_id JOIN memory mt ON mt.id = r.target_id
       WHERE r.status = 'pending' AND ms.scope = 'project' AND ms.project_id = ? AND mt.scope = 'project' AND mt.project_id = ?
       ORDER BY r.created_at, r.judgment_id LIMIT ?`,
    );
    const median = (fn: () => unknown) => {
      const xs: number[] = [];
      for (let i = 0; i < 9; i += 1) {
        const t = performance.now();
        fn();
        xs.push(performance.now() - t);
      }
      return P.quantile(xs, 0.5).toFixed(2);
    };
    const selection = (projectId: string, limit: number) =>
      `shipped ${median(() => repos.relations.listExaminablePendingInScope({ projectId, excludeJudgmentIds: [], limit }))} ms, indexed range alone ${median(() => rangeOnly.all(projectId, projectId, limit))} ms`;
    out.push(
      `## ${size} memories, backlog ${backlog.label} (R = ${backlog.relations})`,
      `pending per loaded project: ${LOADED.map((s) => `${s} ${pendingIn(ids.get(s)!)}`).join(', ')}`,
      `selection plan (the shipped query shape, indexed branch): ${plan}`,
      `selection read (instrument: wall clock of one read, warm, median of 9): vol-shared LIMIT ${core.DRAIN_ROW_CAP}: ${selection(ids.get('vol-shared')!, core.DRAIN_ROW_CAP)}; vol-shared LIMIT 1: ${selection(ids.get('vol-shared')!, 1)}; empty default project LIMIT ${core.DRAIN_ROW_CAP}: ${selection(defaultId, core.DRAIN_ROW_CAP)}`,
    );
    dispose(probe);

    for (const budget of BUDGETS) {
      for (const call of callTypes(ids)) {
        const timings: Timing[] = [];
        for (let k = 0; k < CLONES; k += 1) {
          const c = clone(dir);
          const svc = new core.ProjectsService(db.createRepositories(c.handle.db));
          for (let e = 0; e < call.extra; e += 1) svc.create({ slug: `empty-${e}` });
          const { runner, steps } = instrumentedRunner(c.handle, budget, call.list);
          for (let n = 0; n < CALLS_PER_CLONE; n += 1) {
            steps.length = 0;
            const t0 = performance.now();
            const summary = call.run(runner);
            const callMs = performance.now() - t0;
            timings.push({
              steps: [...steps],
              callMs,
              examined: summary.runs.reduce((acc: number, r: any) => acc + r.drain.examined, 0),
            });
          }
          dispose(c);
        }
        const perStep = timings.flatMap((t) => t.steps);
        const perCall = timings.map((t) => t.steps.reduce((a, b) => a + b, 0));
        const label =
          budget === SHIPPED_BUDGET
            ? `shipped budget ${budget} ms`
            : `emulated budget ${budget} ms`;
        out.push(
          `${call.label}, ${label}:`,
          `  Instrument A, per drain step (${perStep.length} steps): ${quantiles(perStep)} ms`,
          `  Instrument A, drain per call (${perCall.length} calls): ${quantiles(perCall)} ms; pairs examined per call p50 ${P.quantile(
            timings.map((t) => t.examined),
            0.5,
          )}`,
          `  Instrument B, whole callback (${timings.length} calls): ${quantiles(timings.map((t) => t.callMs))} ms`,
        );
      }
    }
    out.push('');
  }
}

if (process.env.SKIP_OPS !== '1') {
  out.push(
    '## reverted-op lookup (instrument: wall clock of one listRevertedOrphanPromoteCreatedIds read, median of 7, and of the selection with that exclusion list)',
  );
  const dir = preparedDir(SIZES.at(-1)!, BACKLOGS[1]!.relations);
  for (const n of [1_000, 10_000, 100_000]) {
    const c = clone(dir);
    const repos = db.createRepositories(c.handle.db);
    const runId = P.ulid(Date.now());
    repos.consolidation.insertRun({ id: runId, startedAt: new Date(), scope: 'cost-probe' });
    const pending = c.handle.raw
      .prepare("SELECT judgment_id AS id FROM memory_relations WHERE status = 'pending' LIMIT ?")
      .all(Math.ceil(n / 10))
      .map((r: any) => r.id as string);
    // SCRATCH WRITES on a private clone: n synthetic orphan_promote ops, every tenth reverted.
    const insert = c.handle.raw.prepare(
      `INSERT INTO consolidation_ops (id, run_id, op_type, affected_ids, created_id, reasoning, applied_at, reverted_at)
       VALUES (?, ?, 'orphan_promote', '["a","b"]', ?, 'orphaned: cost probe', ?, ?)`,
    );
    c.handle.raw.transaction(() => {
      for (let i = 0; i < n; i += 1) {
        const reverted = i % 10 === 0 ? Date.now() : null;
        insert.run(
          P.ulid(Date.now()),
          runId,
          reverted ? pending[i / 10]! : P.ulid(),
          Date.now(),
          reverted,
        );
      }
    })();
    const xs: number[] = [];
    let ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const t = performance.now();
      ids = repos.consolidation.listRevertedOrphanPromoteCreatedIds();
      xs.push(performance.now() - t);
    }
    const sel: number[] = [];
    const projectId = repos.projects.findBySlug('vol-shared').id;
    for (let i = 0; i < 7; i += 1) {
      const t = performance.now();
      repos.relations.listExaminablePendingInScope({
        projectId,
        excludeJudgmentIds: ids,
        limit: core.DRAIN_ROW_CAP,
      });
      sel.push(performance.now() - t);
    }
    out.push(
      `  consolidation_ops rows ${String(n).padStart(6)}: read ${P.quantile(xs, 0.5).toFixed(2)} ms (${ids.length} reverted ids); selection with that exclusion ${P.quantile(sel, 0.5).toFixed(2)} ms`,
    );
    dispose(c);
  }

  out.push(
    '',
    '## deadline-step read for an empty project (advisory, not the drain; instrument: wall clock of one RelationsService.findPendingOlderThanInScope, limit 50, median of 9)',
  );
  const c = clone(dir);
  const repos = db.createRepositories(c.handle.db);
  const relations = new core.RelationsService(repos, c.handle.db);
  for (const [label, projectId] of [
    ['empty default project', new core.ProjectsService(repos).getDefault().id],
    ['vol-shared', repos.projects.findBySlug('vol-shared').id],
  ] as const) {
    const xs: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const t = performance.now();
      relations.findPendingOlderThanInScope({ projectId, cutoffMs: 14 * 86_400_000, limit: 50 });
      xs.push(performance.now() - t);
    }
    out.push(`  ${label}: ${P.quantile(xs, 0.5).toFixed(2)} ms`);
  }
  dispose(c);
}

console.log(out.join('\n'));
