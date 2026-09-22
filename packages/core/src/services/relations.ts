import {
  memoryMatchesScope,
  type MarkedByKind,
  type MemoryRelation,
  type RelationKind,
  type Repositories,
  type Scope,
  type TransactionRunner,
} from '@rembric/db';
import { ulid } from 'ulid';

import { DomainError } from './errors.js';
import { RANK_WINDOW_CEILING } from './hybrid-search.js';

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

export const SEARCH_LIMIT_MAX = 200;
export const MULTI_ROW_ANNOTATION_DEFAULT = 10;

export const ANNOTATION_REASON_CHARS = 350;

export const RELATION_ANNOTATION_RESPONSE_BUDGET =
  RANK_WINDOW_CEILING * MULTI_ROW_ANNOTATION_DEFAULT;

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

  listForMemory(memoryId: string, limit = 10): AnnotationPage {
    const ordered: OrderedAnnotation[] = [];
    for (const r of this.repos.relations.listTouching(memoryId)) {
      const entry = toOrderedAnnotation(r, memoryId);
      if (entry) ordered.push(entry);
    }
    ordered.sort(compareAnnotations);
    return { views: ordered.slice(0, limit).map((e) => e.view), total: ordered.length };
  }

  listForMemories(memoryIds: readonly string[], capPerMemory = 10): Map<string, AnnotationPage> {
    if (memoryIds.length === 0) return new Map();
    const rows = this.repos.relations.listTouchingAny(memoryIds);

    const ordered = new Map<string, OrderedAnnotation[]>();
    for (const id of memoryIds) ordered.set(id, []);

    for (const r of rows) {
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

export function annotationKindFor(
  r: Pick<MemoryRelation, 'relation' | 'status' | 'sourceId'>,
  memoryId: string,
): AnnotationKind {
  if (r.status === 'pending' || r.status === 'orphaned') return 'pending_conflict';
  if (r.relation === 'supersedes' && r.sourceId !== memoryId) return 'superseded_by';
  return r.relation === null || r.relation === 'not_conflict' ? 'related' : r.relation;
}
