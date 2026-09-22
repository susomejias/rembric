import { type Repositories, type TransactionRunner } from '@rembric/db';
import { ulid } from 'ulid';

import type { AgentSessionsService } from '../services/agent-sessions.js';
import type { ProjectsService } from '../services/projects.js';
import type { RelationsService } from '../services/relations.js';

import type { ScopeKey } from './candidates.js';
import { findDecayCandidates, DEFAULT_DECAY, type DecayThresholds } from './decay.js';
import { applyDecay, recordOrphanPromote, type ConsolidationDeps } from './operations.js';

export interface ConsolidationRunnerOptions {
  repos: ConsolidationDeps & Pick<Repositories, 'projects'>;
  tx: TransactionRunner;
  relations: RelationsService;
  /** Resolves the default project, whose sweep also gates the empty-session purge. */
  projects: Pick<ProjectsService, 'getDefault'>;
  agentSessions: Pick<AgentSessionsService, 'purgeEmpty'>;
  decay?: DecayThresholds;
  /** Pending relations older than this are orphaned by the sweep. */
  orphanDeadlineMs?: number;
  /** Per-scope throttle window; sweeps within it are skipped unless forced. */
  minIntervalMs?: number;
}

export interface ConsolidationRunSummary {
  runs: ScopeRunResult[];
  skipped: ScopeKey[];
  /** Session ids purged this call, if the default project ran and any were eligible. */
  purgedSessionIds?: string[];
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

  /** Sweep every project, the default one included. Manual trigger passes force. */
  runAll(opts?: { force?: boolean }): ConsolidationRunSummary {
    const scopes: ScopeKey[] = this.opts.repos.projects
      .listAllIds()
      .map((id) => ({ projectId: id }));
    return this.sweep(scopes, opts);
  }

  sweepFor(projectId: string | null): ConsolidationRunSummary {
    const defaultId = this.defaultProjectId();
    const scopes: ScopeKey[] = [{ projectId: defaultId }];
    if (projectId !== null && projectId !== defaultId) {
      scopes.push({ projectId });
    }
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
    const defaultId = this.defaultProjectId();
    const defaultRan = runs.some((r) => r.scope.projectId === defaultId);
    const purgedSessionIds = defaultRan
      ? this.opts.agentSessions.purgeEmpty({ adminBypass: true }).deletedIds
      : undefined;
    return { runs, skipped, purgedSessionIds };
  }

  /** Resolved from `is_default`, never a literal: the slug is not the identity. */
  private defaultProjectId(): string {
    return this.opts.projects.getDefault().id;
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

  private orphanExpired(runId: string, scope: ScopeKey): number {
    const deadlineMs = this.opts.orphanDeadlineMs ?? DEFAULT_ORPHAN_DEADLINE_MS;
    const pending = this.opts.relations.findPendingOlderThanInScope({
      projectId: scope.projectId,
      cutoffMs: deadlineMs,
      limit: ORPHAN_BATCH,
    });

    const reason = `unjudged after ${deadlineMs}ms deadline`;
    let orphaned = 0;
    for (const row of pending) {
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
        // Concurrent transition (e.g. a late memory.judge); skip the row.
      }
    }
    return orphaned;
  }
}

function scopeString(scope: ScopeKey): string {
  return `project:${scope.projectId}`;
}
