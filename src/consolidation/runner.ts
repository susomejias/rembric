import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { Db } from '../db/client.js';
import { consolidationRuns } from '../db/schema/consolidation.js';
import { memory } from '../db/schema/memory.js';
import { projects } from '../db/schema/projects.js';
import { type LlmClient, LlmError } from '../llm/index.js';
import type { EmbeddingWorker } from '../services/embedding-worker.js';
import type { RelationsService } from '../services/relations.js';

import type { ScopeKey } from './candidates.js';
import { findDecayCandidates, DEFAULT_DECAY, type DecayThresholds } from './decay.js';
import { judge } from './judge.js';
import { applyDecay, recordOrphanPromote } from './operations.js';

/**
 * Top-level consolidation orchestrator (v0.5).
 *
 * Two passes per scope:
 *
 *   1. Decay (deterministic, no LLM) — archive rows whose `last_seen_at`
 *      is older than the threshold and confidence is below the floor.
 *   2. Orphan promotion — fetch `memory_relations` rows with
 *      `status='pending'` and `created_at < (now - orphanAfterMs)`, run
 *      the existing LLM judge over the pair, translate the verdict back
 *      into a `RelationsService.judge(...)` call. Rows the LLM can't
 *      resolve transition to `status='orphaned'`.
 *
 * NOTE: redundancy / drift / contradiction LLM scans (v0.1) are GONE —
 * candidate detection moved to `memory.save`. The orphan-promotion pass
 * is the long-tail safety net for pairs the agent never judged.
 */

export interface ConsolidationRunnerOptions {
  db: Db;
  llm: LlmClient;
  model: string;
  batchSize?: number;
  decay?: DecayThresholds;
  /** Threshold for moving a pending judgment to orphan-promotion. */
  orphanAfterMs?: number;
  /** Required for the orphan-promotion pass. */
  relations: RelationsService;
  /** When false, decay still runs but the orphan-promotion pass is skipped. */
  llmEnabled?: boolean;
  /**
   * Optional embedding worker. When present, the runner drains pending
   * embeddings before each run so save-time candidate detection (on
   * future saves) has fresh vectors. The runner itself no longer queries
   * memory_vec.
   */
  embeddingWorker?: EmbeddingWorker | null;
}

export interface ConsolidationRunSummary {
  runs: ScopeRunResult[];
}

export interface ScopeRunResult {
  scope: ScopeKey;
  runId: string;
  ops: {
    archives: number;
    orphanPromoted: number;
    orphanFailed: number;
  };
}

const DEFAULT_ORPHAN_AFTER_MS = 86_400_000;
const DEFAULT_BATCH = 50;

export class ConsolidationRunner {
  constructor(private readonly opts: ConsolidationRunnerOptions) {}

