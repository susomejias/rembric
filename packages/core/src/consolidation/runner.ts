import { type ExaminablePending, type Repositories, type TransactionRunner } from '@rembric/db';
import { ulid } from 'ulid';

import type { AgentSessionsService } from '../services/agent-sessions.js';
import type { ProjectsService } from '../services/projects.js';
import type { RelationsService } from '../services/relations.js';
import {
  evaluatePair,
  LEXICAL_CANDIDATE_FLOOR,
  VEC_THRESHOLD,
  type PairEvaluation,
} from '../services/save-time-candidates.js';

import type { ScopeKey } from './candidates.js';
import { findDecayCandidates, DEFAULT_DECAY, type DecayThresholds } from './decay.js';
import { applyDecay, recordOrphanPromote, type ConsolidationDeps } from './operations.js';

export interface ConsolidationRunnerOptions {
  repos: ConsolidationDeps & Pick<Repositories, 'projects' | 'vectors' | 'entities'>;
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
  /** The drain's only embedding-related input; omitted or false makes every vector verdict unknown. */
  vectorIndexCurrent?: () => boolean;
  /** Test seam only: milliseconds for the drain budget. */
  drainClock?: () => number;
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
  drain: DrainSummary;
}

export interface DrainCursor {
  createdAt: number;
  judgmentId: string;
}

export interface DrainSummary {
  cursor: DrainCursor | null;
  examined: number;
  drainedRules: number;
  drainedRetired: number;
  keptAdmitted: number;
  keptUnknown: number;
}

export type DrainDisposition = 'drain_rules' | 'drain_retired' | 'keep_admitted' | 'keep_unknown';

const DEFAULT_ORPHAN_DEADLINE_MS = 14 * 86_400_000;
export const DEFAULT_MIN_INTERVAL_MS = 24 * 3_600_000;
const ORPHAN_BATCH = 50;

export const DRAIN_ROW_CAP = 150;
export const DRAIN_BUDGET_MS = 50;
export const DRAIN_RULES_REASON = 'stale under current rules';
export const DRAIN_RETIRED_REASON = 'endpoint retired';

interface SweepCall {
  drainStartedAt: number | null;
  revertedJudgmentIds: string[] | null;
}

const newSweepCall = (): SweepCall => ({ drainStartedAt: null, revertedJudgmentIds: null });

