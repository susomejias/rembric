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
