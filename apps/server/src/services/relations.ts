import { ulid } from 'ulid';

import type { TransactionRunner } from '../db/client.js';
import type { Repositories } from '../db/repositories/index.js';
import {
  type MemoryRelation,
  type MarkedByKind,
  type RelationKind,
} from '../db/schema/memory-relations.js';

import { DomainError } from './errors.js';
import { RANK_WINDOW_CEILING } from './hybrid-search.js';
import { memoryMatchesScope, type Scope } from './scope.js';

/**
 * Service for the judgment graph between memories.
 *
 * Three entry points:
 *   - `createPending` — called by `memory.save` when a candidate detector
 *     surfaces a similar memory; inserts with status='pending'
 *   - `judge` / `judgeInScope` — called by `memory.judge` (agent, via the
 *     scoped variant) or the consolidator's orphan-promotion pass;
 *     transitions pending → judged and, for `relation='supersedes'`,
 *     mutates the target memory row
 *   - `compare` / `compareInScope` — called by `memory.compare`
 *     (agent-driven proactive analysis, via the scoped variant); upserts a
 *     judged row directly without a preceding save
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
  kind: AnnotationKind;
  targetId: string;
  judgmentId?: string;
  status: 'pending' | 'judged' | 'orphaned';
  reason?: string | null;
  confidence?: number | null;
}

/** The kinds an annotation can carry. `not_conflict` is absent — see `toOrderedAnnotation`. */
export type AnnotationKind =
  | Exclude<RelationKind, 'not_conflict'>
  | 'superseded_by'
  | 'pending_conflict';

/**
 * Annotation precedence, lowest first: contradiction, then the two lifecycle
 * edges, then unjudged candidates, then the informational tags. The two
 * load-bearing groups lead so a flood of `related` rows — 82% of a judged graph
 * — or of `pending_conflict` rows cannot evict them from a bounded list.
 */
export const ANNOTATION_TIER: Record<AnnotationKind, number> = {
  conflicts_with: 0,
  supersedes: 1,
  superseded_by: 2,
  pending_conflict: 3,
  scoped: 4,
  compatible: 5,
  related: 6,
};

/** The highest `relations` bound any read surface will serve, shared by all of them. */
export const RELATION_ANNOTATION_MAX = 50;

/**
 * The two inputs the response budget is derived from. They live here, not in the
 * MCP schema that enforces them, so the budget can be a real product rather than a
 * literal restating numbers declared a layer above it — services never import from
 * `mcp/`. The schema reads them back.
 */
export const SEARCH_LIMIT_MAX = 200;
export const MULTI_ROW_ANNOTATION_DEFAULT = 10;

/**
 * Character bound applied to a judged annotation's `reason` on the MULTI-ROW
 * surfaces. A read projection, never a write: `memory_relations.reason` keeps the
 * full stored text, which append-only requires.
 *
 * 350 is the value `CONTEXT_SNIPPET_CHARS` already ships for every other
 * multi-item text projection, so no new number is invented. Measured: `reason` is
 * 94% of a judged annotation (2 127 pretty chars verbatim against 129 with it
 * removed), and bounding it here takes the worst legal request from 40.53 MB
 * transported to 1.81 MB.
 */
export const ANNOTATION_REASON_CHARS = 350;

/**
 * Maximum annotations one multi-row response may project, bounding
 * `rows × per-row bound` rather than either alone.
 *
 * Derived from the shipped numbers rather than written as a literal, so raising an
 * input moves the budget visibly instead of leaving a stale constant. Its value is
 * exactly the worst case the server ALREADY serves when nobody passes
 * `relations_limit`, so no default request can ever be rejected and the ceiling
 * introduces no payload regime that is not already shipping.
 *
 * The row term is `RANK_WINDOW_CEILING`, not `SEARCH_LIMIT_MAX`. Review caught the
 * first version using the latter: `memory.search`'s ENTITY branch sets its page size
 * to `RANK_WINDOW_CEILING` when the caller names no `limit` (that branch is specified
 * as complete within scope), so the true default worst case is 400 x 10, not
 * 200 x 10. Budgeting against the smaller number let `search({ entity,
 * relations_limit: 50 })` serve 20 000 annotations — twice the regression this bound
 * exists to remove.
 */
export const RELATION_ANNOTATION_RESPONSE_BUDGET =
  RANK_WINDOW_CEILING * MULTI_ROW_ANNOTATION_DEFAULT;

