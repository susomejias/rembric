import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { Db } from '../db/client.js';
import { consolidationRuns } from '../db/schema/consolidation.js';
import { projects } from '../db/schema/projects.js';
import { type LlmClient, LlmError } from '../llm/index.js';
import type { EmbeddingWorker } from '../services/embedding-worker.js';

import {
  findContradictionCandidates,
  findDriftCandidates,
  findRedundancyCandidates,
  type CandidatePair,
  type ScopeKey,
} from './candidates.js';
import { findDecayCandidates, DEFAULT_DECAY, type DecayThresholds } from './decay.js';
import { judge } from './judge.js';
import { applyDecay, applyMerge, applySupersede, recordFailed, recordNoop } from './operations.js';

/**
 * Top-level consolidation orchestrator. For every (scope, project) tuple, it:
 *
 *   1. Runs the decay rule (no LLM) and applies a single archive op if any.
 *   2. Iterates redundancy / drift / contradiction candidate pairs, calls
 *      the LLM judge, and applies merge / supersede / noop atomically.
 *
 * The runner records one row in `consolidation_runs` per scope, plus one
 * `consolidation_ops` per applied operation (including noops and failures).
 */

export interface ConsolidationRunnerOptions {
  db: Db;
  llm: LlmClient;
  model: string;
  batchSize?: number;
  decay?: DecayThresholds;
  /** When false, decay still runs but LLM-driven detectors are skipped. */
  llmEnabled?: boolean;
  /**
   * Optional embedding worker. When present, the runner drains pending
   * embeddings before each run so the redundancy detector sees the latest
   * vector data.
   */
  embeddingWorker?: EmbeddingWorker | null;
}

export interface ConsolidationRunSummary {
  runs: ScopeRunResult[];
}

export interface ScopeRunResult {
  scope: ScopeKey;
  runId: string;
  ops: { merges: number; supersedes: number; archives: number; noops: number; failed: number };
}

export class ConsolidationRunner {
  constructor(private readonly opts: ConsolidationRunnerOptions) {}

  /** Run the consolidation once across the global scope and every project. */
  async runAll(): Promise<ConsolidationRunSummary> {
    // Drain pending embeddings so the redundancy detector sees fresh
    // vectors. Multiple passes because processBatch only takes one batch.
    if (this.opts.embeddingWorker) {
      for (let i = 0; i < 4; i++) {
        const { processed } = await this.opts.embeddingWorker.processBatch();
        if (processed === 0) break;
      }
    }

    const scopes: ScopeKey[] = [{ scope: 'global', projectId: null }];
    const projectRows = this.opts.db.select({ id: projects.id }).from(projects).all();
    for (const p of projectRows) scopes.push({ scope: 'project', projectId: p.id });

    const runs: ScopeRunResult[] = [];
    for (const scope of scopes) {
      runs.push(await this.runScope(scope));
    }
    return { runs };
  }

  async runScope(scope: ScopeKey): Promise<ScopeRunResult> {
    const now = new Date();
    const runId = ulid(now.getTime());
    const ops = { merges: 0, supersedes: 0, archives: 0, noops: 0, failed: 0 };

    this.opts.db
      .insert(consolidationRuns)
      .values({
        id: runId,
        startedAt: now,
        llmProvider: 'openai-compatible',
        llmModel: this.opts.model,
        scope: scope.scope === 'global' ? 'global' : `project:${scope.projectId ?? ''}`,
      })
      .run();

    // 1. Decay (deterministic, no LLM).
    const decayIds = findDecayCandidates(
      this.opts.db,
      scope,
      this.opts.decay ?? DEFAULT_DECAY,
      now,
    );
    if (decayIds.length > 0) {
      applyDecay(this.opts.db, {
        consolidationId: runId,
        ids: decayIds,
        reasoning: `last_seen_at older than ${(this.opts.decay ?? DEFAULT_DECAY).thresholdMs}ms with low confidence`,
      });
      ops.archives++;
    }

    if (this.opts.llmEnabled !== false) {
      const limit = this.opts.batchSize ?? 50;

      const redundancy = findRedundancyCandidates(this.opts.db, { scope, limit });
      for (const pair of redundancy) {
        await this.processPair(runId, pair, ops);
      }

      const drift = findDriftCandidates(this.opts.db, { scope, limit });
      for (const pair of drift) {
        await this.processPair(runId, pair, ops);
      }

      const contradictions = findContradictionCandidates(this.opts.db, { scope, limit });
      for (const pair of contradictions) {
        await this.processPair(runId, pair, ops);
      }
    }

    // Close the run row.
    this.opts.db
      .update(consolidationRuns)
      .set({
        finishedAt: new Date(),
        summary: JSON.stringify(ops),
      })
      .where(sql`id = ${runId}`)
      .run();

    return { scope, runId, ops };
  }

  private async processPair(
    runId: string,
    pair: CandidatePair,
    counters: ScopeRunResult['ops'],
  ): Promise<void> {
    // Skip if either side is no longer active (a prior op may have moved it).
    if (pair.a.status !== 'active' || pair.b.status !== 'active') return;

    try {
      const decision = await judge({
        client: this.opts.llm,
        model: this.opts.model,
        candidates: [pair.a, pair.b],
      });

      if (decision.decision === 'keep_separate') {
        recordNoop(this.opts.db, {
          consolidationId: runId,
          affectedIds: [pair.a.id, pair.b.id],
          reasoning: decision.reasoning,
        });
        counters.noops++;
        return;
      }

      if (decision.decision === 'merge' && decision.mergedContent) {
        applyMerge(this.opts.db, {
          consolidationId: runId,
          predecessors: [pair.a, pair.b],
          mergedContent: decision.mergedContent,
          reasoning: decision.reasoning,
        });
        counters.merges++;
        return;
      }

      if (decision.decision === 'supersede' && decision.winnerId) {
        const winner = decision.winnerId === pair.a.id ? pair.a : pair.b;
        const loser = decision.winnerId === pair.a.id ? pair.b : pair.a;
        applySupersede(this.opts.db, {
          consolidationId: runId,
          winner,
          losers: [loser],
          reasoning: decision.reasoning,
        });
        counters.supersedes++;
        return;
      }

      // Decision shape valid but missing required field (mergedContent /
      // winnerId): treat as failed for journaling.
      recordFailed(this.opts.db, {
        consolidationId: runId,
        affectedIds: [pair.a.id, pair.b.id],
        reasoning: `decision '${decision.decision}' missing required field`,
      });
      counters.failed++;
    } catch (err) {
      const reason =
        err instanceof LlmError
          ? `LLM error (${err.code}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      recordFailed(this.opts.db, {
        consolidationId: runId,
        affectedIds: [pair.a.id, pair.b.id],
        reasoning: reason,
      });
      counters.failed++;
    }
  }
}
