import type { IngestedMemory, QueryType } from './types.js';

/** ~4 chars/token, the common English heuristic — good enough for a relative cost axis, not billing. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function tokensReturned(retrieved: string[], byId: Map<string, IngestedMemory>): number {
  let total = 0;
  for (const id of retrieved) {
    const m = byId.get(id);
    if (m) total += approxTokens(`${m.title}\n\n${m.content}`);
  }
  return total;
}

export interface QueryOutcome {
  queryId: string;
  type: QueryType;
  k: number;
  retrieved: string[];
  /** Project of each id in `retrieved`, same order. */
  retrievedProjectIds: string[];
  /** The project the query was issued against — a row outside it is foreign. */
  scopeProjectId: string;
  /** The query's own declaration, never inferred from the rows that came back. */
  widened: boolean;
  goldIds: string[];
  latencyMs: number;
  tokensReturned: number;
}

export interface QueryMetrics {
  queryId: string;
  type: QueryType;
  k: number;
  precisionAtK: number | null;
  recallAtK: number | null;
  reciprocalRank: number | null;
  abstained: boolean;
  widened: boolean;
  returnedRows: number;
  /** Rows outside the query's own project. Counted for every query, aggregated over the non-widened ones. */
  foreignRows: number;
  tokensReturned: number;
  latencyMs: number;
}

/** Arithmetic best case for a (non-empty) gold set of this size at this k — see design.md Decision 5 / task 2.5. */
export function ceilingFor(
  goldSize: number,
  k: number,
): { precisionAtK: number; recallAtK: number; mrr: number } {
  return {
    precisionAtK: Math.min(k, goldSize) / k,
    recallAtK: Math.min(k, goldSize) / goldSize,
    mrr: 1,
  };
}

export function scoreQuery(outcome: QueryOutcome): QueryMetrics {
  const { retrieved, goldIds, k } = outcome;
  const gold = new Set(goldIds);
  const top = retrieved.slice(0, k);
  const hits = top.filter((id) => gold.has(id)).length;

  let reciprocalRank: number | null = null;
  if (gold.size > 0) {
    const idx = top.findIndex((id) => gold.has(id));
    reciprocalRank = idx === -1 ? 0 : 1 / (idx + 1);
  }

  return {
    queryId: outcome.queryId,
    type: outcome.type,
    k,
    precisionAtK: gold.size > 0 ? hits / k : null,
    recallAtK: gold.size > 0 ? hits / gold.size : null,
    reciprocalRank,
    abstained: retrieved.length === 0,
    widened: outcome.widened,
    returnedRows: top.length,
    foreignRows: outcome.retrievedProjectIds
      .slice(0, k)
      .filter((projectId) => projectId !== outcome.scopeProjectId).length,
    tokensReturned: outcome.tokensReturned,
    latencyMs: outcome.latencyMs,
  };
}

export interface AggregateMetrics {
  k: number;
  /** Gold-bearing queries — the denominator of P/R/MRR and of `overAbstentionRate`. */
  n: number;
  /** Empty-gold queries — the denominator of `abstentionFalsePositiveRate`. */
  nAbstention: number;
  precisionAtK: number;
  recallAtK: number;
  mrr: number;
  ceilingPrecisionAtK: number;
  ceilingRecallAtK: number;
  /** Empty-gold queries that returned something. */
  abstentionFalsePositiveRate: number | null;
  /** Gold-bearing queries that returned nothing; folded into recall it is indistinguishable from a confidently wrong answer. */
  overAbstentionRate: number | null;
  /**
   * Rows returned from outside the query's own project, over rows returned, on
   * the queries that did NOT declare widening. An isolation gate rather than a
   * tuning bound: its committed cap is 0.
   */
  foreignScopeRate: number | null;
  /** Rows the rate above is a fraction of — its own denominator, and its non-vacuity control. */
  nForeignScopeRows: number;
  avgTokensReturned: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

function mean(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function aggregate(
  metrics: QueryMetrics[],
  ceilings: Map<string, { precisionAtK: number; recallAtK: number; mrr: number }>,
  k: number,
): AggregateMetrics {
  const scored = metrics.filter((m) => m.precisionAtK !== null);
  const abstentionQueries = metrics.filter((m) => m.precisionAtK === null);

  const ceilingsForScored = scored.map((m) => ceilings.get(m.queryId)!);

  const narrow = metrics.filter((m) => !m.widened);
  const narrowRows = narrow.reduce((acc, m) => acc + m.returnedRows, 0);
  const narrowForeignRows = narrow.reduce((acc, m) => acc + m.foreignRows, 0);

  return {
    k,
    n: scored.length,
    nAbstention: abstentionQueries.length,
    precisionAtK: mean(scored.map((m) => m.precisionAtK!)),
    recallAtK: mean(scored.map((m) => m.recallAtK!)),
    mrr: mean(scored.map((m) => m.reciprocalRank!)),
    ceilingPrecisionAtK: mean(ceilingsForScored.map((c) => c.precisionAtK)),
    ceilingRecallAtK: mean(ceilingsForScored.map((c) => c.recallAtK)),
    abstentionFalsePositiveRate:
      abstentionQueries.length === 0
        ? null
        : mean(abstentionQueries.map((m) => (m.abstained ? 0 : 1))),
    overAbstentionRate: scored.length === 0 ? null : mean(scored.map((m) => (m.abstained ? 1 : 0))),
    foreignScopeRate: narrowRows === 0 ? null : narrowForeignRows / narrowRows,
    nForeignScopeRows: narrowRows,
    avgTokensReturned: mean(metrics.map((m) => m.tokensReturned)),
    p50LatencyMs: percentile(
      metrics.map((m) => m.latencyMs),
      50,
    ),
    p95LatencyMs: percentile(
      metrics.map((m) => m.latencyMs),
      95,
    ),
  };
}

export function aggregateByType(
  metrics: QueryMetrics[],
  ceilings: Map<string, { precisionAtK: number; recallAtK: number; mrr: number }>,
  k: number,
): Record<string, AggregateMetrics> {
  const byType = new Map<string, QueryMetrics[]>();
  for (const m of metrics) {
    const list = byType.get(m.type) ?? [];
    list.push(m);
    byType.set(m.type, list);
  }
  const out: Record<string, AggregateMetrics> = {};
  for (const [type, list] of byType) out[type] = aggregate(list, ceilings, k);
  return out;
}