/**
 * Ceiling on the serialized bytes of the largest LEGAL annotation payload, counting
 * both copies `mcp/result.ts::ok()` emits (a `text` block plus `structuredContent`).
 *
 * Measured, not chosen: at the budget with `reason` bounded, the annotation
 * projection is **3 792 003 bytes**, against 40.53 MB before this change. Asserted
 * in CI so a future change that widens the payload must either fit or raise this
 * number and record the re-measurement — the same contract `DESCRIPTION_MAX_LENGTH`
 * carries for tool descriptions.
 *
 * It bounds the ANNOTATION projection alone, not the whole `CallToolResult`. A
 * result also carries `content`, which this change deliberately leaves unbounded
 * (design D8) and which would otherwise make this ceiling a function of how long the
 * memories happen to be rather than of the constants it exists to pin — the first
 * version measured the whole result and was an artifact of its fixture's 600-char
 * bodies.
 */
export const ANNOTATION_PAYLOAD_CEILING_BYTES = 4_000_000;

/** Exactly what the order reads. A caller that only sorts needs nothing else. */
export interface AnnotationKey {
  kind: AnnotationKind;
  createdAt: Date;
  /** Unique-indexed, which is what makes the annotation order total rather than merely stable. */
  judgmentId: string;
}

export interface OrderedAnnotation extends AnnotationKey {
  view: RelationView;
}

/** A memory's annotations, bounded and ordered, with the count that existed before the bound. */
export interface AnnotationPage {
  views: RelationView[];
  total: number;
}

/**
 * Total order over annotations, applied before any bound: tier, then most
 * recently created, then `judgment_id`. The third key never ties, so a batch of
 * judgments sharing a `created_at` millisecond is still ordered deterministically
 * instead of being left to the scan order this comparator exists to replace.
 */
