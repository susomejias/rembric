import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Embedder, loadEmbedder } from '../../embeddings/embedder.js';
import { type GateLeader } from '../../services/hybrid-search.js';

import { checkAbstentionFlags } from './abstention-flags.js';
import { CORPUS } from './corpus.js';
import {
  checkBounds,
  ratchetCaps,
  ratchetFloors,
  type MetricCaps,
  type MetricFloors,
} from './floor-ratchet.js';
import { ingestCorpus, type Ingested } from './ingest.js';
import { QUERIES } from './queries.js';
import { writeReport, type RetrieverReport } from './report.js';
import { resolveGold, resolveScope } from './resolve.js';
import { RETRIEVERS } from './retrievers/index.js';
import {
  aggregate,
  aggregateByType,
  ceilingFor,
  scoreQuery,
  tokensReturned,
  type QueryMetrics,
} from './scoring.js';
import type { GateSetting, IngestedCorpus, RawOutcome, Retriever } from './types.js';

const K_VALUES = [5, 8] as const;
const MAX_K = 8;
const BASELINES_DIR = join(import.meta.dirname, 'baselines');
/** Absolute tolerance subtracted from a measured metric to set its committed floor. */
const FLOOR_TOLERANCE = 0.05;

async function runRetriever(
  retriever: Retriever,
  corpus: IngestedCorpus,
  gates?: GateSetting,
): Promise<RawOutcome[]> {
  const state = await retriever.init(corpus);
  const outcomes: RawOutcome[] = [];
  for (const q of QUERIES) {
    const scope = resolveScope(corpus, q);
    const goldIds = resolveGold(corpus, q.goldStableIds);
    const start = performance.now();
    const outcome = await retriever.query(q.text, state, MAX_K, scope, gates);
    outcomes.push({
      query: q,
      retrieved: outcome.ids,
      scope,
      reportedAbstained: outcome.abstained,
      latencyMs: performance.now() - start,
      goldIds,
    });
  }
  await retriever.teardown?.(state);
  return outcomes;
}

function scoreOutcomes(
  outcomes: RawOutcome[],
  corpus: IngestedCorpus,
): {
  metricsByK: Record<number, QueryMetrics[]>;
  ceilingsByK: Record<number, Map<string, ReturnType<typeof ceilingFor>>>;
} {
  const byId = new Map(corpus.items.map((m) => [m.id, m]));
  const withGold = outcomes.filter((o) => o.goldIds.length > 0);
  const metricsByK: Record<number, QueryMetrics[]> = {};
  const ceilingsByK: Record<number, Map<string, ReturnType<typeof ceilingFor>>> = {};
  for (const k of K_VALUES) {
    metricsByK[k] = outcomes.map((o) =>
      scoreQuery({
        queryId: o.query.id,
        type: o.query.type,
        k,
        retrieved: o.retrieved.slice(0, k),
        // A retrieved id the corpus does not know is not silently treated as
        // home: it is the shape a leak from outside the corpus would take.
        retrievedProjectIds: o.retrieved.slice(0, k).map((id) => byId.get(id)?.projectId ?? id),
        scopeProjectId: o.scope.projectId,
        widened: o.query.widened === true,
        goldIds: o.goldIds,
        latencyMs: o.latencyMs,
        tokensReturned: tokensReturned(o.retrieved.slice(0, k), byId),
      }),
    );
    ceilingsByK[k] = new Map(withGold.map((o) => [o.query.id, ceilingFor(o.goldIds.length, k)]));
  }
  return { metricsByK, ceilingsByK };
}

async function evaluateAll(
  corpus: IngestedCorpus,
  flagFailures?: string[],
): Promise<RetrieverReport[]> {
  const reports: RetrieverReport[] = [];
  for (const retriever of RETRIEVERS) {
    const outcomes = await runRetriever(retriever, corpus);
    flagFailures?.push(...checkAbstentionFlags(retriever.name, outcomes));
    const { metricsByK, ceilingsByK } = scoreOutcomes(outcomes, corpus);
    const aggregateByK: Record<number, ReturnType<typeof aggregate>> = {};
    const aggregateByTypeByK: Record<number, Record<string, ReturnType<typeof aggregate>>> = {};
    for (const k of K_VALUES) {
      aggregateByK[k] = aggregate(metricsByK[k]!, ceilingsByK[k]!, k);
      aggregateByTypeByK[k] = aggregateByType(metricsByK[k]!, ceilingsByK[k]!, k);
    }
    reports.push({
      retriever: retriever.name,
      discriminatingMetric: retriever.discriminatingMetric,
      generatedAt: new Date().toISOString(),
      embeddingModelId: corpus.embeddingModelId,
      perQuery: K_VALUES.flatMap((k) => metricsByK[k]!),
      aggregateByK,
      aggregateByTypeByK,
    });
  }
  return reports;
}

