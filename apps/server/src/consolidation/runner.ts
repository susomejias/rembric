import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { Db } from '../db/client.js';
import { consolidationRuns } from '../db/schema/consolidation.js';
import { memory } from '../db/schema/memory.js';
import { projects } from '../db/schema/projects.js';
import type { RelationsService } from '../services/relations.js';

import type { ScopeKey } from './candidates.js';
import { findDecayCandidates, DEFAULT_DECAY, type DecayThresholds } from './decay.js';
import { applyDecay, recordOrphanPromote } from './operations.js';

/**
 * Deterministic consolidation sweep (change `remove-llm-consolidation`).
 *
 * Two passes per scope, no LLM anywhere:
 *
 *   1. Decay — archive rows whose `last_seen_at` is older than the
 *      threshold and confidence is below the floor.
 *   2. Deadline orphaning — `memory_relations` rows still 'pending' after
 *      `orphanDeadlineMs` transition to 'orphaned' (journaled, undoable).
 *      Between `JUDGMENT_ORPHAN_AFTER_MS` and the deadline they are
 *      re-exposed to agents via `memory.context.pendingJudgments[]` for
 *      fresh-context judgment via `memory.judge`.
 *
 * Triggered lazily on session start (throttled per scope) and manually
 * via `POST /admin/consolidation/run` (force). There is no cron.
 */

export interface ConsolidationRunnerOptions {
  db: Db;
  relations: RelationsService;
  decay?: DecayThresholds;
  /** Pending relations older than this are orphaned by the sweep. */
  orphanDeadlineMs?: number;
  /** Per-scope throttle window; sweeps within it are skipped unless forced. */
  minIntervalMs?: number;
}

export interface ConsolidationRunSummary {
  runs: ScopeRunResult[];
  skipped: ScopeKey[];
}

export interface ScopeRunResult {
  scope: ScopeKey;
  runId: string;
  ops: {
    archives: number;
    orphaned: number;
  };
}

const DEFAULT_ORPHAN_DEADLINE_MS = 14 * 86_400_000;
export const DEFAULT_MIN_INTERVAL_MS = 6 * 3_600_000;
const ORPHAN_BATCH = 50;

export class ConsolidationRunner {
  constructor(private readonly opts: ConsolidationRunnerOptions) {}

  /** Sweep the global scope and every project. Manual trigger passes force. */
  runAll(opts?: { force?: boolean }): ConsolidationRunSummary {
    const scopes: ScopeKey[] = [{ scope: 'global', projectId: null }];
    const projectRows = this.opts.db.select({ id: projects.id }).from(projects).all();
    for (const p of projectRows) scopes.push({ scope: 'project', projectId: p.id });
    return this.sweep(scopes, opts);
  }

  /**
   * Lazy entry point for session start: sweep the session's scope plus
   * global (global hygiene would otherwise starve — the HTTP session
   * path is always project-scoped).
   */
  sweepFor(projectId: string | null): ConsolidationRunSummary {
    const scopes: ScopeKey[] = [{ scope: 'global', projectId: null }];
    if (projectId !== null) scopes.push({ scope: 'project', projectId });
    return this.sweep(scopes);
  }

  private sweep(scopes: ScopeKey[], opts?: { force?: boolean }): ConsolidationRunSummary {
    const runs: ScopeRunResult[] = [];
    const skipped: ScopeKey[] = [];
    for (const scope of scopes) {
      if (!opts?.force && this.recentlySwept(scope)) {
        skipped.push(scope);
        continue;
      }
      runs.push(this.runScope(scope));
    }
    return { runs, skipped };
  }

  private recentlySwept(scope: ScopeKey, now: Date = new Date()): boolean {
    const scopeStr = scopeString(scope);
    const cutoff = new Date(now.getTime() - (this.opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS));
    const recent = this.opts.db
      .select({ id: consolidationRuns.id })
      .from(consolidationRuns)
      .where(sql`scope = ${scopeStr} AND started_at > ${cutoff.getTime()}`)
      .limit(1)
      .get();
    return recent !== undefined;
  }

  runScope(scope: ScopeKey): ScopeRunResult {
    const now = new Date();
    const runId = ulid(now.getTime());
    const ops: ScopeRunResult['ops'] = { archives: 0, orphaned: 0 };

    this.opts.db
      .insert(consolidationRuns)
      .values({
        id: runId,
        startedAt: now,
        scope: scopeString(scope),
      })
      .run();

    // 1. Decay.
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
      ops.archives = decayIds.length;
    }

    // 2. Deadline orphaning.
    ops.orphaned = this.orphanExpired(runId, scope);

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
   * Orphan pending relations older than the deadline whose source +
   * target both lie in `scope`. Rows whose memories disappeared are
   * orphaned regardless of scope match (nothing left to judge).
   */
  private orphanExpired(runId: string, scope: ScopeKey): number {
    const deadlineMs = this.opts.orphanDeadlineMs ?? DEFAULT_ORPHAN_DEADLINE_MS;
    const pending = this.opts.relations.findPendingOlderThan(deadlineMs, ORPHAN_BATCH);

    let orphaned = 0;
    for (const row of pending) {
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

      let reason: string | null = null;
      if (!a || !b) {
        reason = 'source or target memory missing';
      } else if (
        a.scope === scope.scope &&
        (scope.scope === 'project' ? a.projectId === scope.projectId : a.projectId === null)
      ) {
        reason = `unjudged after ${deadlineMs}ms deadline`;
      } else {
        // Out of scope for this iteration — left for the matching pass.
        continue;
      }

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
        orphaned++;
      } catch {
        // The row may have transitioned concurrently (e.g. a late
        // memory.judge); skip it.
      }
    }
    return orphaned;
  }
}

function scopeString(scope: ScopeKey): string {
  return scope.scope === 'global' ? 'global' : `project:${scope.projectId ?? ''}`;
}