export function drainDisposition(evaluation: PairEvaluation): DrainDisposition {
  if (evaluation.kind === 'retired') return 'drain_retired';
  if (evaluation.kind !== 'channels') return 'keep_unknown';
  const verdicts = [evaluation.lexical, evaluation.vector, evaluation.entity];
  if (verdicts.includes('admitted')) return 'keep_admitted';
  if (verdicts.includes('unknown')) return 'keep_unknown';
  return 'drain_rules';
}

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
    const call = newSweepCall();
    for (const scope of scopes) {
      if (!opts?.force && this.recentlySwept(scope)) {
        skipped.push(scope);
        continue;
      }
      runs.push(this.runScopeIn(scope, call));
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
    return this.runScopeIn(scope, newSweepCall());
  }

  private runScopeIn(scope: ScopeKey, call: SweepCall): ScopeRunResult {
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

    // 3. Stale save-time pending drain.
    const drain = this.drainStale(runId, scope, call);

    this.opts.repos.consolidation.finishRun(runId, new Date(), JSON.stringify({ ...ops, drain }));

    return { scope, runId, ops, drain };
  }

  private drainStale(runId: string, scope: ScopeKey, call: SweepCall): DrainSummary {
    const summary: DrainSummary = {
      cursor: null,
      examined: 0,
      drainedRules: 0,
      drainedRetired: 0,
      keptAdmitted: 0,
      keptUnknown: 0,
    };
    try {
      const clock = this.opts.drainClock ?? (() => performance.now());
      call.drainStartedAt ??= clock();
      const deadline = call.drainStartedAt + DRAIN_BUDGET_MS;
      summary.cursor = parseDrainCursor(
        this.opts.repos.consolidation.latestFinishedRunSummary(scopeString(scope)),
      );
      const vectorIndexCurrent = this.opts.vectorIndexCurrent?.() ?? false;
      call.revertedJudgmentIds ??=
        this.opts.repos.consolidation.listRevertedOrphanPromoteCreatedIds();
      const batch = this.selectExaminable(
        scope.projectId,
        summary.cursor,
        call.revertedJudgmentIds,
      );
      for (const pair of batch) {
        if (summary.examined > 0 && clock() >= deadline) break;
        summary.examined++;
        summary.cursor = { createdAt: pair.createdAt.getTime(), judgmentId: pair.judgmentId };
        this.drainPair(runId, scope.projectId, pair, vectorIndexCurrent, summary);
      }
    } catch (err) {
      console.error('[consolidation] stale pending drain failed', err);
    }
    return summary;
  }

  /** Wraps within the run: after the cursor first, then from the lowest key up to it. */
  private selectExaminable(
    projectId: string,
    cursor: DrainCursor | null,
    excludeJudgmentIds: readonly string[],
  ): ExaminablePending[] {
    const relations = this.opts.repos.relations;
    if (cursor === null) {
      return relations.listExaminablePendingInScope({
        projectId,
        excludeJudgmentIds,
        limit: DRAIN_ROW_CAP,
      });
    }
    const key = { createdAt: new Date(cursor.createdAt), judgmentId: cursor.judgmentId };
    const head = relations.listExaminablePendingInScope({
      projectId,
      after: key,
      excludeJudgmentIds,
      limit: DRAIN_ROW_CAP,
    });
    if (head.length >= DRAIN_ROW_CAP) return head;
    return [
      ...head,
      ...relations.listExaminablePendingInScope({
        projectId,
        until: key,
        excludeJudgmentIds,
        limit: DRAIN_ROW_CAP - head.length,
      }),
    ];
  }

  private drainPair(
    runId: string,
    projectId: string,
    pair: ExaminablePending,
    vectorIndexCurrent: boolean,
    summary: DrainSummary,
  ): void {
    let evaluation: PairEvaluation;
    try {
      evaluation = evaluatePair(this.opts.repos, projectId, pair.sourceId, pair.targetId, {
        vectorIndexCurrent,
      });
    } catch (err) {
      evaluation = { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
    const disposition = drainDisposition(evaluation);
    if (disposition === 'keep_admitted') {
      summary.keptAdmitted++;
      return;
    }
    if (disposition === 'keep_unknown') {
      summary.keptUnknown++;
      return;
    }
    try {
      this.orphanAndJournal(runId, pair, drainReasoning(evaluation));
    } catch {
      // Concurrent verdict or failed write: the pair rolled back and stays as it was.
      summary.keptUnknown++;
      return;
    }
    if (disposition === 'drain_retired') summary.drainedRetired++;
    else summary.drainedRules++;
  }

  private orphanAndJournal(runId: string, pair: ExaminablePending, reasoning: string): void {
    this.opts.tx.transaction(() => {
      const at = new Date();
      this.opts.relations.orphan(pair.judgmentId, reasoning, at);
      recordOrphanPromote(this.opts.repos, {
        runId,
        judgmentId: pair.judgmentId,
        sourceId: pair.sourceId,
        targetId: pair.targetId,
        relation: null,
        reasoning,
        appliedAt: at,
      });
    });
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

function drainReasoning(evaluation: PairEvaluation): string {
  if (evaluation.kind === 'retired') {
    return `${DRAIN_RETIRED_REASON}: source ${evaluation.sourceStatus}, target ${evaluation.targetStatus}`;
  }
  if (evaluation.kind !== 'channels' || evaluation.vectorSimilarity === null) {
    throw new Error(`drainReasoning: ${evaluation.kind} is not drainable`);
  }
  return (
    `${DRAIN_RULES_REASON}: lexical ${evaluation.lexicalSimilarity.toFixed(3)} < ${LEXICAL_CANDIDATE_FLOOR}, ` +
    `vector ${evaluation.vectorSimilarity.toFixed(3)} < ${VEC_THRESHOLD}, no shared entity`
  );
}

function parseDrainCursor(summary: string | null): DrainCursor | null {
  if (summary === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(summary);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed['drain'])) return null;
  const cursor = parsed['drain']['cursor'];
  if (!isRecord(cursor)) return null;
  const { createdAt, judgmentId } = cursor;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  if (typeof judgmentId !== 'string' || judgmentId.length === 0) return null;
  return { createdAt, judgmentId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