export function compareAnnotations(a: AnnotationKey, b: AnnotationKey): number {
  const tier = ANNOTATION_TIER[a.kind] - ANNOTATION_TIER[b.kind];
  if (tier !== 0) return tier;
  const age = b.createdAt.getTime() - a.createdAt.getTime();
  if (age !== 0) return age;
  return a.judgmentId < b.judgmentId ? -1 : a.judgmentId > b.judgmentId ? 1 : 0;
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
    return this.applyJudgment(existing, judgmentId, input);
  }

  /**
   * Scoped variant of `judge` for agent-facing callers: the judgment's
   * source and target must both lie in `scope`. A missing or out-of-scope
   * judgmentId raises the same error, so cross-scope existence never leaks.
   */
  judgeInScope(judgmentId: string, scope: Scope, input: JudgeInput): MemoryRelation {
    const existing = this.repos.relations.findByJudgmentIdInScope(judgmentId, {
      projectId: scope.projectId,
    });
    if (!existing) {
      throw new DomainError(
        'memory_not_found',
        `relations.judge: judgmentId ${judgmentId} not found in this scope`,
      );
    }
    return this.applyJudgment(existing, judgmentId, input);
  }

  private applyJudgment(
    existing: MemoryRelation,
    judgmentId: string,
    input: JudgeInput,
  ): MemoryRelation {
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
   * Scoped variant of `compare`: both memories must lie in `scope`. A
   * missing or out-of-scope id raises the same error, so cross-scope
   * existence never leaks.
   */
  compareInScope(input: CompareInput, scope: Scope): MemoryRelation {
    for (const id of [input.sourceId, input.targetId]) {
      const tuple = this.repos.memory.findScopeTupleById(id);
      if (!tuple || !memoryMatchesScope(tuple, scope)) {
        throw new DomainError(
          'memory_not_found',
          `relations.compare: memory ${id} not found in this scope`,
        );
      }
    }
    return this.compare(input);
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
    const applySideEffect = input.relation === 'supersedes';

    if (existing) {
      return this.tx.transaction(() => {
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
        if (applySideEffect) {
          this.applySupersedesSideEffect(input.sourceId, input.targetId);
        }
        return next;
      });
    }

    return this.tx.transaction(() => {
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
      if (applySideEffect) {
        this.applySupersedesSideEffect(input.sourceId, input.targetId);
      }
      return row;
    });
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
   * shaped as annotation views for `memory.search` / `memory.get`,
   * ordered by `compareAnnotations` and bounded at `limit`. `total`
   * counts the annotations that exist after the `not_conflict` and
   * `orphaned` exclusions and before the bound — `listTouching`, unlike
   * `listTouchingAny`, does not filter orphaned rows in SQL, so it is
   * never `rows.length`.
   */
  listForMemory(memoryId: string, limit = 10): AnnotationPage {
    const ordered: OrderedAnnotation[] = [];
    for (const r of this.repos.relations.listTouching(memoryId)) {
      const entry = toOrderedAnnotation(r, memoryId);
      if (entry) ordered.push(entry);
    }
    ordered.sort(compareAnnotations);
    return { views: ordered.slice(0, limit).map((e) => e.view), total: ordered.length };
  }

  /**
   * Bulk variant for `memory.search`: takes a list of memory ids and
   * returns a Map from each id to its annotation page. Single JOIN, no
   * N+1.
   */
  listForMemories(memoryIds: readonly string[], capPerMemory = 10): Map<string, AnnotationPage> {
    if (memoryIds.length === 0) return new Map();
    const rows = this.repos.relations.listTouchingAny(memoryIds);

    const ordered = new Map<string, OrderedAnnotation[]>();
    for (const id of memoryIds) ordered.set(id, []);

    for (const r of rows) {
      // Each row gets annotated against BOTH endpoints if both are in
      // the input set; that mirrors how `listForMemory` would behave
      // when called individually — and is why `total` counts views, not rows.
      for (const id of [r.sourceId, r.targetId]) {
        const bucket = ordered.get(id);
        if (!bucket) continue;
        const entry = toOrderedAnnotation(r, id);
        if (entry) bucket.push(entry);
      }
    }

    const out = new Map<string, AnnotationPage>();
    for (const [id, bucket] of ordered) {
      bucket.sort(compareAnnotations);
      out.set(id, {
        views: bucket.slice(0, capPerMemory).map((e) => e.view),
        total: bucket.length,
      });
    }
    return out;
  }

  /**
   * Find pending relations older than `cutoffMs` whose endpoints both lie
   * in `scope`, in ascending creation order. Used by the consolidator's
   * per-scope orphan-promotion pass.
   */
  findPendingOlderThanInScope(opts: {
    projectId: string;
    cutoffMs: number;
    limit: number;
  }): Pick<MemoryRelation, 'judgmentId' | 'sourceId' | 'targetId'>[] {
    return this.repos.relations.findPendingOlderThanInScope({
      projectId: opts.projectId,
      cutoffMs: this.now().getTime() - opts.cutoffMs,
      limit: opts.limit,
    });
  }

  /** Scoped pending-judgment total — the queue-depth signal `memory.context`/`memory.stats` surface. */
  countPendingInScope(scope: Scope): number {
    return this.repos.relations.countPendingInScope({ projectId: scope.projectId });
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
    const target = this.repos.memory.findScopeTupleById(targetId);
    if (!target) {
      throw new DomainError('memory_not_found', `relations.judge: target ${targetId} disappeared`);
    }
    // Already applied by this pair: a no-op, not the rewrite guarded against below.
    if (target.status === 'superseded' && source.replaces.includes(targetId)) return;

    for (const [role, id, row] of [
      ['source', sourceId, source],
      ['target', targetId, target],
    ] as const) {
      if (row.status !== 'active') {
        throw new DomainError(
          'conflict',
          `relations.judge: ${role} ${id} is '${row.status}', not active; ` +
            "'supersedes' rewrites the lifecycle of both memories and would retire a row on the authority of a retired one",
        );
      }
    }
    const nextReplaces = Array.from(new Set<string>([...source.replaces, targetId]));

    this.repos.memory.markSuperseded(targetId);
    this.repos.memory.setReplaces(sourceId, nextReplaces);
  }
}

/**
 * Project one relation row into the annotation `memoryId` would see, or `null`
 * when that memory is shown nothing. Orphaned rows are admin-visible only, and
 * `listTouching` — unlike `listTouchingAny` — does not filter them in SQL, so
 * that branch is load-bearing for the single-memory read. `not_conflict` is an
 * acknowledged false positive, excluded here and in both repository queries.
 */
function toOrderedAnnotation(r: MemoryRelation, memoryId: string): OrderedAnnotation | null {
  if (r.status === 'orphaned' || r.relation === 'not_conflict') return null;

  const kind = annotationKindFor(r, memoryId);
  const otherId = r.sourceId === memoryId ? r.targetId : r.sourceId;
  const keys = { kind, createdAt: r.createdAt, judgmentId: r.judgmentId };

  if (r.status === 'pending') {
    return {
      view: { kind, targetId: otherId, judgmentId: r.judgmentId, status: 'pending' },
      ...keys,
    };
  }
  return {
    view: { kind, targetId: otherId, status: 'judged', reason: r.reason, confidence: r.confidence },
    ...keys,
  };
}

/**
 * The receiver's point of view on a relation row: the same row is `supersedes` to
 * its source and `superseded_by` to its target, which is why the ordering key
 * cannot be an `ORDER BY` column. Shared by the MCP annotation projection and the
 * dashboard's judgment table so the two cannot disagree about a row's tier.
 */
export function annotationKindFor(
  r: Pick<MemoryRelation, 'relation' | 'status' | 'sourceId'>,
  memoryId: string,
): AnnotationKind {
  // `orphaned` counts as unjudged, not as judged-`related`: the MCP projection
  // drops those rows before they reach here, but the dashboard shows them.
  if (r.status === 'pending' || r.status === 'orphaned') return 'pending_conflict';
  if (r.relation === 'supersedes' && r.sourceId !== memoryId) return 'superseded_by';
  return r.relation === null || r.relation === 'not_conflict' ? 'related' : r.relation;
}
