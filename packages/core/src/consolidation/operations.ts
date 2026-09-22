import { type ConsolidationOpType, type Repositories, type TransactionRunner } from '@rembric/db';
import { ulid } from 'ulid';

export type ConsolidationDeps = Pick<Repositories, 'memory' | 'relations' | 'consolidation'>;

export const REACTIVATE_UNDO_OP_TYPES: ReadonlySet<ConsolidationOpType> = new Set([
  'merge',
  'supersede',
  'decay',
  'agent_memory_archive',
]);

export const TERMINAL_OP_TYPES: ReadonlySet<ConsolidationOpType> = new Set([
  'session_purge',
  'archived_memory_purge',
  'prompt_purge',
]);

export interface SkippedRow {
  id: string;
  topicKey: string;
  occupiedBy: string;
}

export interface UndoResult {
  reverted: string;
  skipped: SkippedRow[];
}

function topicSlotOccupiedBy(
  repos: ConsolidationDeps,
  row: { id: string; projectId: string | null; topicKey: string | null },
): string | null {
  if (!row.topicKey) return null;
  if (row.projectId === null) return row.id;
  const active = repos.memory.findActiveByTopicKey({
    projectId: row.projectId,
    topicKey: row.topicKey,
  });
  return active && active.id !== row.id ? active.id : null;
}

export interface DecayOpInput {
  runId: string;
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
      runId: input.runId,
      opType: 'decay',
      affectedIds: input.ids,
      reasoning: input.reasoning,
      appliedAt: now,
    });
  });

  return { opId };
}

export function recordOrphanPromote(
  repos: ConsolidationDeps,
  input: {
    runId: string;
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
    runId: input.runId,
    opType: 'orphan_promote',
    affectedIds: [input.sourceId, input.targetId],
    createdId: input.judgmentId,
    reasoning: `${input.relation ?? 'orphaned'}: ${input.reasoning}`,
    appliedAt: now,
  });
  return { opId };
}

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

export function undoOp(repos: ConsolidationDeps, tx: TransactionRunner, opId: string): UndoResult {
  const op = repos.consolidation.findOpById(opId);
  if (!op) throw new Error(`undoOp: ${opId} not found`);
  if (op.revertedAt) throw new Error(`undoOp: ${opId} already reverted`);

  if (TERMINAL_OP_TYPES.has(op.opType)) {
    throw new NotUndoableError(
      `undoOp: ${op.opType} ops are terminal — purged rows cannot be reconstructed`,
    );
  }

  if (REACTIVATE_UNDO_OP_TYPES.has(op.opType)) {
    const expected = new Set<string>(op.affectedIds);
    if (op.opType === 'merge' && op.createdId) expected.add(op.createdId);
    const existing = repos.memory.existingIds([...expected]);
    const missing = [...expected].filter((id) => !existing.has(id));
    if (missing.length > 0) {
      throw new PurgedRowMissingError(missing);
    }
  }

  const now = new Date();
  const skipped: SkippedRow[] = [];

  tx.transaction(() => {
    if (REACTIVATE_UNDO_OP_TYPES.has(op.opType)) {
      const reactivatable: string[] = [];
      for (const row of repos.memory.unsafeGetByIds(op.affectedIds)) {
        const occupiedBy = topicSlotOccupiedBy(repos, row);
        if (occupiedBy && row.topicKey) {
          skipped.push({ id: row.id, topicKey: row.topicKey, occupiedBy });
        } else {
          reactivatable.push(row.id);
        }
      }
      repos.memory.reactivate(reactivatable);
      if (reactivatable.length > 0) repos.memory.touchLastSeenBatch(reactivatable, now);
      if (op.opType === 'merge' && op.createdId) {
        repos.memory.archiveOne(op.createdId);
      }
    } else if (op.opType === 'orphan_promote' && op.createdId) {
      const rel = repos.relations.findByJudgmentId(op.createdId);
      if (rel) {
        if (rel.relation === 'supersedes' && rel.status === 'judged') {
          const [targetRow] = repos.memory.unsafeGetByIds([rel.targetId]);
          const occupiedBy = targetRow ? topicSlotOccupiedBy(repos, targetRow) : null;
          if (occupiedBy && targetRow?.topicKey) {
            skipped.push({ id: targetRow.id, topicKey: targetRow.topicKey, occupiedBy });
          } else {
            repos.memory.reactivateOne(rel.targetId);
          }
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

  return { reverted: opId, skipped };
}

export function undoRun(
  repos: ConsolidationDeps,
  tx: TransactionRunner,
  runId: string,
): { reverted: string[]; skipped: SkippedRow[] } {
  const ops = repos.consolidation.listActiveOps(runId);
  const reverted: string[] = [];
  const skipped: SkippedRow[] = [];
  // Reverse order so dependent ops unwind cleanly.
  for (const op of [...ops].reverse()) {
    const result = undoOp(repos, tx, op.id);
    reverted.push(op.id);
    skipped.push(...result.skipped);
  }
  return { reverted, skipped };
}

export type { ConsolidationOpType };
