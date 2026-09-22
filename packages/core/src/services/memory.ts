import {
  memoryMatchesScope,
  type ConfirmationVerdict,
  type ConsolidationOpType,
  type Memory,
  type MemorySource,
  type MemoryStatus,
  type MemoryType,
  type Repositories,
  type Scope,
  type SearchScope,
  type TransactionRunner,
} from '@rembric/db';
import { ulid } from 'ulid';

import { DomainError } from './errors.js';
import {
  hybridSearch,
  type HybridSearchOpts,
  type HybridSearchResult,
  RANK_WINDOW_CEILING,
  type SearchVerdict,
} from './hybrid-search.js';
import {
  type DerivedReview,
  deriveReviewState,
  REFUTED_PRIORITY_MS,
  reviewTtlEntries,
  type ReviewState,
} from './review.js';
import { assertNoNul, sliceWithoutSplittingSurrogatePair } from './strings.js';

const ARCHIVED_MEMORY_PURGE_REASONING = 'operator purge of disconnected archived memories';
const AGENT_MEMORY_ARCHIVE_REASONING = 'agent archived memory at explicit user request';

// The candidate query has no LIMIT, so keep the per-statement payload bounded.
const PURGE_DELETE_SLICE = 5_000;

export const TITLE_MAX_CHARS = 100;