  /** Run the consolidation once across the global scope and every project. */
  async runAll(): Promise<ConsolidationRunSummary> {
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
    const ops: ScopeRunResult['ops'] = { archives: 0, orphanPromoted: 0, orphanFailed: 0 };

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

    // 2. Orphan promotion (LLM judge on aged pending relations).
    if (this.opts.llmEnabled !== false) {
      const result = await this.promoteOrphans(runId, scope);
      ops.orphanPromoted += result.promoted;
      ops.orphanFailed += result.failed;
    }

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

  /**
   * Scan for pending relations older than the threshold whose source +
   * target both lie in `scope`. For each, run the LLM judge over the
   * pair; translate the verdict to a `relations.judge(...)` call. Pairs
   * the LLM can't resolve transition to `status='orphaned'`.
   */
  private async promoteOrphans(
    runId: string,
    scope: ScopeKey,
  ): Promise<{ promoted: number; failed: number }> {
    const batch = this.opts.batchSize ?? DEFAULT_BATCH;
    const cutoffMs = this.opts.orphanAfterMs ?? DEFAULT_ORPHAN_AFTER_MS;
    const pending = this.opts.relations.findPendingOlderThan(cutoffMs, batch);

    let promoted = 0;
    let failed = 0;

    for (const row of pending) {
      // Hydrate the (source, target) pair and assert it lies in scope.
      const a = this.opts.db
        .select()
        .from(memory)
        .where(sql`id = ${row.sourceId}`)
        .get();
      const b = this.opts.db
        .select()
        .from(memory)
        .where(sql`id = ${row.targetId}`)
        .get();
      if (!a || !b) {
        // One side disappeared; mark orphaned.
        try {
          this.opts.relations.orphan(row.judgmentId, 'source or target memory missing');
        } catch {
          // ignore
        }
        failed++;
        continue;
      }
      if (
        a.scope !== scope.scope ||
        (scope.scope === 'project' ? a.projectId !== scope.projectId : a.projectId !== null)
      ) {
        // Out of scope for this iteration — leave for the matching pass.
        continue;
      }

      try {
        const decision = await judge({
          client: this.opts.llm,
          model: this.opts.model,
          candidates: [a, b],
        });
        if (decision.decision === 'merge' || decision.decision === 'supersede') {
          // Translate consolidator verdicts to the relation taxonomy.
          // Both "merge" and "supersede" map to `supersedes` from
          // a → b (older row gets superseded).
          const winnerId =
            decision.decision === 'supersede' && decision.winnerId
              ? decision.winnerId
              : a.createdAt.getTime() >= b.createdAt.getTime()
                ? a.id
                : b.id;
          const sourceId = winnerId === row.sourceId ? row.sourceId : row.targetId;
          const targetId = sourceId === row.sourceId ? row.targetId : row.sourceId;

          if (sourceId === row.sourceId) {
            // Use the existing pending row.
            this.opts.relations.judge(row.judgmentId, {
              relation: 'supersedes',
              reason: `consolidator: ${decision.reasoning}`,
              confidence: 0.7,
              actor: 'consolidator',
              kind: 'consolidator',
            });
            recordOrphanPromote(this.opts.db, {
              consolidationId: runId,
              judgmentId: row.judgmentId,
              sourceId,
              targetId,
              relation: 'supersedes',
              reasoning: decision.reasoning,
            });
          } else {
            // The judge picked the opposite direction. Mark the
            // pending row orphaned, then record the verdict the other
            // way around via compare(). Keeps the FSM honest.
            this.opts.relations.orphan(row.judgmentId, 'verdict reversed direction');
            const fresh = this.opts.relations.compare({
              sourceId,
              targetId,
              relation: 'supersedes',
              reason: `consolidator: ${decision.reasoning}`,
              confidence: 0.7,
              actor: 'consolidator',
              kind: 'consolidator',
            });
            recordOrphanPromote(this.opts.db, {
              consolidationId: runId,
              judgmentId: fresh.judgmentId,
              sourceId,
              targetId,
              relation: 'supersedes',
              reasoning: `direction reversed; ${decision.reasoning}`,
            });
          }
          promoted++;
          continue;
        }
        if (decision.decision === 'keep_separate') {
          this.opts.relations.judge(row.judgmentId, {
            relation: 'not_conflict',
            reason: `consolidator: ${decision.reasoning}`,
            confidence: 0.8,
            actor: 'consolidator',
            kind: 'consolidator',
          });
          recordOrphanPromote(this.opts.db, {
            consolidationId: runId,
            judgmentId: row.judgmentId,
            sourceId: row.sourceId,
            targetId: row.targetId,
            relation: 'not_conflict',
            reasoning: decision.reasoning,
          });
          promoted++;
          continue;
        }
        // Malformed verdict → orphan.
        this.opts.relations.orphan(
          row.judgmentId,
          `unparseable verdict: ${String(decision.decision)}`,
        );
        recordOrphanPromote(this.opts.db, {
          consolidationId: runId,
          judgmentId: row.judgmentId,
          sourceId: row.sourceId,
          targetId: row.targetId,
          relation: null,
          reasoning: `unparseable verdict: ${String(decision.decision)}`,
        });
        failed++;
      } catch (err) {
        const reason =
          err instanceof LlmError
            ? `LLM error (${err.code}): ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        try {
          this.opts.relations.orphan(row.judgmentId, reason);
          recordOrphanPromote(this.opts.db, {
            consolidationId: runId,
            judgmentId: row.judgmentId,
            sourceId: row.sourceId,
            targetId: row.targetId,
            relation: null,
            reasoning: reason,
          });
        } catch {
          // ignore — the row may have transitioned concurrently.
        }
        failed++;
      }
    }
    return { promoted, failed };
  }
}