function checkSanity(corpus: IngestedCorpus, reports: RetrieverReport[]): string[] {
  const failures: string[] = [];

  if (corpus.items.length < 30) {
    failures.push(
      `corpus has only ${corpus.items.length} active memories, want >= 30 (design.md risk: corpus size)`,
    );
  }
  const projectSlugById = new Map([...corpus.projectIdBySlug].map(([slug, id]) => [id, slug]));
  const byScope = new Map<string, number>(
    [...projectSlugById.values()].map((slug) => [slug, 0] as const),
  );
  for (const item of corpus.items) {
    const key = projectSlugById.get(item.projectId) ?? item.projectId;
    byScope.set(key, (byScope.get(key) ?? 0) + 1);
  }
  for (const [scope, count] of byScope) {
    if (count <= MAX_K)
      failures.push(
        `scope '${scope}' has only ${count} memories, want > k=${MAX_K} so the rank window binds`,
      );
  }

  // A cap of 0 is satisfied by an empty result set, so the denominator is
  // asserted beside it — the same non-vacuity control the widening tests carry.
  for (const report of reports) {
    for (const k of K_VALUES) {
      const rows = report.aggregateByK[k]!.nForeignScopeRows;
      if (rows === 0)
        failures.push(
          `${report.retriever}@${k} scored foreignScopeRate over 0 returned rows — the cap would pass vacuously`,
        );
    }
  }

  const hybrid = reports.find((r) => r.retriever === 'hybrid');
  const grep = reports.find((r) => r.retriever === 'grep');
  if (hybrid && grep) {
    const hybridRecall = hybrid.aggregateByK[MAX_K]!.recallAtK;
    const grepRecall = grep.aggregateByK[MAX_K]!.recallAtK;
    if (hybridRecall <= grepRecall) {
      failures.push(
        `hybrid recall@${MAX_K} (${hybridRecall.toFixed(3)}) does not beat grep (${grepRecall.toFixed(3)}) — the corpus does not discriminate, or fusion is not earning its complexity`,
      );
    }
  }

  return failures;
}

/** Re-ingests + re-evaluates once more and diffs against `reportsA` (the caller's own already-computed pass) — one fresh run, not two. */
async function checkDeterminism(
  embedder: Embedder,
  reportsA: RetrieverReport[],
): Promise<string | null> {
  const runB = await ingestCorpus(CORPUS, embedder);
  let reportsB: RetrieverReport[];
  try {
    reportsB = await evaluateAll(runB);
  } finally {
    runB.cleanup();
  }

  const strip = (reports: RetrieverReport[]) =>
    JSON.stringify(
      reports.map((r) => ({
        retriever: r.retriever,
        perQuery: r.perQuery.map(({ latencyMs: _latencyMs, ...rest }) => rest),
        aggregateByK: Object.fromEntries(
          Object.entries(r.aggregateByK).map(([k, a]) => [
            k,
            { ...a, p50LatencyMs: undefined, p95LatencyMs: undefined },
          ]),
        ),
      })),
    );

  return strip(reportsA) === strip(reportsB)
    ? null
    : 'two eval runs on unchanged inputs disagree on a non-latency metric — the harness is not deterministic';
}

interface Baseline {
  retriever: string;
  embeddingModelId: string;
  /** design.md Decision 5 — states its own ceiling so a saturated metric is never reported as a triumph. */
  discriminatingMetric: string;
  ceilings: Record<number, MetricFloors>;
  floors: Record<number, MetricFloors>;
  /**
   * Lower-is-better metrics, stored apart from `floors` so the two can never be
   * compared in the wrong direction. A run fails when a measured value rises
   * ABOVE its cap.
   */
  caps: Record<number, MetricCaps>;
}

