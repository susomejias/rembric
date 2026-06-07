import { and, eq, lt, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { Db } from '../db/client.js';
import {
  memoryRelations,
  type MemoryRelation,
  type MarkedByKind,
  type RelationKind,
} from '../db/schema/memory-relations.js';
import { memory } from '../db/schema/memory.js';

import { DomainError } from './errors.js';

/**
 * Service for the judgment graph between memories.
 *
 * Three entry points:
 *   - `createPending` — called by `memory.save` when a candidate detector
 *     surfaces a similar memory; inserts with status='pending'
 *   - `judge` — called by `memory.judge` (agent) or the consolidator's
 *     orphan-promotion pass; transitions pending → judged and, for
 *     `relation='supersedes'`, mutates the target memory row
 *   - `compare` — called by `memory.compare` (agent-driven proactive
 *     analysis); upserts a judged row directly without a preceding save
 *
 * Cross-scope safety: insert and upsert paths assert that source and
 * target memories share `(scope, project_id)` — a CI test in
 * `invariants.test.ts` enforces this contract against future
 * regressions.
 */

export interface CreatePendingInput {
  sourceId: string;
  targetId: string;
  markedByKind?: MarkedByKind;
}

export interface JudgeInput {
  relation: RelationKind;
  reason?: string;
  confidence?: number;
  evidence?: unknown;
  actor: string;
  kind: MarkedByKind;
}

export interface CompareInput {
  sourceId: string;
  targetId: string;
  relation: Exclude<RelationKind, 'not_conflict'>;
  reason?: string;
  confidence: number;
  evidence?: unknown;
  actor: string;
  kind?: MarkedByKind;
}

export interface RelationView {
  /** `kind` from the receiver's POV: outgoing (`supersedes`) vs incoming (`superseded_by`). */
  kind: RelationKind | 'superseded_by' | 'pending_conflict';
  targetId: string;
  snippet?: string;
  judgmentId?: string;
  status: 'pending' | 'judged' | 'orphaned';
  reason?: string | null;
  confidence?: number | null;
}

export class RelationsService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Insert a pending candidate relation. Asserts that the two memories
   * share scope+project_id; rejects the insert otherwise.
   *
   * Returns the inserted row including the generated `judgmentId`.
   */
  createPending(input: CreatePendingInput): MemoryRelation {
    this.assertSameScope(input.sourceId, input.targetId);

    const ts = this.now();
    const row = this.db
      .insert(memoryRelations)
      .values({
        id: ulid(ts.getTime()),
        judgmentId: ulid(ts.getTime()),
        sourceId: input.sourceId,
        targetId: input.targetId,
        relation: null,
        status: 'pending',
        markedByKind: input.markedByKind ?? null,
        createdAt: ts,
      })
      .returning()
      .get();
    if (!row) {
      throw new DomainError('conflict', 'relations.createPending: insert returned no row');
    }
    return row;
  }

  /**
   * Close a pending judgment. Looks up the row by `judgmentId`. When
   * `relation='supersedes'`, atomically transitions the target memory
   * to `superseded` and appends the target id to the source memory's
   * `replaces` array. Other relations are pure annotations.
   *
   * Re-judging an already-`judged` row throws `judgment_already_closed`.
   * Re-judging an `orphaned` row also throws — the consolidator already
   * said "we can't decide" and the agent has lost the context window
   * that the original save offered.
   */
  judge(judgmentId: string, input: JudgeInput): MemoryRelation {
    const existing = this.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.judgmentId, judgmentId))
      .get();
    if (!existing) {
      throw new DomainError(
        'memory_not_found',
        `relations.judge: judgmentId ${judgmentId} not found`,
      );
    }
    if (existing.status !== 'pending') {
      throw new DomainError(
        'conflict',
        `relations.judge: judgmentId ${judgmentId} is already '${existing.status}'`,
      );
    }

    const ts = this.now();
    const updated = this.db.transaction((tx) => {
      // 1. Transition relation → judged.
      const next = tx
        .update(memoryRelations)
        .set({
          relation: input.relation,
          status: 'judged',
          reason: input.reason ?? null,
          evidence: input.evidence ?? null,
          confidence: input.confidence ?? null,
          markedByKind: input.kind,
          markedByActor: input.actor,
          judgedAt: ts,
        })
        .where(and(eq(memoryRelations.id, existing.id), eq(memoryRelations.status, 'pending')))
        .returning()
        .get();
      if (!next) {
        throw new DomainError(
          'conflict',
          `relations.judge: ${judgmentId} was concurrently mutated`,
        );
      }

      // 2. Side effect for `supersedes`: target → superseded, source.replaces += target.id.
      if (input.relation === 'supersedes') {
        applySupersedesSideEffect(tx, existing.sourceId, existing.targetId);
      }
      return next;
    });
    return updated;
  }

  /**
   * Proactive comparison between two memories. Idempotent: a second
   * call with the same `(sourceId, targetId)` ordered pair updates the
   * existing judged row in place rather than inserting a duplicate.
   *
   * The `not_conflict` relation is rejected at the schema layer (compare
   * is for assertive verdicts; "no relation found" maps to no row).
   */
  compare(input: CompareInput): MemoryRelation {
    this.assertSameScope(input.sourceId, input.targetId);

    const existing = this.db
      .select()
      .from(memoryRelations)
      .where(
        and(
          eq(memoryRelations.sourceId, input.sourceId),
          eq(memoryRelations.targetId, input.targetId),
        ),
      )
      .get();

    const ts = this.now();

    if (existing) {
      const updated = this.db.transaction((tx) => {
        const next = tx
          .update(memoryRelations)
          .set({
            relation: input.relation,
            status: 'judged',
            reason: input.reason ?? null,
            evidence: input.evidence ?? null,
            confidence: input.confidence,
            markedByKind: input.kind ?? 'agent',
            markedByActor: input.actor,
            judgedAt: ts,
          })
          .where(eq(memoryRelations.id, existing.id))
          .returning()
          .get();
        if (!next) {
          throw new DomainError(
            'conflict',
            `relations.compare: ${existing.id} was concurrently mutated`,
          );
        }
        if (input.relation === 'supersedes') {
          applySupersedesSideEffect(tx, input.sourceId, input.targetId);
        }
        return next;
      });
      return updated;
    }

    // Fresh row.
    const inserted = this.db.transaction((tx) => {
      const row = tx
        .insert(memoryRelations)
        .values({
          id: ulid(ts.getTime()),
          judgmentId: ulid(ts.getTime()),
          sourceId: input.sourceId,
          targetId: input.targetId,
          relation: input.relation,
          status: 'judged',
          reason: input.reason ?? null,
          evidence: input.evidence ?? null,
          confidence: input.confidence,
          markedByKind: input.kind ?? 'agent',
          markedByActor: input.actor,
          judgedAt: ts,
          createdAt: ts,
        })
        .returning()
        .get();
      if (!row) {
        throw new DomainError('conflict', 'relations.compare: insert returned no row');
      }
      if (input.relation === 'supersedes') {
        applySupersedesSideEffect(tx, input.sourceId, input.targetId);
      }
      return row;
    });
    return inserted;
  }

  /**
   * Mark a pending row as `orphaned`. The consolidator's
   * orphan-promotion pass calls this when the LLM itself can't reach a
   * confident verdict.
   */
  orphan(judgmentId: string, reason: string): MemoryRelation {
    const ts = this.now();
    const updated = this.db
      .update(memoryRelations)
      .set({
        status: 'orphaned',
        reason,
        markedByKind: 'consolidator',
        judgedAt: ts,
      })
      .where(and(eq(memoryRelations.judgmentId, judgmentId), eq(memoryRelations.status, 'pending')))
      .returning()
      .get();
    if (!updated) {
      throw new DomainError(
        'memory_not_found',
        `relations.orphan: ${judgmentId} not found or not pending`,
      );
    }
    return updated;
  }

  /**
   * Operator-only: close a pending judgment as orphaned from the
   * dashboard. Unlike `orphan` (the consolidator path) this marks the
   * row `markedByKind='system'` and leaves `reason` untouched. Returns
   * false when the judgment is missing or already closed.
   */
  orphanByOperator(judgmentId: string): boolean {
    const result = this.db
      .update(memoryRelations)
      .set({ status: 'orphaned' as const, markedByKind: 'system' as const, judgedAt: this.now() })
      .where(and(eq(memoryRelations.judgmentId, judgmentId), eq(memoryRelations.status, 'pending')))
      .run();
    return result.changes > 0;
  }

  /** Fetch a relation row by `judgmentId`. */
  findByJudgmentId(judgmentId: string): MemoryRelation | undefined {
    return this.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.judgmentId, judgmentId))
      .get();
  }

  /**
   * Return all rows whose `source_id` or `target_id` is `memoryId`,
   * shaped as annotation views for `memory.search` / `memory.get`. Cap
   * at `limit`. Hides `relation='not_conflict'` rows from the output —
   * those are acknowledged false positives and shouldn't surface as
   * annotations.
   */
  listForMemory(memoryId: string, limit = 10): RelationView[] {
    const rows = this.db
      .select()
      .from(memoryRelations)
      .where(
        sql`(source_id = ${memoryId} OR target_id = ${memoryId})
          AND (relation IS NULL OR relation != 'not_conflict')`,
      )
      .all();

    const out: RelationView[] = [];
    for (const r of rows) {
      const isSource = r.sourceId === memoryId;
      const otherId = isSource ? r.targetId : r.sourceId;
      const status = r.status;

      if (status === 'pending') {
        out.push({
          kind: 'pending_conflict',
          targetId: otherId,
          judgmentId: r.judgmentId,
          status,
        });
        continue;
      }
      if (status === 'orphaned') {
        // Orphaned rows are admin-visible only; not surfaced as
        // annotations in search results.
        continue;
      }

      const kind: RelationView['kind'] =
        r.relation === 'supersedes' && !isSource ? 'superseded_by' : (r.relation ?? 'related');
      out.push({
        kind,
        targetId: otherId,
        status,
        reason: r.reason,
        confidence: r.confidence,
      });
    }
    return out.slice(0, limit);
  }

  /**
   * Bulk variant for `memory.search`: takes a list of memory ids and
   * returns a Map from each id to its annotation list. Single JOIN, no
   * N+1.
   */
  listForMemories(memoryIds: readonly string[], capPerMemory = 10): Map<string, RelationView[]> {
    if (memoryIds.length === 0) return new Map();
    const idSet = sql.join(
      memoryIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = this.db.all<{
      id: string;
      judgment_id: string;
      source_id: string;
      target_id: string;
      relation: RelationKind | null;
      status: 'pending' | 'judged' | 'orphaned';
      reason: string | null;
      confidence: number | null;
    }>(
      sql`SELECT id, judgment_id, source_id, target_id, relation, status, reason, confidence
         FROM memory_relations
         WHERE (source_id IN (${idSet}) OR target_id IN (${idSet}))
           AND (relation IS NULL OR relation != 'not_conflict')
           AND status != 'orphaned'`,
    );

    const out = new Map<string, RelationView[]>();
    for (const id of memoryIds) out.set(id, []);

    for (const r of rows) {
      // Each row gets annotated against BOTH endpoints if both are in
      // the input set; that mirrors how `listForMemory` would behave
      // when called individually.
      for (const id of [r.source_id, r.target_id]) {
        if (!memoryIds.includes(id)) continue;
        const isSource = r.source_id === id;
        const otherId = isSource ? r.target_id : r.source_id;
        if (r.status === 'pending') {
          appendCapped(
            out,
            id,
            {
              kind: 'pending_conflict',
              targetId: otherId,
              judgmentId: r.judgment_id,
              status: 'pending',
            },
            capPerMemory,
          );
          continue;
        }
        const kind: RelationView['kind'] =
          r.relation === 'supersedes' && !isSource ? 'superseded_by' : (r.relation ?? 'related');
        appendCapped(
          out,
          id,
          {
            kind,
            targetId: otherId,
            status: 'judged',
            reason: r.reason,
            confidence: r.confidence,
          },
          capPerMemory,
        );
      }
    }
    return out;
  }

  /**
   * Find pending relations older than `cutoffMs`, in ascending creation
   * order. Used by the consolidator's orphan-promotion pass.
   */
  findPendingOlderThan(cutoffMs: number, limit: number): MemoryRelation[] {
    const cutoff = new Date(this.now().getTime() - cutoffMs);
    return this.db
      .select()
      .from(memoryRelations)
      .where(and(eq(memoryRelations.status, 'pending'), lt(memoryRelations.createdAt, cutoff)))
      .orderBy(memoryRelations.createdAt)
      .limit(limit)
      .all();
  }

  /** Count rows by status. Used by `memory.stats` and the dashboard. */
  countByStatus(): Record<'pending' | 'judged' | 'orphaned', number> {
    const out: Record<'pending' | 'judged' | 'orphaned', number> = {
      pending: 0,
      judged: 0,
      orphaned: 0,
    };
    const rows = this.db
      .select({ status: memoryRelations.status, count: sql<number>`count(*)` })
      .from(memoryRelations)
      .groupBy(memoryRelations.status)
      .all();
    for (const r of rows) {
      out[r.status] = Number(r.count);
    }
    return out;
  }

  /** @internal — exposed for cross-scope invariant tests. */
  private assertSameScope(sourceId: string, targetId: string): void {
    const a = this.db
      .select({ scope: memory.scope, projectId: memory.projectId })
      .from(memory)
      .where(eq(memory.id, sourceId))
      .get();
    const b = this.db
      .select({ scope: memory.scope, projectId: memory.projectId })
      .from(memory)
      .where(eq(memory.id, targetId))
      .get();
    if (!a || !b) {
      throw new DomainError(
        'memory_not_found',
        `relations: source or target memory not found (source=${sourceId}, target=${targetId})`,
      );
    }
    if (a.scope !== b.scope || a.projectId !== b.projectId) {
      throw new DomainError(
        'forbidden',
        `cross_scope_relation: source and target span different (scope, project_id) tuples`,
      );
    }
  }
}

function appendCapped<T>(map: Map<string, T[]>, key: string, value: T, cap: number): void {
  const arr = map.get(key);
  if (!arr) {
    map.set(key, [value]);
    return;
  }
  if (arr.length >= cap) return;
  arr.push(value);
}

/**
 * Atomic side effect of judging `supersedes`: target → status='superseded',
 * source's `replaces` array gains the target's id (deduplicated).
 *
 * Called inside the surrounding transaction so a failure rolls back the
 * relation update too.
 */
function applySupersedesSideEffect(tx: Db, sourceId: string, targetId: string): void {
  const source = tx
    .select({ replaces: memory.replaces })
    .from(memory)
    .where(eq(memory.id, sourceId))
    .get();
  if (!source) {
    throw new DomainError('memory_not_found', `relations.judge: source ${sourceId} disappeared`);
  }
  const nextReplaces = Array.from(new Set<string>([...source.replaces, targetId]));

  tx.update(memory)
    .set({ status: 'superseded' as const })
    .where(and(eq(memory.id, targetId), eq(memory.status, 'active')))
    .run();
  tx.update(memory).set({ replaces: nextReplaces }).where(eq(memory.id, sourceId)).run();
}
