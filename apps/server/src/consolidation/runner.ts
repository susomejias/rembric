import { ulid } from 'ulid';

import type { TransactionRunner } from '../db/client.js';
import type { Repositories } from '../db/repositories/index.js';
import type { RelationsService } from '../services/relations.js';

import type { ScopeKey } from './candidates.js';
import { findDecayCandidates, DEFAULT_DECAY, type DecayThresholds } from './decay.js';
import { applyDecay, recordOrphanPromote, type ConsolidationDeps } from './operations.js';

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
  repos: ConsolidationDeps & Pick<Repositories, 'projects'>;
  tx: TransactionRunner;
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
export const DEFAULT_MIN_INTERVAL_MS = 24 * 3_600_000;
const ORPHAN_BATCH = 50;

export class ConsolidationRunner {
  constructor(private readonly opts: ConsolidationRunnerOptions) {}

  /** Sweep the global scope and every project. Manual trigger passes force. */
  runAll(opts?: { force?: boolean }): ConsolidationRunSummary {
    const scopes: ScopeKey[] = [{ scope: 'global', projectId: null }];
    for (const id of this.opts.repos.projects.listAllIds()) {
      scopes.push({ scope: 'project', projectId: id });
    }
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
    const cutoff = now.getTime() - (this.opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
    return this.opts.repos.consolidation.recentRunExists(scopeString(scope), cutoff);
  }

  runScope(scope: ScopeKey): ScopeRunResult {
    const now = new Date();
    const runId = ulid(now.getTime());
    const ops: ScopeRunResult['ops'] = { archives: 0, orphaned: 0 };

    this.opts.repos.consolidation.insertRun({
      id: runId,
      startedAt: now,
      scope: scopeString(scope),
    });

    // 1. Decay.
    const decay = this.opts.decay ?? DEFAULT_DECAY;
    const decayIds = findDecayCandidates(this.opts.repos, scope, decay, now);
    if (decayIds.length > 0) {
      applyDecay(this.opts.repos, this.opts.tx, {
        runId,
        ids: decayIds,
        reasoning: 'last_seen_at older than per-type decay threshold with low confidence',
      });
      ops.archives = decayIds.length;
    }

    // 2. Deadline orphaning.
    ops.orphaned = this.orphanExpired(runId, scope);

    this.opts.repos.consolidation.finishRun(runId, new Date(), JSON.stringify(ops));

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
      const a = this.opts.repos.memory.findScopeTupleById(row.sourceId);
      const b = this.opts.repos.memory.findScopeTupleById(row.targetId);

      let reason: string | null;
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
        recordOrphanPromote(this.opts.repos, {
          runId,
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
