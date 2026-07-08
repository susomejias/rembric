import { ulid } from 'ulid';

import type { TransactionRunner } from '../db/client.js';
import type { Repositories } from '../db/repositories/index.js';
import {
  type MemoryRelation,
  type MarkedByKind,
  type RelationKind,
} from '../db/schema/memory-relations.js';
import type { MemoryScope } from '../db/schema/memory.js';

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
  judgmentId?: string;
  status: 'pending' | 'judged' | 'orphaned';
  reason?: string | null;
  confidence?: number | null;
}

export class RelationsService {
  constructor(
    private readonly repos: Pick<Repositories, 'relations' | 'memory'>,
    private readonly tx: TransactionRunner,
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
    const row = this.repos.relations.insert({
      id: ulid(ts.getTime()),
      judgmentId: ulid(ts.getTime()),
      sourceId: input.sourceId,
      targetId: input.targetId,
      relation: null,
      status: 'pending',
      markedByKind: input.markedByKind ?? null,
      createdAt: ts,
    });
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
   */
  judge(judgmentId: string, input: JudgeInput): MemoryRelation {
    const existing = this.repos.relations.findByJudgmentId(judgmentId);
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
    const updated = this.tx.transaction(() => {
      // 1. Transition relation → judged.
      const next = this.repos.relations.markJudged(
        existing.id,
        {
          relation: input.relation,
          reason: input.reason ?? null,
          evidence: input.evidence ?? null,
          confidence: input.confidence ?? null,
          markedByKind: input.kind,
          markedByActor: input.actor,
          judgedAt: ts,
        },
        { requirePending: true },
      );
      if (!next) {
        throw new DomainError(
          'conflict',
          `relations.judge: ${judgmentId} was concurrently mutated`,
        );
      }

      // 2. Side effect for `supersedes`: target → superseded, source.replaces += target.id.
      if (input.relation === 'supersedes') {
        this.applySupersedesSideEffect(existing.sourceId, existing.targetId);
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

    const existing = this.repos.relations.findBySourceAndTarget(input.sourceId, input.targetId);

    const ts = this.now();

    if (existing) {
      const updated = this.tx.transaction(() => {
        const next = this.repos.relations.markJudged(
          existing.id,
          {
            relation: input.relation,
            reason: input.reason ?? null,
            evidence: input.evidence ?? null,
            confidence: input.confidence,
            markedByKind: input.kind ?? 'agent',
            markedByActor: input.actor,
            judgedAt: ts,
          },
          { requirePending: false },
        );
        if (!next) {
          throw new DomainError(
            'conflict',
            `relations.compare: ${existing.id} was concurrently mutated`,
          );
        }
        if (input.relation === 'supersedes') {
          this.applySupersedesSideEffect(input.sourceId, input.targetId);
        }
        return next;
      });
      return updated;
    }

    // Fresh row.
    const inserted = this.tx.transaction(() => {
      const row = this.repos.relations.insert({
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
      });
      if (!row) {
        throw new DomainError('conflict', 'relations.compare: insert returned no row');
      }
      if (input.relation === 'supersedes') {
        this.applySupersedesSideEffect(input.sourceId, input.targetId);
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
    const updated = this.repos.relations.markOrphanedPending(judgmentId, {
      reason,
      markedByKind: 'consolidator',
      judgedAt: this.now(),
    });
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
    const updated = this.repos.relations.markOrphanedPending(judgmentId, {
      markedByKind: 'system',
      judgedAt: this.now(),
    });
    return updated !== undefined;
  }

  /** Fetch a relation row by `judgmentId`. */
  findByJudgmentId(judgmentId: string): MemoryRelation | undefined {
    return this.repos.relations.findByJudgmentId(judgmentId);
  }

  /**
   * Return all rows whose `source_id` or `target_id` is `memoryId`,
   * shaped as annotation views for `memory.search` / `memory.get`. Cap
   * at `limit`. Hides `relation='not_conflict'` rows from the output —
   * those are acknowledged false positives and shouldn't surface as
   * annotations.
   */
  listForMemory(memoryId: string, limit = 10): RelationView[] {
    const rows = this.repos.relations.listTouching(memoryId);

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
    const rows = this.repos.relations.listTouchingAny(memoryIds);

    const out = new Map<string, RelationView[]>();
    for (const id of memoryIds) out.set(id, []);

    for (const r of rows) {
      // Each row gets annotated against BOTH endpoints if both are in
      // the input set; that mirrors how `listForMemory` would behave
      // when called individually.
      for (const id of [r.sourceId, r.targetId]) {
        if (!memoryIds.includes(id)) continue;
        const isSource = r.sourceId === id;
        const otherId = isSource ? r.targetId : r.sourceId;
        if (r.status === 'pending') {
          appendCapped(
            out,
            id,
            {
              kind: 'pending_conflict',
              targetId: otherId,
              judgmentId: r.judgmentId,
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
   * Find pending relations older than `cutoffMs` whose endpoints both lie
   * in `scope`, in ascending creation order. Used by the consolidator's
   * per-scope orphan-promotion pass.
   */
  findPendingOlderThanInScope(opts: {
    scope: MemoryScope;
    projectId: string | null;
    cutoffMs: number;
    limit: number;
  }): Pick<MemoryRelation, 'judgmentId' | 'sourceId' | 'targetId'>[] {
    return this.repos.relations.findPendingOlderThanInScope({
      scope: opts.scope,
      projectId: opts.projectId,
      cutoffMs: this.now().getTime() - opts.cutoffMs,
      limit: opts.limit,
    });
  }

  /** Count rows by status. Used by `memory.stats` and the dashboard. */
  countByStatus(): Record<'pending' | 'judged' | 'orphaned', number> {
    const out: Record<'pending' | 'judged' | 'orphaned', number> = {
      pending: 0,
      judged: 0,
      orphaned: 0,
    };
    for (const r of this.repos.relations.countRowsByStatus()) {
      out[r.status] = Number(r.count);
    }
    return out;
  }

  /** @internal — exposed for cross-scope invariant tests. */
  private assertSameScope(sourceId: string, targetId: string): void {
    const a = this.repos.memory.findScopeTupleById(sourceId);
    const b = this.repos.memory.findScopeTupleById(targetId);
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

  /**
   * Atomic side effect of judging `supersedes`: target → status='superseded',
   * source's `replaces` array gains the target's id (deduplicated).
   *
   * Runs inside the surrounding transaction so a failure rolls back the
   * relation update too.
   */
  private applySupersedesSideEffect(sourceId: string, targetId: string): void {
    const source = this.repos.memory.findScopeTupleById(sourceId);
    if (!source) {
      throw new DomainError('memory_not_found', `relations.judge: source ${sourceId} disappeared`);
    }
    const nextReplaces = Array.from(new Set<string>([...source.replaces, targetId]));

    this.repos.memory.markSuperseded(targetId);
    this.repos.memory.setReplaces(sourceId, nextReplaces);
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