export function deriveTitle(content: string): string {
  const firstLine = content.split('\n', 1)[0] ?? '';
  const stripped = firstLine.replace(/^[\s*#`]+/, '').trim();
  const collapsed = (stripped || content.trim()).replace(/\s+/g, ' ');
  return sliceWithoutSplittingSurrogatePair(collapsed, TITLE_MAX_CHARS);
}

export interface SaveMemoryInput {
  type: MemoryType;
  /** Short human-readable label, 1..100 chars. Required. */
  title: string;
  content: string;
  tags?: string[];
  source?: MemorySource;
  sessionId?: string | null;
  topicKey?: string | null;
}

export interface SaveResult {
  memory: Memory;
  supersededByTopicKey: Memory | null;
}

export interface ConfirmOptions {
  source?: MemorySource;
  sessionId?: string | null;
  /** Default `'affirm'`. `'refute'` requires `reason` and never touches `last_seen_at`. */
  verdict?: ConfirmationVerdict;
  /** Required when `verdict: 'refute'`; optional otherwise. */
  reason?: string;
}

/** Deliberately not part of `SearchMemoriesInput`, so no MCP tool schema can reach these. */
export type GateOverrides = Pick<
  HybridSearchOpts,
  'abstentionFloor' | 'relativeLevelRatio' | 'onGateWindow'
>;

export interface SearchMemoriesInput {
  query?: string;
  type?: MemoryType;
  tag?: string;
  /** Exact topic_key filter — see openspec/changes/fix-audited-defects. */
  topicKey?: string;
  entity?: string;
  status?: MemoryStatus;
  limit?: number;
  offset?: number;
}

export type PredecessorView = Pick<Memory, 'id' | 'title' | 'status' | 'createdAt'>;

export interface MemoryWithHistory {
  memory: Memory;
  /** Bounded to PREDECESSOR_CAP nearest predecessors, breadth-first. Content-free by construction. */
  predecessors: PredecessorView[];
  /** Number of predecessors actually returned (== predecessors.length). */
  predecessorCount: number;
  /** True when the reachable `replaces` graph has more predecessors than the cap. */
  truncated: boolean;
  head: Memory;
  /** True when head resolution stopped at its hop cap without finding an active row. */
  headTruncated: boolean;
  confirmationCount: number;
  /** Derived review state of the active head; null when the head is not active. */
  reviewState: ReviewState | null;
  /** Derived re-verification deadline of the head; null when no TTL applies. */
  reviewAfter: Date | null;
  /** Review queue's terminal state: derived, never stored, never a decay input. */
  reviewEscalated: boolean;
}

/** A single `needsReview` context entry: the stale memory plus its derived timing. */
export interface NeedsReviewItem {
  memory: Memory;
  reviewAfter: Date;
  reviewBaseline: Date;
}

export class MemoryService {
  constructor(
    private readonly repos: Pick<
      Repositories,
      'memory' | 'consolidation' | 'vectors' | 'entities' | 'relations' | 'termStatistics'
    >,
    private readonly tx: TransactionRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly embedQuery?: (text: string) => Promise<Float32Array>,
  ) {}

  save(input: SaveMemoryInput, scope: Scope): Memory {
    const { memory: m } = this.saveWithTopicKey(input, scope);
    return m;
  }

  saveWithTopicKey(input: SaveMemoryInput, scope: Scope): SaveResult {
    if (input.content.trim().length === 0) {
      throw new DomainError('invalid_input', 'memory.save: content must be non-empty');
    }
    assertNoNul('memory.save', 'content', input.content);
    const { title } = input;
    if (title.trim().length === 0 || title.length > TITLE_MAX_CHARS) {
      throw new DomainError(
        'invalid_input',
        `memory.save: title must be 1..${TITLE_MAX_CHARS} non-blank chars`,
      );
    }
    assertNoNul('memory.save', 'title', title);
    for (const tag of input.tags ?? []) assertNoNul('memory.save', 'tags', tag);
    const topicKey = normalizeTopicKey(input.topicKey);

    const ts = this.now();
    const id = ulid(ts.getTime());

    return this.tx.transaction((): SaveResult => {
      // Locate any prior active row in the same (scope, project_id, topic_key).
      let supersededByTopicKey: Memory | null = null;
      let replacesPrefix: string[] = [];
      if (topicKey !== null) {
        const prior = this.repos.memory.findActiveByTopicKey({
          projectId: scope.projectId,
          topicKey,
        });
        if (prior) {
          supersededByTopicKey = prior;
          replacesPrefix = [prior.id];
        }
      }

      if (supersededByTopicKey) {
        this.repos.memory.markSuperseded(supersededByTopicKey.id);
      }

      const inserted = this.repos.memory.insert({
        id,
        scope: 'project',
        projectId: scope.projectId,
        type: input.type,
        title,
        content: input.content,
        tags: input.tags ?? [],
        status: 'active',
        replaces: replacesPrefix,
        createdAt: ts,
        lastSeenAt: ts,
        source: input.source ?? null,
        sessionId: input.sessionId ?? null,
        topicKey,
      });
      if (!inserted) {
        throw new DomainError('conflict', 'memory.save: insert did not return a row');
      }

      if (supersededByTopicKey) {
        // No same-scope assertion needed: findActiveByTopicKey matched on (scope, project_id).
        const relId = ulid(ts.getTime());
        this.repos.relations.insert({
          id: relId,
          judgmentId: relId,
          sourceId: inserted.id,
          targetId: supersededByTopicKey.id,
          relation: 'supersedes',
          status: 'judged',
          reason: `topic_key='${topicKey ?? ''}' upsert`,
          confidence: 1,
          markedByKind: 'agent_topic_key',
          markedByActor: input.source?.tokenName ?? null,
          judgedAt: ts,
          createdAt: ts,
        });
      }

      return { memory: inserted, supersededByTopicKey };
    });
  }

  get(id: string, scope: Scope): MemoryWithHistory | null {
    const found = this.unsafeGetById(id);
    if (!found || !memoryMatchesScope(found, scope)) return null;

    const { rows: predecessors, truncated } = this.collectPredecessors(found);
    const { head, truncated: headTruncated } = this.findHead(found);
    const confirmationCount = this.repos.memory.countConfirmations(head.id);
    const ts = this.repos.memory.reviewTimestampsByIds([head.id]).get(head.id);
    const lastConfirmedAt = ts?.affirmedAt ?? null;
    const lastRefutedAt = ts?.refutedAt ?? null;
    const { reviewState, reviewAfter, reviewEscalated } = deriveReviewState(
      {
        type: head.type,
        createdAt: head.createdAt,
        status: head.status,
        lastConfirmedAt,
        lastRefutedAt,
      },
      this.now(),
    );
    this.repos.memory.touchLastSeen(head.id, this.now());
    return {
      memory: found,
      predecessors,
      predecessorCount: predecessors.length,
      truncated,
      head,
      headTruncated,
      confirmationCount,
      reviewState,
      reviewAfter,
      reviewEscalated,
    };
  }

  getMany(ids: readonly string[], scope: Scope): Memory[] {
    const byId = new Map(this.unsafeGetByIds(ids).map((m) => [m.id, m]));
    const out: Memory[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (m && memoryMatchesScope(m, scope)) out.push(m);
    }
    return out;
  }

  reviewStateForMemories(
    memories: readonly Memory[],
  ): Map<string, Pick<DerivedReview, 'reviewState' | 'reviewAfter' | 'reviewEscalated'>> {
    const out = new Map<
      string,
      Pick<DerivedReview, 'reviewState' | 'reviewAfter' | 'reviewEscalated'>
    >();
    if (memories.length === 0) return out;
    const now = this.now();
    const ids = memories.map((m) => m.id);
    const reviewTs = this.repos.memory.reviewTimestampsByIds(ids);
    for (const m of memories) {
      const { reviewState, reviewAfter, reviewEscalated } = deriveReviewState(
        {
          type: m.type,
          createdAt: m.createdAt,
          status: m.status,
          lastConfirmedAt: reviewTs.get(m.id)?.affirmedAt ?? null,
          lastRefutedAt: reviewTs.get(m.id)?.refutedAt ?? null,
        },
        now,
      );
      out.set(m.id, { reviewState, reviewAfter, reviewEscalated });
    }
    return out;
  }

  needsReviewForContext(scope: Scope, limit: number): NeedsReviewItem[] {
    if (limit <= 0) return [];
    const now = this.now();
    const rows = this.repos.memory.findNeedsReview({
      projectId: scope.projectId,
      nowMs: now.getTime(),
      limit,
      ttlByType: reviewTtlEntries(),
      refutedPriorityMs: REFUTED_PRIORITY_MS,
    });
    if (rows.length === 0) return [];
    const ids = rows.map((m) => m.id);
    const reviewTs = this.repos.memory.reviewTimestampsByIds(ids);
    const items: NeedsReviewItem[] = [];
    for (const m of rows) {
      const { reviewAfter, reviewBaseline } = deriveReviewState(
        {
          type: m.type,
          createdAt: m.createdAt,
          status: m.status,
          lastConfirmedAt: reviewTs.get(m.id)?.affirmedAt ?? null,
          lastRefutedAt: reviewTs.get(m.id)?.refutedAt ?? null,
        },
        now,
      );
      if (reviewAfter && reviewBaseline) items.push({ memory: m, reviewAfter, reviewBaseline });
    }
    return items;
  }

  countNeedsReview(scope: Scope): number {
    return this.repos.memory.countNeedsReview({
      projectId: scope.projectId,
      nowMs: this.now().getTime(),
      ttlByType: reviewTtlEntries(),
    });
  }

  async search(input: SearchMemoriesInput, scope: SearchScope): Promise<Memory[]> {
    return (await this.searchWithAbstention(input, scope)).memories;
  }

  /** Same as `search`, plus the ranked branch's `SearchVerdict`. */
  async searchWithAbstention(
    input: SearchMemoriesInput,
    scope: SearchScope,
    gates?: GateOverrides,
  ): Promise<
    Omit<HybridSearchResult, 'ids'> & {
      memories: Memory[];
      viaEntity?: boolean;
      entityIndexDraining?: boolean;
    }
  > {
    const status = input.status ?? (input.topicKey ? undefined : 'active');
    const limit = clampLimit(input.limit);
    const offset = input.offset ?? 0;

    const query = input.query?.trim();
    const entity = input.entity?.trim();

    if (entity) {
      const entityLimit = input.limit === undefined ? RANK_WINDOW_CEILING : limit;
      const rows = this.repos.entities.findMemoriesByEntity({
        scope,
        value: entity,
        status: input.status,
        type: input.type,
        tag: input.tag,
        topicKey: input.topicKey,
        limit: query ? Math.max(offset + entityLimit, RANK_WINDOW_CEILING) : offset + entityLimit,
      });
      const filtered = query
        ? rows.filter((m) => `${m.title}\n${m.content}`.toLowerCase().includes(query.toLowerCase()))
        : rows;
      const page = filtered.slice(offset, offset + entityLimit);
      const draining =
        rows.length === 0 &&
        this.repos.entities.countPendingScans({
          scope,
        }) > 0;
      return {
        memories: page,
        abstained: false,
        viaEntity: true,
        ...(draining ? { entityIndexDraining: true } : {}),
      };
    }

    const ranked = query
      ? await hybridSearch({
          repos: this.repos,
          embedQuery: this.embedQuery,
          query,
          scope,
          status,
          type: input.type,
          tag: input.tag,
          topicKey: input.topicKey,
          limit,
          offset,
          ...gates,
        })
      : undefined;
    const verdict: SearchVerdict = {
      abstained: ranked?.abstained ?? false,
      abstainReason: ranked?.abstainReason,
      gateShortened: ranked?.gateShortened,
    };
    const ids =
      ranked?.ids ??
      this.repos.memory.searchMemoryIds({
        scope,
        status,
        type: input.type,
        tag: input.tag,
        topicKey: input.topicKey,
        limit,
        offset,
      });
    if (ids.length === 0) return { memories: [], ...verdict };

    const raw = this.repos.memory.unsafeGetByIds(ids);
    const byId = new Map(raw.map((m) => [m.id, m]));
    const ordered: Memory[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (m && (status === undefined ? m.status !== 'archived' : m.status === status))
        ordered.push(m);
    }
    return { memories: ordered, ...verdict };
  }

  confirm(id: string, scope: Scope, opts: ConfirmOptions = {}): { headTruncated: boolean } {
    const verdict = opts.verdict ?? 'affirm';
    if (verdict === 'refute') {
      if (!opts.reason || opts.reason.trim().length === 0) {
        throw new DomainError(
          'invalid_input',
          'memory.confirm: verdict=refute requires a non-empty reason',
        );
      }
      assertNoNul('memory.confirm', 'reason', opts.reason);
    }
    const found = this.unsafeGetById(id);
    if (!found || !memoryMatchesScope(found, scope)) {
      throw new DomainError('memory_not_found', `memory.confirm: id=${id} not found`);
    }
    const { head, truncated } = this.findHead(found);
    const ts = this.now();
    this.repos.memory.insertConfirmation({
      id: ulid(ts.getTime()),
      memoryId: head.id,
      eventTs: ts,
      source: opts.source ?? null,
      sessionId: opts.sessionId ?? null,
      verdict,
      reason: opts.reason ?? null,
    });
    // Refuting must not extend a memory's life.
    if (verdict === 'affirm') this.repos.memory.touchLastSeen(head.id, ts);
    return { headTruncated: truncated };
  }

  confirmMany(
    ids: readonly string[],
    scope: Scope,
    opts: ConfirmOptions = {},
  ): { confirmed: number; headTruncated: boolean } {
    const unique = [...new Set(ids)];
    return this.tx.transaction(() => {
      let headTruncated = false;
      for (const id of unique) {
        const result = this.confirm(id, scope, opts);
        headTruncated = headTruncated || result.headTruncated;
      }
      return { confirmed: unique.length, headTruncated };
    });
  }

  archive(id: string, scope: Scope): void {
    const existing = this.unsafeGetById(id);
    if (!existing || !memoryMatchesScope(existing, scope)) {
      throw new DomainError('memory_not_found', `memory.archive: id=${id} not found`);
    }
    if (existing.status !== 'active') {
      throw new DomainError(
        'conflict',
        `memory.archive: id=${id} is not in 'active' state (current=${existing.status})`,
      );
    }
    const ts = this.now();
    this.tx.transaction(() => {
      this.repos.memory.markArchived(id, ts);
      this.journalMaintenanceOp(ts, {
        opType: 'agent_memory_archive',
        affectedIds: [id],
        reasoning: AGENT_MEMORY_ARCHIVE_REASONING,
        summary: { kind: 'agent_memory_archive', archived: 1 },
      });
    });
  }

  private journalMaintenanceOp(
    ts: Date,
    op: {
      opType: ConsolidationOpType;
      affectedIds: string[];
      reasoning: string;
      summary: Record<string, unknown>;
    },
  ): void {
    const runId = ulid(ts.getTime());
    this.repos.consolidation.insertRun({
      id: runId,
      startedAt: ts,
      finishedAt: ts,
      scope: 'maintenance',
      summary: JSON.stringify(op.summary),
    });
    this.repos.consolidation.insertOp({
      id: ulid(ts.getTime()),
      runId,
      opType: op.opType,
      affectedIds: op.affectedIds,
      createdId: null,
      reasoning: op.reasoning,
      appliedAt: ts,
    });
  }

  countPurgeableDisconnectedArchived(): number {
    return this.repos.memory.countPurgeableDisconnectedArchived();
  }

  purgeDisconnectedArchived(input: { adminBypass: true }): { deletedIds: string[] } {
    if (input?.adminBypass !== true) {
      throw new DomainError(
        'forbidden',
        'memory.purgeDisconnectedArchived: adminBypass:true required (admin-only operation)',
      );
    }
    const ts = this.now();

    return this.tx.transaction((): { deletedIds: string[] } => {
      const deletedIds = this.repos.memory.findPurgeableDisconnectedArchivedIds();
      if (deletedIds.length === 0) {
        return { deletedIds: [] };
      }

      for (let i = 0; i < deletedIds.length; i += PURGE_DELETE_SLICE) {
        this.repos.memory.purgeByIds(deletedIds.slice(i, i + PURGE_DELETE_SLICE));
      }

      this.journalMaintenanceOp(ts, {
        opType: 'archived_memory_purge',
        affectedIds: deletedIds,
        reasoning: ARCHIVED_MEMORY_PURGE_REASONING,
        summary: { kind: 'archived_memory_purge', deleted: deletedIds.length },
      });

      return { deletedIds };
    });
  }

  unsafeGetById(id: string): Memory | undefined {
    return this.repos.memory.unsafeGetById(id);
  }

  /** @internal */
  unsafeGetByIds(ids: readonly string[]): Memory[] {
    return this.repos.memory.unsafeGetByIds(ids);
  }

  private collectPredecessors(start: Memory): {
    rows: PredecessorView[];
    truncated: boolean;
  } {
    const ids = this.repos.memory
      .unsafeAncestorIds({ startIds: start.replaces, limit: PREDECESSOR_CAP + 2 })
      .filter((id) => id !== start.id);
    const truncated = ids.length > PREDECESSOR_CAP;
    const wanted = ids.slice(0, PREDECESSOR_CAP);
    const byId = new Map(this.repos.memory.unsafeProjectionByIds(wanted).map((r) => [r.id, r]));
    const rows = wanted
      .map((id) => byId.get(id))
      .filter((r): r is PredecessorView => r !== undefined);
    return { rows, truncated };
  }

  private findHead(start: Memory): { head: Memory; truncated: boolean } {
    if (start.status === 'active') return { head: start, truncated: false };
    let current = start;
    const visited = new Set<string>([start.id]);
    for (let i = 0; i < HEAD_RESOLUTION_HOP_CAP; i++) {
      const successorId = this.repos.memory.findSuccessorId(current.id);
      if (!successorId || visited.has(successorId)) return { head: current, truncated: false };
      const next = this.unsafeGetById(successorId);
      if (!next) return { head: current, truncated: false };
      visited.add(next.id);
      current = next;
      if (current.status === 'active') return { head: current, truncated: false };
    }
    return { head: current, truncated: true };
  }
}

/** Exported so the annotation response budget can compute the EFFECTIVE row count. */
export const DEFAULT_SEARCH_LIMIT = 8;

export const PREDECESSOR_CAP = 10;

/** Bound on forward-successor hops when resolving a supersedes-chain head. */
const HEAD_RESOLUTION_HOP_CAP = 64;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  if (limit < 1) return 1;
  if (limit > 200) return 200;
  return Math.floor(limit);
}

function normalizeTopicKey(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 128) {
    throw new DomainError('invalid_input', 'memory.save: topic_key exceeds 128 characters');
  }
  assertNoNul('memory.save', 'topic_key', trimmed);
  return trimmed;
}
