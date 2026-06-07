import { ulid } from 'ulid';

import type { TransactionRunner } from '../db/client.js';
import type { Repositories } from '../db/repositories/index.js';
import { type ConsolidationOpType } from '../db/schema/consolidation.js';
import { type Memory } from '../db/schema/memory.js';

/**
 * Atomic consolidation operations. Each runs inside a SQLite transaction; on
 * error the whole transaction rolls back and the runner logs a `failed`
 * op (or a `noop` if the decision was already inert).
 *
 * The contract (also enforced by tests):
 *   - never DELETE FROM memory
 *   - never UPDATE memory.content
 *   - status transitions are limited to active → superseded | archived,
 *     and via undo back to active.
 */

export type ConsolidationDeps = Pick<Repositories, 'memory' | 'relations' | 'consolidation'>;

export interface MergeOpInput {
  consolidationId: string;
  predecessors: Memory[];
  /** The merged memory body produced by the LLM. */
  mergedContent: string;
  reasoning: string;
}

export function applyMerge(
  repos: ConsolidationDeps,
  tx: TransactionRunner,
  input: MergeOpInput,
): { mergedId: string; opId: string } {
  if (input.predecessors.length < 2) {
    throw new Error('applyMerge: requires at least two predecessors');
  }

  const first = input.predecessors[0]!;
  for (const p of input.predecessors) {
    if (p.scope !== first.scope || p.projectId !== first.projectId) {
      throw new Error('applyMerge: predecessors span multiple scopes');
    }
    if (p.status !== 'active') {
      throw new Error(`applyMerge: predecessor ${p.id} is not active (status=${p.status})`);
    }
  }

  const now = new Date();
  const mergedId = ulid(now.getTime());
  const opId = ulid(now.getTime());
  const predecessorIds = input.predecessors.map((p) => p.id);

  tx.transaction(() => {
    repos.memory.insert({
      id: mergedId,
      scope: first.scope,
      projectId: first.projectId,
      type: first.type,
      content: input.mergedContent,
      tags: dedupeTags(input.predecessors),
      status: 'active',
      replaces: predecessorIds,
      createdAt: now,
      lastSeenAt: now,
      source: { tokenName: 'consolidation' },
    });
    repos.memory.markSupersededMany(predecessorIds);
    repos.consolidation.insertOp({
      id: opId,
      consolidationId: input.consolidationId,
      opType: 'merge',
      affectedIds: predecessorIds,
      createdId: mergedId,
      reasoning: input.reasoning,
      appliedAt: now,
    });
  });

  return { mergedId, opId };
}

export interface SupersedeOpInput {
  consolidationId: string;
  winner: Memory;
  losers: Memory[];
  reasoning: string;
}

export function applySupersede(
  repos: ConsolidationDeps,
  tx: TransactionRunner,
  input: SupersedeOpInput,
): { opId: string } {
  if (input.losers.length === 0) {
    throw new Error('applySupersede: at least one loser required');
  }
  const all = [input.winner, ...input.losers];
  const first = all[0]!;
  for (const m of all) {
    if (m.scope !== first.scope || m.projectId !== first.projectId) {
      throw new Error('applySupersede: members span multiple scopes');
    }
  }

  const now = new Date();
  const loserIds = input.losers.map((l) => l.id);
  const opId = ulid(now.getTime());

  tx.transaction(() => {
    repos.memory.markSupersededMany(loserIds);
    const prev = repos.memory.findReplaces(input.winner.id) ?? [];
    repos.memory.setReplaces(input.winner.id, Array.from(new Set([...prev, ...loserIds])));
    repos.consolidation.insertOp({
      id: opId,
      consolidationId: input.consolidationId,
      opType: 'supersede',
      affectedIds: loserIds,
      createdId: input.winner.id,
      reasoning: input.reasoning,
      appliedAt: now,
    });
  });

  return { opId };
}

export interface DecayOpInput {
  consolidationId: string;
  ids: string[];
  reasoning: string;
}

export function applyDecay(
  repos: ConsolidationDeps,
  tx: TransactionRunner,
  input: DecayOpInput,
): { opId: string } {
  if (input.ids.length === 0) {
    throw new Error('applyDecay: no ids provided');
  }
  const now = new Date();
  const opId = ulid(now.getTime());

  tx.transaction(() => {
    repos.memory.archiveActive(input.ids);
    repos.consolidation.insertOp({
      id: opId,
      consolidationId: input.consolidationId,
      opType: 'decay',
      affectedIds: input.ids,
      reasoning: input.reasoning,
      appliedAt: now,
    });
  });

  return { opId };
}

export function recordNoop(
  repos: ConsolidationDeps,
  input: { consolidationId: string; affectedIds: string[]; reasoning: string },
): void {
  const now = new Date();
  repos.consolidation.insertOp({
    id: ulid(now.getTime()),
    consolidationId: input.consolidationId,
    opType: 'noop',
    affectedIds: input.affectedIds,
    reasoning: input.reasoning,
    appliedAt: now,
  });
}

