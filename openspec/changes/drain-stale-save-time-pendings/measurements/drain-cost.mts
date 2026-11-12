// Validation 8 — efficiency, plus the batching check (cap or time budget, whichever comes first).
// Instruments are named in every table header. No embedder is loaded: the drain performs no model inference.
// Run: DRAIN_SCRATCH=$(mktemp -d) TMPDIR=$DRAIN_SCRATCH pnpm --filter @rembric/core exec tsx ../../openspec/changes/drain-stale-save-time-pendings/measurements/drain-cost.mts [sizes...]
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.DRAIN_SCRATCH;
if (!SCRATCH) throw new Error('set DRAIN_SCRATCH to a mktemp -d directory outside the workspace');

const P = await import('./drain-prototype.mts');
const { buildCorpus, DEFAULT_ARGS, SYNTHETIC_VECTOR_CAVEAT } = await import(
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
const BATCHES = [50, 200, 500, 1000];
const ORDERS = ['judgment_id', 'created_at'] as const;
const BUDGET_MS = 50;
const SWEEP_CAP = Number(process.env.SWEEP_CAP ?? 300);
const SCOPE_SLUG = 'vol-shared';

function corpusDir(size: number, relations: number): string {
  const dir = join(SCRATCH!, `vol-${size}-${relations}`);
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

let cloneSeq = 0;
function cloneOf(dir: string): { handle: any; projectId: string; path: string } {
  const path = join(SCRATCH!, `clone-${++cloneSeq}`);
  mkdirSync(path, { recursive: true });
  copyFileSync(join(dir, 'data.db'), join(path, 'data.db'), constants.COPYFILE_FICLONE);
  const handle = P.openDb(path);
  const repos = P.db.createRepositories(handle.db);
  return { handle, projectId: repos.projects.findBySlug(SCOPE_SLUG).id, path };
}

function dispose(c: { handle: any; path: string }): void {
  c.handle.close();
  rmSync(c.path, { recursive: true, force: true });
}

function warm(ctx: any, projectId: string): void {
  for (const p of P.pendingPairs(ctx.handle, projectId)) P.recheckPair(ctx, p, projectId);
}

const f1 = (n: number) => n.toFixed(1);
const f3 = (n: number) => n.toFixed(3);
const out: string[] = [
  '# stale pending drain — cost, rules v3 (stored links + re-extraction, retired endpoints drained, size bound, undo final)',
  `CAVEAT: ${SYNTHETIC_VECTOR_CAVEAT}. The vocabulary is tiny, so lexical overlap is high and the keep/drain mix says nothing about correctness: this file measures cost only.`,
  'model inference: excluded by construction — the drain only reads vectors already in memory_vec (fixture-drain no-embedder phase proves it) and no embedder is loaded in this process.',
  `corpus: pnpm run corpus:build generator (buildCorpus, seed 1) with --relations R; it writes R relations between random pairs of one scope slot (i % 6), 25% left pending, 5% orphaned, 70% judged. The drain is measured on scope ${SCOPE_SLUG}.`,
  'settings: createDb defaults (WAL, synchronous NORMAL, 64 MB page cache, 256 MB mmap); every measurement runs on a copy-on-write clone of the built database, so each series starts from the same state.',
  `node ${process.version}, ${process.platform}/${process.arch}; scratch ${SCRATCH}`,
  '',
];
const decisionMix: string[] = [];

for (const size of SIZES) {
  for (const backlog of BACKLOGS) {
    const t0 = performance.now();
    const dir = corpusDir(size, backlog.relations);
    const buildS = (performance.now() - t0) / 1000;
    const probe = cloneOf(dir);
    // VERIFICATION READS (raw, read-only): corpus shape.
    const raw = probe.handle.raw;
    const scopeMemories = raw
      .prepare('SELECT count(*) AS n FROM memory WHERE project_id = ?')
      .get(probe.projectId).n;
    const byStatus = raw
      .prepare('SELECT status, count(*) AS n FROM memory_relations GROUP BY status')
      .all();
    const scopePending = P.pendingIds(probe.handle, probe.projectId).length;
    const mb = statSync(join(dir, 'data.db')).size / 1e6;
    out.push(
      `## ${size} memories, backlog ${backlog.label} (R = ${backlog.relations})`,
      `scope ${SCOPE_SLUG}: ${scopeMemories} memories, ${scopePending} pending; all scopes: ${byStatus.map((r: any) => `${r.status} ${r.n}`).join(', ')}; db ${f1(mb)} MB; build ${buildS > 1 ? f1(buildS) + ' s' : 'reused'}`,
    );
    for (const order of ORDERS) {
      const sel = P.createReads(probe.handle, order);
      const plan = raw
        .prepare(
          order === 'judgment_id'
            ? `EXPLAIN QUERY PLAN SELECT r.judgment_id FROM memory_relations r JOIN memory ms ON ms.id = r.source_id JOIN memory mt ON mt.id = r.target_id
               WHERE r.status = 'pending' AND r.judgment_id > ? AND ms.scope = 'project' AND ms.project_id = ? AND mt.scope = 'project' AND mt.project_id = ?
               ORDER BY r.judgment_id LIMIT ?`
            : `EXPLAIN QUERY PLAN SELECT r.judgment_id FROM memory_relations r JOIN memory ms ON ms.id = r.source_id JOIN memory mt ON mt.id = r.target_id
               WHERE r.status = 'pending' AND (r.created_at, r.judgment_id) > (?, ?) AND ms.scope = 'project' AND ms.project_id = ? AND mt.scope = 'project' AND mt.project_id = ?
               ORDER BY r.created_at, r.judgment_id LIMIT ?`,
        )
        .all(
          ...(order === 'judgment_id'
            ? ['', probe.projectId, probe.projectId, 50]
            : [0, '', probe.projectId, probe.projectId, 50]),
        )
        .map((r: any) => r.detail)
        .join(' | ');
      const ids = P.pendingPairs(probe.handle, probe.projectId);
      const createdAt = new Map(
        raw
          .prepare(
            'SELECT judgment_id AS id, created_at AS at FROM memory_relations WHERE status = ?',
          )
          .all('pending')
          .map((r: any) => [r.id, r.at]),
      );
      const cells: string[] = [];
      for (const b of BATCHES) {
        const xs: number[] = [];
        for (let i = 0; i < 31; i += 1) {
          const p = ids[Math.floor((i / 31) * ids.length)]!;
          const cursor =
            order === 'judgment_id'
              ? p.judgmentId
              : `${createdAt.get(p.judgmentId)}|${p.judgmentId}`;
          const s = performance.now();
          sel.selectBatch(probe.projectId, cursor, b);
          xs.push(performance.now() - s);
        }
        cells.push(`B=${b} ${f3(P.quantile(xs, 0.5))}`);
      }
      out.push(
        `selection read, ${order} order (instrument: wall clock of one selection read, warm, median of 31 cursors): ${cells.join('  ')} ms`,
        `  plan: ${plan}`,
      );
    }
    const sameBatches = (() => {
      const a = P.createReads(probe.handle, 'judgment_id');
      const c = P.createReads(probe.handle, 'created_at');
      let ca: string | null = null;
      let cc: string | null = null;
      for (let i = 0; i < 40; i += 1) {
        const ba = a.selectBatch(probe.projectId, ca, 173);
        const bc = c.selectBatch(probe.projectId, cc, 173);
        if (ba.map((x) => x.judgmentId).join() !== bc.map((x) => x.judgmentId).join()) return false;
        ca = a.cursorOf(ba.at(-1)!);
        cc = c.cursorOf(bc.at(-1)!);
      }
      return true;
    })();
    out.push(
      `control: both orders return identical batches over 40 consecutive cursor steps of 173 rows (wrapping): ${sameBatches ? 'PASS' : 'FAIL'}`,
    );
    dispose(probe);

    const drainedSets = new Map<string, Set<string>>();
    for (const order of ORDERS) {
      out.push(
        `drain runs, ${order} order (instrument: wall clock of one drain run, performance.now, full evaluation of all channels incl. re-extraction when no stored entity is shared; warm = one untimed dry re-check of every pending pair first)`,
        `  ${'B'.padStart(5)} ${'runs'.padStart(5)} ${'median'.padStart(8)} ${'p90'.padStart(8)} ${'max'.padStart(8)} ${'ms/pair'.padStart(8)} ${'cold 1st'.padStart(9)} ${'all-write max'.padStart(14)}  (ms)`,
      );
      for (const b of BATCHES) {
        const cold = cloneOf(dir);
        const coldCtx = P.createContext(cold.handle, { reads: P.createReads(cold.handle, order) });
        const coldRun = P.runDrain(coldCtx, { projectId: cold.projectId, batch: b, cursor: null });
        dispose(cold);

        const c = cloneOf(dir);
        const ctx = P.createContext(c.handle, { reads: P.createReads(c.handle, order) });
        warm(ctx, c.projectId);
        const pass = P.drainOnePass(ctx, c.projectId, b);
        const full = pass.runs.filter((r: any) => r.examined === b);
        const ms = pass.runs.map((r: any) => r.ms);
        const perPair =
          full.length > 0
            ? full.reduce((n: number, r: any) => n + r.ms / r.examined, 0) / full.length
            : NaN;
        drainedSets.set(
          `${order}:${b}`,
          new Set(
            pass.decisions
              .filter((d: any) => d.verdict === 'drained')
              .map((d: any) => d.judgmentId),
          ),
        );
        if (order === 'judgment_id' && b === 200) {
          const mix = new Map<string, number>();
          for (const d of pass.decisions) {
            const k = `${d.verdict}:${d.check.admitted.join('+') || d.reason}`;
            mix.set(k, (mix.get(k) ?? 0) + 1);
          }
          decisionMix.push(
            `  ${size} memories, backlog ${backlog.label}: ${[...mix]
              .sort()
              .map(([k, n]) => `${k} ${n}`)
              .join(', ')}`,
          );
        }
        dispose(c);

        const w = cloneOf(dir);
        const wctx = P.createContext(w.handle, { reads: P.createReads(w.handle, order) });
        warm(wctx, w.projectId);
        let cursor: string | null = null;
        let worst = 0;
        for (let i = 0; i < 3; i += 1) {
          const r = P.runDrain(wctx, {
            projectId: w.projectId,
            batch: b,
            cursor,
            forceDrainForCost: true,
          });
          cursor = r.cursor;
          worst = Math.max(worst, r.ms);
        }
        dispose(w);
        out.push(
          `  ${P.pad(b, 5)} ${P.pad(pass.runs.length, 5)} ${P.pad(f1(P.quantile(ms, 0.5)), 8)} ${P.pad(f1(P.quantile(ms, 0.9)), 8)} ${P.pad(f1(Math.max(...ms)), 8)} ${P.pad(f3(perPair), 8)} ${P.pad(f1(coldRun.ms), 9)} ${P.pad(f1(worst), 14)}`,
        );
      }
    }
    const reference = drainedSets.get('judgment_id:200')!;
    const allEqual = [...drainedSets.values()].every(
      (s) => s.size === reference.size && [...s].every((id) => reference.has(id)),
    );
    out.push(
      `control: every B and both orders drain the identical set of ${reference.size} rows: ${allEqual ? 'PASS' : 'FAIL'}`,
    );

    if (backlog.label === '~5000') {
      const series = [
        { order: 'judgment_id' as const, b: 1000 },
        { order: 'created_at' as const, b: 1000 },
        { order: 'judgment_id' as const, b: 200 },
      ];
      for (const s of series) {
        const c = cloneOf(dir);
        const ctx = P.createContext(c.handle, { reads: P.createReads(c.handle, s.order) });
        warm(ctx, c.projectId);
        const start = P.pendingIds(c.handle, c.projectId);
        const pass = P.drainOnePass(ctx, c.projectId, s.b, { budgetMs: BUDGET_MS });
        const examinedIds = pass.runs.flatMap((r: any) =>
          r.decisions.map((d: any) => d.judgmentId),
        );
        const firstCycle = new Set(examinedIds.slice(0, start.length));
        const covered = start.every((id) => firstCycle.has(id)) && firstCycle.size === start.length;
        const drained = new Set(
          pass.decisions.filter((d: any) => d.verdict === 'drained').map((d: any) => d.judgmentId),
        );
        const sameDrained =
          drained.size === reference.size && [...drained].every((id) => reference.has(id));
        const stops = new Map<string, number>();
        for (const r of pass.runs) stops.set(r.stopReason, (stops.get(r.stopReason) ?? 0) + 1);
        const ms = pass.runs.map((r: any) => r.ms);
        const ex = pass.runs.map((r: any) => r.examined);
        out.push(
          `batching, ${s.order} order, B = ${s.b}, time budget ${BUDGET_MS} ms (instrument: wall clock of one drain run): ${pass.runs.length} runs for one pass over ${start.length} rows; stops ${[...stops].map(([k, n]) => `${k} ${n}`).join(', ')}`,
          `  examined per run min/median/max ${Math.min(...ex)}/${P.quantile(ex, 0.5)}/${Math.max(...ex)}; run ms median ${f1(P.quantile(ms, 0.5))}, WORST SINGLE RUN ${f1(Math.max(...ms))} ms`,
          `  first runs: ${pass.runs
            .slice(0, 4)
            .map((r: any) => `${r.examined}@${f1(r.ms)}ms/${r.stopReason}`)
            .join(', ')} … last: ${pass.runs
            .slice(-2)
            .map((r: any) => `${r.examined}@${f1(r.ms)}ms/${r.stopReason}`)
            .join(', ')}`,
          `  every row examined exactly once before the cursor wrapped: ${covered ? 'PASS' : 'FAIL'}; drained set identical to the unbudgeted pass (${drained.size} rows): ${sameDrained ? 'PASS' : 'FAIL'}`,
        );
        dispose(c);
      }

      for (const order of ORDERS) {
        for (const k of [2, 6]) {
          for (const shared of [false, true]) {
            const c = cloneOf(dir);
            const repos = P.db.createRepositories(c.handle.db);
            const slugs = [SCOPE_SLUG, 'vol-0', 'vol-1', 'vol-2', 'vol-3', 'vol-4'].slice(0, k);
            const ids = slugs.map((slug) => repos.projects.findBySlug(slug).id);
            const ctx = P.createContext(c.handle, { repos, reads: P.createReads(c.handle, order) });
            const cursors = new Map<string, string | null>(ids.map((id) => [id, null]));
            const callback = (): { ms: number; examined: number } => {
              if (shared) {
                const sw = P.runSweep(ctx, ids, { cap: SWEEP_CAP, budgetMs: BUDGET_MS, cursors });
                return {
                  ms: sw.ms,
                  examined: sw.runs.reduce((n: number, r: any) => n + r.examined, 0),
                };
              }
              const t = performance.now();
              let examined = 0;
              for (const id of ids) {
                const r = P.runDrain(ctx, {
                  projectId: id,
                  batch: SWEEP_CAP,
                  cursor: cursors.get(id)!,
                  budgetMs: BUDGET_MS,
                });
                cursors.set(id, r.cursor);
                examined += r.examined;
              }
              return { ms: performance.now() - t, examined };
            };
            callback();
            callback();
            const xs = Array.from({ length: 8 }, callback);
            const ms = xs.map((x) => x.ms);
            out.push(
              `sweep callback, ${k} scopes, ${order} order, B = ${SWEEP_CAP} per scope, ${shared ? `one ${BUDGET_MS} ms budget shared by the call (runSweep, design D7)` : `${BUDGET_MS} ms budget per scope`} (instrument: wall clock of one sweep callback running the drain step for every scope in sequence; 2 untimed callbacks first, 8 timed): median ${f1(P.quantile(ms, 0.5))} ms, max ${f1(Math.max(...ms))} ms, pairs examined per callback ${P.quantile(
                xs.map((x) => x.examined),
                0.5,
              )}`,
            );
            dispose(c);
          }
        }
      }

      const m = cloneOf(dir);
      const ctx = P.createContext(m.handle);
      warm(ctx, m.projectId);
      const pairs = P.pendingPairs(m.handle, m.projectId).slice(0, 2000);
      const t = { rows: 0, lexical: 0, vector: 0, entity: 0, extract: 0, write: 0 };
      for (const p of pairs) {
        let s = performance.now();
        const rows = ctx.reads.endpointRows(p.sourceId, p.targetId, P.DRAIN_MAX_PAIR_CHARS);
        t.rows += performance.now() - s;
        const a = rows.find((r: any) => r.id === p.sourceId);
        const b = rows.find((r: any) => r.id === p.targetId);
        s = performance.now();
        P.core.tokenContainment(
          P.core.tokenSet(a.content),
          P.core.tokenSet(`${b.title}\n\n${b.content}`),
        );
        t.lexical += performance.now() - s;
        s = performance.now();
        ctx.reads.pairCosineDistance(a.id, b.id);
        t.vector += performance.now() - s;
        s = performance.now();
        ctx.repos.entities.findEntitiesForMemories([a.id, b.id]);
        t.entity += performance.now() - s;
        s = performance.now();
        P.core.extractEntities(a.title, a.content);
        P.core.extractEntities(b.title, b.content);
        t.extract += performance.now() - s;
      }
      const runId = P.ulid(Date.now());
      ctx.repos.consolidation.insertRun({
        id: runId,
        startedAt: new Date(),
        scope: `project:${m.projectId}`,
      });
      const writes = pairs.slice(0, 500);
      for (const p of writes) {
        const s = performance.now();
        m.handle.db.transaction(() => {
          const updated = ctx.repos.relations.markOrphanedPending(p.judgmentId, {
            reason: 'cost probe',
            markedByKind: 'consolidator',
            judgedAt: new Date(),
          });
          if (updated) {
            P.ops.recordOrphanPromote(ctx.repos, {
              runId,
              judgmentId: p.judgmentId,
              sourceId: p.sourceId,
              targetId: p.targetId,
              relation: null,
              reasoning: 'cost probe',
            });
          }
        });
        t.write += performance.now() - s;
      }
      dispose(m);
      const n = pairs.length;
      out.push(
        `per-step cost (instrument: wall clock per call, warm, mean over ${n} pairs; write over ${writes.length}): read both rows ${f3(t.rows / n)} ms, lexical ${f3(t.lexical / n)} ms, pairwise cosine read ${f3(t.vector / n)} ms, stored entity read ${f3(t.entity / n)} ms, re-extraction of both endpoints ${f3(t.extract / n)} ms, orphan+journal transaction ${f3(t.write / writes.length)} ms`,
      );
    }
    out.push('');
  }
}
out.push(
  '## decision mix on the synthetic corpus (judgment_id order, B = 200) — context only, not a correctness result',
  ...decisionMix,
);
console.log(out.join('\n'));
