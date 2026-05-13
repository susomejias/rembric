import { and, eq, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { Db } from '../db/client.js';
import { consolidationOps, type ConsolidationOpType } from '../db/schema/consolidation.js';
import { memory, type Memory } from '../db/schema/memory.js';

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

export interface MergeOpInput {
  consolidationId: string;
  predecessors: Memory[];
  /** The merged memory body produced by the LLM. */
  mergedContent: string;
  reasoning: string;
}

export function applyMerge(db: Db, input: MergeOpInput): { mergedId: string; opId: string } {
  if (input.predecessors.length < 2) {
    throw new Error('applyMerge: requires at least two predecessors');
  }

  // Sanity: all predecessors must share scope + project_id.
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

  db.transaction((tx) => {
    // 1. Insert the consolidated memory in active state.
    tx.insert(memory)
      .values({
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
      })
      .run();

    // 2. Transition predecessors to superseded.
    tx.update(memory).set({ status: 'superseded' }).where(inArray(memory.id, predecessorIds)).run();

    // 3. Journal entry.
    tx.insert(consolidationOps)
      .values({
        id: opId,
        consolidationId: input.consolidationId,
        opType: 'merge',
        affectedIds: predecessorIds,
        createdId: mergedId,
        reasoning: input.reasoning,
        appliedAt: now,
      })
      .run();
  });

  return { mergedId, opId };
}

export interface SupersedeOpInput {
  consolidationId: string;
  winner: Memory;
  losers: Memory[];
  reasoning: string;
}

export function applySupersede(db: Db, input: SupersedeOpInput): { opId: string } {
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

  db.transaction((tx) => {
    tx.update(memory).set({ status: 'superseded' }).where(inArray(memory.id, loserIds)).run();

    // Read-modify-write `replaces` on the winner inside the transaction
    // so the array surgery stays in JS where the schema is typed.
    const w = tx
      .select({ replaces: memory.replaces })
      .from(memory)
      .where(eq(memory.id, input.winner.id))
      .get();
    const nextReplaces = Array.from(new Set([...(w?.replaces ?? []), ...loserIds]));
    tx.update(memory).set({ replaces: nextReplaces }).where(eq(memory.id, input.winner.id)).run();

    tx.insert(consolidationOps)
      .values({
        id: opId,
        consolidationId: input.consolidationId,
        opType: 'supersede',
        affectedIds: loserIds,
        createdId: input.winner.id,
        reasoning: input.reasoning,
        appliedAt: now,
      })
      .run();
  });

  return { opId };
}

export interface DecayOpInput {
  consolidationId: string;
  ids: string[];
  reasoning: string;
}

export function applyDecay(db: Db, input: DecayOpInput): { opId: string } {
  if (input.ids.length === 0) {
    throw new Error('applyDecay: no ids provided');
  }
  const now = new Date();
  const opId = ulid(now.getTime());

  db.transaction((tx) => {
    tx.update(memory)
      .set({ status: 'archived' })
      .where(and(inArray(memory.id, input.ids), eq(memory.status, 'active')))
      .run();

    tx.insert(consolidationOps)
      .values({
        id: opId,
        consolidationId: input.consolidationId,
        opType: 'decay',
        affectedIds: input.ids,
        reasoning: input.reasoning,
        appliedAt: now,
      })
      .run();
  });

  return { opId };
}

export function recordNoop(
  db: Db,
  input: { consolidationId: string; affectedIds: string[]; reasoning: string },
): void {
  const now = new Date();
  db.insert(consolidationOps)
    .values({
      id: ulid(now.getTime()),
      consolidationId: input.consolidationId,
      opType: 'noop',
      affectedIds: input.affectedIds,
      reasoning: input.reasoning,
      appliedAt: now,
    })
    .run();
}

export function recordFailed(
  db: Db,
  input: { consolidationId: string; affectedIds: string[]; reasoning: string },
): void {
  const now = new Date();
  db.insert(consolidationOps)
    .values({
      id: ulid(now.getTime()),
      consolidationId: input.consolidationId,
      opType: 'failed',
      affectedIds: input.affectedIds,
      reasoning: input.reasoning,
      appliedAt: now,
    })
    .run();
}

/**
 * Undo a previously applied consolidation op. Re-activates the affected memories
 * and (for merges) archives the consolidated row so it no longer surfaces
 * in active retrieval.
 */
export function undoOp(db: Db, opId: string): void {
  const op = db.select().from(consolidationOps).where(eq(consolidationOps.id, opId)).get();
  if (!op) throw new Error(`undoOp: ${opId} not found`);
  if (op.revertedAt) throw new Error(`undoOp: ${opId} already reverted`);

  const now = new Date();

  db.transaction((tx) => {
    if (op.opType === 'merge' || op.opType === 'supersede') {
      // Reactivate affected (predecessors / losers).
      tx.update(memory).set({ status: 'active' }).where(inArray(memory.id, op.affectedIds)).run();
      // Archive the merged-into / winner so the undo cancels its visibility.
      if (op.opType === 'merge' && op.createdId) {
        tx.update(memory).set({ status: 'archived' }).where(eq(memory.id, op.createdId)).run();
      }
    } else if (op.opType === 'decay' || op.opType === 'archive') {
      tx.update(memory).set({ status: 'active' }).where(inArray(memory.id, op.affectedIds)).run();
    } else {
      // noop / failed: nothing to revert.
    }

    tx.update(consolidationOps).set({ revertedAt: now }).where(eq(consolidationOps.id, opId)).run();
  });
}

export function undoRun(db: Db, runId: string): { reverted: string[] } {
  const ops = db
    .select()
    .from(consolidationOps)
    .where(and(eq(consolidationOps.consolidationId, runId), sql`reverted_at IS NULL`))
    .all();

  const reverted: string[] = [];
  // Reverse order so dependent ops unwind cleanly.
  for (const op of [...ops].reverse()) {
    undoOp(db, op.id);
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

// Type re-exported for downstream consumers.
export type { ConsolidationOpType };
