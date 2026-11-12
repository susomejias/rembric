import {
  type ConsolidationOpType,
  type RelationKind,
  type RelationStatus,
  type Repositories,
  type TransactionRunner,
} from '@rembric/db';
import { ulid } from 'ulid';

import { RelationsService } from '../services/relations.js';

export type ConsolidationDeps = Pick<Repositories, 'memory' | 'relations' | 'consolidation'>;

export const RETIREMENT_ORPHAN_REASON = 'endpoint retired at retirement';

export type RetirementCause =
  | 'topic_key revision'
  | 'supersedes verdict'
  | 'merge'
  | 'archive'
  | 'decay'
  | 'merge undo';

export interface RetirementInput {
  retiredIds: readonly string[];
  status: 'superseded' | 'archived';
  cause: RetirementCause;
  /** The retirement's own timestamp, stamped on every orphaning and journal op it makes. */
  at: Date;
  /** The run of the retirement's own journal op; omitted, a maintenance run opens when there is something to orphan. */
  runId?: string;
}

/** Runs inside the retiring transaction: a failure here fails the retirement. */
export function orphanPendingOnRetirement(
  repos: ConsolidationDeps,
  relations: Pick<RelationsService, 'orphan'>,
  input: RetirementInput,
): number {
  const rows = repos.relations.listPendingTouchingAny(input.retiredIds);
  if (rows.length === 0) return 0;
  let runId = input.runId;
  if (runId === undefined) {
    runId = ulid(input.at.getTime());
    repos.consolidation.insertRun({
      id: runId,
      startedAt: input.at,
      finishedAt: input.at,
      scope: 'maintenance',
      summary: JSON.stringify({ kind: 'retirement_orphan', orphaned: rows.length }),
    });
  }
  const retired = new Set(input.retiredIds);
  for (const row of rows) {
    const side = retired.has(row.sourceId)
      ? retired.has(row.targetId)
        ? 'source and target'
        : 'source'
      : 'target';
    const reasoning = `${RETIREMENT_ORPHAN_REASON}: ${side} ${input.status} by ${input.cause}`;
    relations.orphan(row.judgmentId, reasoning, input.at);
    recordOrphanPromote(repos, {
      runId,
      judgmentId: row.judgmentId,
      sourceId: row.sourceId,
      targetId: row.targetId,
      relation: null,
      reasoning,
      appliedAt: input.at,
    });
  }
  return rows.length;
}

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

/** A relation an `orphan_promote` undo left as it was, because a verdict was written after the op. */
export interface KeptVerdict {
  judgmentId: string;
  status: RelationStatus;
  relation: RelationKind | null;
}

export interface UndoResult {
  reverted: string;
  skipped: SkippedRow[];
  keptVerdicts: KeptVerdict[];
}

export interface UndoRunResult {
  reverted: string[];
  skipped: SkippedRow[];
  keptVerdicts: KeptVerdict[];
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
    orphanPendingOnRetirement(repos, new RelationsService(repos, tx), {
      retiredIds: input.ids,
      status: 'archived',
      cause: 'decay',
      at: now,
      runId: input.runId,
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
    appliedAt?: Date;
  },
): { opId: string } {
  const now = input.appliedAt ?? new Date();
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
  const keptVerdicts: KeptVerdict[] = [];

  tx.transaction(() => {
    if (REACTIVATE_UNDO_OP_TYPES.has(op.opType)) {
      // The successor may hold an original's topic_key slot; free it before reactivating.
      if (op.opType === 'merge' && op.createdId) {
        repos.memory.archiveOne(op.createdId);
        orphanPendingOnRetirement(repos, new RelationsService(repos, tx), {
          retiredIds: [op.createdId],
          status: 'archived',
          cause: 'merge undo',
          at: now,
        });
      }
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
    } else if (op.opType === 'orphan_promote' && op.createdId) {
      const rel = repos.relations.findByJudgmentId(op.createdId);
      const writtenSinceOp =
        rel !== undefined &&
        (rel.judgedAt === null || rel.judgedAt.getTime() > op.appliedAt.getTime());
      if (rel && writtenSinceOp) {
        keptVerdicts.push({
          judgmentId: rel.judgmentId,
          status: rel.status,
          relation: rel.relation,
        });
      } else if (rel) {
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

  return { reverted: opId, skipped, keptVerdicts };
}

export function undoRun(
  repos: ConsolidationDeps,
  tx: TransactionRunner,
  runId: string,
): UndoRunResult {
  const ops = repos.consolidation.listActiveOps(runId);
  const reverted: string[] = [];
  const skipped: SkippedRow[] = [];
  const keptVerdicts: KeptVerdict[] = [];
  // Reverse order so dependent ops unwind cleanly.
  for (const op of [...ops].reverse()) {
    const result = undoOp(repos, tx, op.id);
    reverted.push(op.id);
    skipped.push(...result.skipped);
    keptVerdicts.push(...result.keptVerdicts);
  }
  return { reverted, skipped, keptVerdicts };
}

export type { ConsolidationOpType };