function loadBaseline(name: string): Baseline | null {
  const path = join(BASELINES_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
}

function writeBaseline(report: RetrieverReport, opts: { allowLowering: boolean }): string[] {
  const measuredByK: Record<number, MetricFloors> = {};
  const measuredCapsByK: Record<number, MetricCaps> = {};
  const ceilings: Baseline['ceilings'] = {};
  for (const k of K_VALUES) {
    const a = report.aggregateByK[k]!;
    measuredByK[k] = { precisionAtK: a.precisionAtK, recallAtK: a.recallAtK, mrr: a.mrr };
    measuredCapsByK[k] = {
      abstentionFalsePositiveRate: a.abstentionFalsePositiveRate ?? 0,
      overAbstentionRate: a.overAbstentionRate ?? 0,
      foreignScopeRate: a.foreignScopeRate ?? 0,
    };
    ceilings[k] = {
      precisionAtK: a.ceilingPrecisionAtK,
      recallAtK: a.ceilingRecallAtK,
      mrr: 1,
    };
  }
  const previous = loadBaseline(report.retriever);
  const { floors, notes } = ratchetFloors({
    label: report.retriever,
    measuredByK,
    previousByK: previous?.floors,
    tolerance: FLOOR_TOLERANCE,
    allowLowering: opts.allowLowering,
  });
  // One query's worth of headroom on each axis, from the committed query set's
  // own denominators, so the caps stay one-query-tight as the set grows.
  const anyK = report.aggregateByK[MAX_K]!;
  const { caps, notes: capNotes } = ratchetCaps({
    label: report.retriever,
    measuredByK: measuredCapsByK,
    previousByK: previous?.caps,
    headroomByMetric: {
      abstentionFalsePositiveRate: anyK.nAbstention > 0 ? 1 / anyK.nAbstention : 0,
      overAbstentionRate: anyK.n > 0 ? 1 / anyK.n : 0,
      // Zero, not one row's worth of its own denominator (1/nForeignScopeRows):
      // the other two are tuning bounds where one query going the wrong way is
      // measurement noise, and this one is an isolation gate where one row is
      // the defect.
      foreignScopeRate: 0,
    },
    allowLoosening: opts.allowLowering,
  });
  notes.push(...capNotes);
  const baseline: Baseline = {
    retriever: report.retriever,
    embeddingModelId: report.embeddingModelId,
    discriminatingMetric: report.discriminatingMetric,
    ceilings,
    floors,
    caps,
  };
  writeFileSync(
    join(BASELINES_DIR, `${report.retriever}.json`),
    JSON.stringify(baseline, null, 2) + '\n',
  );
  return notes;
}

function checkFloors(reports: RetrieverReport[]): string[] {
  const failures: string[] = [];
  for (const report of reports) {
    const baseline = loadBaseline(report.retriever);
    if (!baseline) {
      failures.push(
        `no committed baseline for '${report.retriever}' — run with --write-baselines once to seed it`,
      );
      continue;
    }
    failures.push(
      ...checkBounds({
        label: report.retriever,
        ks: K_VALUES,
        measuredByK: Object.fromEntries(K_VALUES.map((k) => [k, report.aggregateByK[k]!] as const)),
        floorsByK: baseline.floors,
        capsByK: baseline.caps,
      }),
    );
  }
  return failures;
}

/**
 * The committed calibration grid. `null` on either axis is the shipped
 * (disabled) value and is included so the grid always contains its own control.
 * Steps are uniform so "two grid steps wide" in the acceptance bar
 * (memory/spec.md) is a well-defined distance.
 */
const SWEEP_FLOORS: (number | null)[] = [null, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
/**
 * `0` keeps every row the filter sees, so it is the control that separates "the
 * ratio changed the page" from "levelling the pool at all did". The gate now
 * levels the WHOLE fused pool, so `0` and `null` must agree on every metric;
 * a row where they do not is a defect in the level path, not a calibration
 * finding.
 */
const SWEEP_RATIOS: (number | null)[] = [null, 0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

const fmt = (v: number | null, digits = 3) => (v === null ? 'n/a' : v.toFixed(digits));

/**
 * Runs the production hybrid retriever over the committed grid. Deterministic:
 * no latency is printed and every value is a function of corpus, query set and
 * grid point alone.
 */
async function sweepAbstention(corpus: IngestedCorpus): Promise<void> {
  const hybrid = RETRIEVERS.find((r) => r.name === 'hybrid');
  if (!hybrid) throw new Error('the sweep needs the hybrid retriever');

  console.log('\n=== pool leader components, per query (gates disabled) ===');
  console.log('query'.padEnd(38), 'gold', ' pool', 'level', 'coverage', 'cosine', '   N');
  const state = await hybrid.init(corpus);
  const leaders: { id: string; hasGold: boolean; level: number; poolSize: number }[] = [];
  // The weights, not just the levels: without them a reader cannot tell a level
  // that moved because the row changed from one that moved because the corpus did.
  const termStats: string[] = [];
  for (const q of QUERIES) {
    const scope = resolveScope(corpus, q);
    let leader: GateLeader | undefined;
    await hybrid.query(q.text, state, MAX_K, scope, {
      abstentionFloor: null,
      relativeLevelRatio: null,
      onGateWindow: (l) => {
        leader = l;
      },
    });
    const hasGold = q.goldStableIds.length > 0;
    leaders.push({ id: q.id, hasGold, level: leader?.level ?? 0, poolSize: leader?.poolSize ?? 0 });
    console.log(
      q.id.padEnd(38),
      hasGold ? ' yes' : '  no',
      String(leader?.poolSize ?? 0).padStart(5),
      fmt(leader?.level ?? 0),
      fmt(leader?.coverage ?? 0).padStart(8),
      fmt(leader?.cosine ?? 0).padStart(6),
      String(leader?.documentCount ?? 0).padStart(4),
    );
    // The index's own terms, in the order the read reported them: printing a
    // JS-tokenised list here would show terms the weighting never looked up.
    const dfs = [...(leader?.documentFrequencies.entries() ?? [])]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      // `—`, not 0: the index reported no such term, which carries the MAXIMUM
      // weight — a corpus cannot answer a term it does not hold.
      .map(([term, df]) => `${term}=${df ?? '—'}`)
      .join(' ');
    termStats.push(`${q.id.padEnd(38)} N=${leader?.documentCount ?? 0}  df: ${dfs}`);
  }
  console.log('\n=== term statistics behind each leading level ===');
  console.log(
    'df is the document count over the WHOLE index; `—` means the index does not hold the term.',
  );
  for (const line of termStats) console.log(line);
  // The gate covers the whole fused pool, so every query observes both
  // mechanisms regardless of page size — the grid below is evidence for all of
  // them, not just for the ones whose pool outgrew a prefix.
  const pools = leaders.map((l) => l.poolSize);
  console.log(
    `fused pool per query: min ${Math.min(...pools)}, max ${Math.max(...pools)} — ` +
      'gated in full, so no query is a no-op for the ratio',
  );
  await hybrid.teardown?.(state);

  // Whether ANY floor can work is a separability question, and it is decided by
  // these two ordered lists rather than by the grid: a floor exists iff the
  // highest abstention level is below the lowest gold-bearing one.
  const goldLevels = leaders
    .filter((l) => l.hasGold)
    .map((l) => l.level)
    .sort((a, b) => a - b);
  const abstainLevels = leaders
    .filter((l) => !l.hasGold)
    .map((l) => l.level)
    .sort((a, b) => b - a);
  console.log('\n=== level separability ===');
  console.log(`gold-bearing, ascending : ${goldLevels.map((v) => fmt(v)).join(' ')}`);
  console.log(`abstention,  descending : ${abstainLevels.map((v) => fmt(v)).join(' ')}`);
  const lowestGold = goldLevels[0] ?? 0;
  const highestAbstain = abstainLevels[0] ?? 0;
  console.log(
    `lowest gold-bearing = ${fmt(lowestGold)}, highest abstention = ${fmt(highestAbstain)} -> ` +
      (highestAbstain < lowestGold
        ? `separable, admissible floors are (${fmt(highestAbstain)}, ${fmt(lowestGold)}], width ${fmt(lowestGold - highestAbstain)}`
        : `NOT separable: the classes overlap on [${fmt(lowestGold)}, ${fmt(highestAbstain)}], so no floor abstains on every empty-gold query without rejecting a gold-bearing one`),
  );
  console.log(
    `overlapping abstention queries: ${leaders
      .filter((l) => !l.hasGold && l.level >= lowestGold)
      .map((l) => `${l.id}=${fmt(l.level)}`)
      .join(', ')}`,
  );

  console.log('\n=== (floor, ratio) grid ===');
  const header = [
    'floor',
    'ratio',
    'k',
    'recall',
    'precision',
    'mrr',
    'abstainFP',
    'overAbstain',
    'tokens',
  ];
  console.log(header.map((h) => h.padStart(12)).join(''));
  for (const floor of SWEEP_FLOORS) {
    for (const ratio of SWEEP_RATIOS) {
      const outcomes = await runRetriever(hybrid, corpus, {
        abstentionFloor: floor,
        relativeLevelRatio: ratio,
      });
      const flagFailures = checkAbstentionFlags('hybrid', outcomes);
      const { metricsByK, ceilingsByK } = scoreOutcomes(outcomes, corpus);
      for (const k of K_VALUES) {
        const a = aggregate(metricsByK[k]!, ceilingsByK[k]!, k);
        console.log(
          [
            fmt(floor, 2),
            fmt(ratio, 2),
            String(k),
            fmt(a.recallAtK),
            fmt(a.precisionAtK),
            fmt(a.mrr),
            fmt(a.abstentionFalsePositiveRate),
            fmt(a.overAbstentionRate),
            String(Math.round(a.avgTokensReturned)),
          ]
            .map((c) => c.padStart(11))
            .join(''),
        );
      }
      for (const f of flagFailures) console.log(`  FLAG DISAGREEMENT: ${f}`);
    }
  }

  console.log(`\ncorpus: ${corpus.items.length} active memories, ${QUERIES.length} queries`);
  console.log(
    `abstention queries: ${QUERIES.filter((q) => q.goldStableIds.length === 0).length} (metric step ${(1 / QUERIES.filter((q) => q.goldStableIds.length === 0).length).toFixed(3)})`,
  );
}

async function main(): Promise<void> {
  const writeBaselines = process.argv.includes('--write-baselines');
  const allowLowering = process.argv.includes('--lower-floors');
  const skipDeterminism = process.argv.includes('--skip-determinism-check');
  const sweep = process.argv.includes('--sweep-abstention');

  if (sweep) {
    console.log('rembric abstention calibration sweep — loading embedder...');
    const embedder = await loadEmbedder();
    console.log(`ingesting ${CORPUS.length} corpus memories through MemoryService...`);
    const corpus: Ingested = await ingestCorpus(CORPUS, embedder);
    try {
      await sweepAbstention(corpus);
    } finally {
      corpus.cleanup();
    }
    return;
  }

  console.log('rembric retrieval eval — loading embedder...');
  const embedder = await loadEmbedder();

  console.log(`ingesting ${CORPUS.length} corpus memories through MemoryService...`);
  const corpus: Ingested = await ingestCorpus(CORPUS, embedder);

  let failures: string[] = [];
  let reports: RetrieverReport[];
  try {
    reports = await evaluateAll(corpus, failures);
    failures = failures.concat(checkSanity(corpus, reports));
  } finally {
    const dataDir = corpus.dataDir;
    corpus.cleanup();
    if (existsSync(dataDir))
      failures.push(`isolation violated: ${dataDir} still exists after cleanup()`);
  }

  writeReport(reports);

  for (const report of reports) {
    const p8 = report.aggregateByK[MAX_K]!;
    console.log(
      `${report.retriever.padEnd(16)} P@${MAX_K}=${p8.precisionAtK.toFixed(3)} R@${MAX_K}=${p8.recallAtK.toFixed(3)} MRR@${MAX_K}=${p8.mrr.toFixed(3)} tokens=${Math.round(p8.avgTokensReturned)} abstainFP=${p8.abstentionFalsePositiveRate?.toFixed(2) ?? 'n/a'} overAbstain=${p8.overAbstentionRate?.toFixed(2) ?? 'n/a'} foreignScope=${p8.foreignScopeRate?.toFixed(3) ?? 'n/a'} (over ${p8.nForeignScopeRows} rows)`,
    );
  }

  if (writeBaselines) {
    const notes = reports.flatMap((report) => writeBaseline(report, { allowLowering }));
    console.log(`wrote baselines to ${BASELINES_DIR}`);
    for (const n of notes) console.log(`  ${n}`);
    return;
  }

  failures = failures.concat(checkFloors(reports));

  if (!skipDeterminism) {
    const determinismFailure = await checkDeterminism(embedder, reports);
    if (determinismFailure) failures.push(determinismFailure);
  }

  if (failures.length > 0) {
    console.error('\nrembric retrieval eval FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nrembric retrieval eval passed.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