export function recordFailed(
  repos: ConsolidationDeps,
  input: { consolidationId: string; affectedIds: string[]; reasoning: string },
): void {
  const now = new Date();
  repos.consolidation.insertOp({
    id: ulid(now.getTime()),
    consolidationId: input.consolidationId,
    opType: 'failed',
    affectedIds: input.affectedIds,
    reasoning: input.reasoning,
    appliedAt: now,
  });
}

/**
 * Journal an orphan-promotion verdict. Called by the consolidator after
 * `RelationsService.judge` / `.orphan` writes the actual relation row.
 *
 * `createdId` is set to the `judgment_id` so `undoOp` can find the
 * relation row to revert. `affectedIds` carries `[sourceId, targetId]`
 * for backwards-compatible journaling.
 */
export function recordOrphanPromote(
  repos: ConsolidationDeps,
  input: {
    consolidationId: string;
    judgmentId: string;
    sourceId: string;
    targetId: string;
    relation: string | null;
    reasoning: string;
  },
): { opId: string } {
  const now = new Date();
  const opId = ulid(now.getTime());
  repos.consolidation.insertOp({
    id: opId,
    consolidationId: input.consolidationId,
    opType: 'orphan_promote',
    affectedIds: [input.sourceId, input.targetId],
    createdId: input.judgmentId,
    reasoning: `${input.relation ?? 'orphaned'}: ${input.reasoning}`,
    appliedAt: now,
  });
  return { opId };
}

/**
 * Raised by `undoOp` when rows referenced by the op have been physically
 * removed by the maintenance purge paths. The op stays in its current state.
 */
export class PurgedRowMissingError extends Error {
  readonly code = 'purged_row_missing';
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(
      `undoOp: ${missing.length} memory row(s) referenced by this op have been purged; ` +
        `undo cannot reconstruct them. Missing ids: ${missing.join(', ')}`,
    );
    this.missing = missing;
  }
}

export class NotUndoableError extends Error {
  readonly code = 'not_undoable';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Undo a previously applied consolidation op. Re-activates the affected
 * memories and (for merges) archives the consolidated row.
 *
 * Throws `PurgedRowMissingError` when rows referenced by the op have been
 * physically removed; throws `NotUndoableError` for terminal purge ops.
 */
export function undoOp(repos: ConsolidationDeps, tx: TransactionRunner, opId: string): void {
  const op = repos.consolidation.findOpById(opId);
  if (!op) throw new Error(`undoOp: ${opId} not found`);
  if (op.revertedAt) throw new Error(`undoOp: ${opId} already reverted`);

  if (op.opType === 'session_purge' || op.opType === 'archived_memory_purge') {
    throw new NotUndoableError(
      `undoOp: ${op.opType} ops are terminal — purged rows cannot be reconstructed`,
    );
  }

  // `orphan_promote` operates on relation rows (append-only, unaffected by
  // the purge paths); the others operate on memory rows.
  if (
    op.opType === 'merge' ||
    op.opType === 'supersede' ||
    op.opType === 'decay' ||
    op.opType === 'archive'
  ) {
    const expected = new Set<string>(op.affectedIds);
    if (op.opType === 'merge' && op.createdId) expected.add(op.createdId);
    const existing = repos.memory.existingIds([...expected]);
    const missing = [...expected].filter((id) => !existing.has(id));
    if (missing.length > 0) {
      throw new PurgedRowMissingError(missing);
    }
  }

  const now = new Date();

  tx.transaction(() => {
    if (op.opType === 'merge' || op.opType === 'supersede') {
      repos.memory.reactivate(op.affectedIds);
      if (op.opType === 'merge' && op.createdId) {
        repos.memory.archiveOne(op.createdId);
      }
    } else if (op.opType === 'decay' || op.opType === 'archive') {
      repos.memory.reactivate(op.affectedIds);
    } else if (op.opType === 'orphan_promote' && op.createdId) {
      // createdId carries the promoted relation's judgment_id. Undo a
      // 'supersedes' verdict by reactivating the target and stripping it
      // from the source's replaces[]; then flip the row back to pending.
      const rel = repos.relations.findByJudgmentId(op.createdId);
      if (rel) {
        if (rel.relation === 'supersedes' && rel.status === 'judged') {
          repos.memory.reactivateOne(rel.targetId);
          const replaces = repos.memory.findReplaces(rel.sourceId);
          if (replaces) {
            repos.memory.setReplaces(
              rel.sourceId,
              replaces.filter((id) => id !== rel.targetId),
            );
          }
        }
        repos.relations.resetToPending(rel.id);
      }
    }

    repos.consolidation.markReverted(opId, now);
  });
}

export function undoRun(
  repos: ConsolidationDeps,
  tx: TransactionRunner,
  runId: string,
): { reverted: string[] } {
  const ops = repos.consolidation.listActiveOps(runId);
  const reverted: string[] = [];
  // Reverse order so dependent ops unwind cleanly.
  for (const op of [...ops].reverse()) {
    undoOp(repos, tx, op.id);
    reverted.push(op.id);
  }
  return { reverted };
}

function dedupeTags(memories: Memory[]): string[] {
  const set = new Set<string>();
  for (const m of memories) {
    for (const t of m.tags) set.add(t);
  }
  return [...set];
}

export type { ConsolidationOpType };
