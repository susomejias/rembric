import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Embedder, loadEmbedder } from '../../embeddings/embedder.js';

import { CORPUS } from './corpus.js';
import { FLOOR_METRICS, ratchetFloors, type MetricFloors } from './floor-ratchet.js';
import { ingestCorpus, type Ingested } from './ingest.js';
import { QUERIES } from './queries.js';
import { writeReport, type RetrieverReport } from './report.js';
import { RETRIEVERS } from './retrievers/index.js';
import {
  aggregate,
  aggregateByType,
  ceilingFor,
  scoreQuery,
  tokensReturned,
  type QueryMetrics,
} from './scoring.js';
import type { IngestedCorpus, QueryItem, QueryScope, Retriever } from './types.js';

const K_VALUES = [5, 8] as const;
const MAX_K = 8;
const BASELINES_DIR = join(import.meta.dirname, 'baselines');
/** Absolute tolerance subtracted from a measured metric to set its committed floor. */
const FLOOR_TOLERANCE = 0.05;

function resolveScope(corpus: IngestedCorpus, fixture: QueryItem['scope']): QueryScope {
  if (fixture.scope === 'global') return { scope: 'global', projectId: null };
  const projectId = fixture.project ? corpus.projectIdBySlug.get(fixture.project) : undefined;
  if (!projectId) throw new Error(`queries.ts: unknown project slug '${fixture.project}'`);
  return { scope: 'project', projectId, includeGlobal: fixture.includeGlobal };
}

function resolveGold(corpus: IngestedCorpus, stableIds: string[]): string[] {
  return stableIds.map((sid) => {
    const id = corpus.idByStableId.get(sid);
    if (!id) throw new Error(`queries.ts: unknown gold stableId '${sid}'`);
    return id;
  });
}

interface RawOutcome {
  query: QueryItem;
  retrieved: string[];
  latencyMs: number;
  goldIds: string[];
}

async function runRetriever(retriever: Retriever, corpus: IngestedCorpus): Promise<RawOutcome[]> {
  const state = await retriever.init(corpus);
  const outcomes: RawOutcome[] = [];
  for (const q of QUERIES) {
    const scope = resolveScope(corpus, q.scope);
    const goldIds = resolveGold(corpus, q.goldStableIds);
    const start = performance.now();
    const retrieved = await retriever.query(q.text, state, MAX_K, scope);
    outcomes.push({ query: q, retrieved, latencyMs: performance.now() - start, goldIds });
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
        goldIds: o.goldIds,
        latencyMs: o.latencyMs,
        tokensReturned: tokensReturned(o.retrieved.slice(0, k), byId),
      }),
    );
    ceilingsByK[k] = new Map(withGold.map((o) => [o.query.id, ceilingFor(o.goldIds.length, k)]));
  }
  return { metricsByK, ceilingsByK };
}

async function evaluateAll(corpus: IngestedCorpus): Promise<RetrieverReport[]> {
  const reports: RetrieverReport[] = [];
  for (const retriever of RETRIEVERS) {
    const outcomes = await runRetriever(retriever, corpus);
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
  const byScope = new Map<string, number>([
    ['global', 0],
    ...[...projectSlugById.values()].map((slug) => [slug, 0] as const),
  ]);
  for (const item of corpus.items) {
    const key =
      item.scope === 'global'
        ? 'global'
        : (projectSlugById.get(item.projectId!) ?? item.projectId!);
    byScope.set(key, (byScope.get(key) ?? 0) + 1);
  }
  for (const [scope, count] of byScope) {
    if (count <= MAX_K)
      failures.push(
        `scope '${scope}' has only ${count} memories, want > k=${MAX_K} so the rank window binds`,
      );
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
}

function loadBaseline(name: string): Baseline | null {
  const path = join(BASELINES_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
}

function writeBaseline(report: RetrieverReport, opts: { allowLowering: boolean }): string[] {
  const measuredByK: Record<number, MetricFloors> = {};
  const ceilings: Baseline['ceilings'] = {};
  for (const k of K_VALUES) {
    const a = report.aggregateByK[k]!;
    measuredByK[k] = { precisionAtK: a.precisionAtK, recallAtK: a.recallAtK, mrr: a.mrr };
    ceilings[k] = {
      precisionAtK: a.ceilingPrecisionAtK,
      recallAtK: a.ceilingRecallAtK,
      mrr: 1,
    };
  }
  const { floors, notes } = ratchetFloors({
    label: report.retriever,
    measuredByK,
    previousByK: loadBaseline(report.retriever)?.floors,
    tolerance: FLOOR_TOLERANCE,
    allowLowering: opts.allowLowering,
  });
  const baseline: Baseline = {
    retriever: report.retriever,
    embeddingModelId: report.embeddingModelId,
    discriminatingMetric: report.discriminatingMetric,
    ceilings,
    floors,
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
    for (const k of K_VALUES) {
      const measured = report.aggregateByK[k]!;
      const floor = baseline.floors[k];
      if (!floor) continue;
      for (const metric of FLOOR_METRICS) {
        if (measured[metric] < floor[metric]) {
          failures.push(
            `${report.retriever}@${k} ${metric} regressed: ${measured[metric].toFixed(3)} < committed floor ${floor[metric].toFixed(3)}`,
          );
        }
      }
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const writeBaselines = process.argv.includes('--write-baselines');
  const allowLowering = process.argv.includes('--lower-floors');
  const skipDeterminism = process.argv.includes('--skip-determinism-check');

  console.log('rembric retrieval eval — loading embedder...');
  const embedder = await loadEmbedder();

  console.log(`ingesting ${CORPUS.length} corpus memories through MemoryService...`);
  const corpus: Ingested = await ingestCorpus(CORPUS, embedder);

  let failures: string[] = [];
  let reports: RetrieverReport[];
  try {
    reports = await evaluateAll(corpus);
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
      `${report.retriever.padEnd(16)} P@${MAX_K}=${p8.precisionAtK.toFixed(3)} R@${MAX_K}=${p8.recallAtK.toFixed(3)} MRR@${MAX_K}=${p8.mrr.toFixed(3)} tokens=${Math.round(p8.avgTokensReturned)} abstainFP=${p8.abstentionFalsePositiveRate?.toFixed(2) ?? 'n/a'}`,
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
