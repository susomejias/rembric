import { ulid } from 'ulid';

import type { TransactionRunner } from '../db/client.js';
import type { Repositories } from '../db/repositories/index.js';
import type { ConfirmationVerdict } from '../db/schema/confirmations.js';
import type { ConsolidationOpType } from '../db/schema/consolidation.js';
import type { Memory, MemorySource, MemoryStatus, MemoryType } from '../db/schema/memory.js';

import { DomainError } from './errors.js';
import { hybridSearch, RANK_WINDOW_CEILING } from './hybrid-search.js';
import {
  deriveReviewState,
  REFUTED_PRIORITY_MS,
  reviewTtlEntries,
  type ReviewState,
} from './review.js';
import { memoryMatchesScope, type Scope } from './scope.js';
import { assertNoNul, sliceWithoutSplittingSurrogatePair } from './strings.js';

const ARCHIVED_MEMORY_PURGE_REASONING = 'operator purge of disconnected archived memories';
const AGENT_MEMORY_ARCHIVE_REASONING = 'agent archived memory at explicit user request';

// The candidate query has no LIMIT, so keep the per-statement payload bounded.
const PURGE_DELETE_SLICE = 5_000;

/**
 * Domain service for the memory lifecycle.
 *
 * Every read and write of memory data through this service takes a `Scope`
 * argument and the service refuses to surface or mutate rows outside it.
 * The compiler enforces this — call sites that omit the scope are type
 * errors. The only escape hatches are the `unsafe*` methods used by the
 * consolidation engine (which must cross scopes).
 *
 * Invariants enforced here (also asserted by tests):
 *   - `save` never inserts with status other than 'active'.
 *   - `save` never inserts outside the requested scope.
 *   - `get`, `search`, `confirm`, `archive` never surface rows outside scope.
 *   - `confirm` only inserts into the `confirmations` event table; it never
 *     mutates a `memory` row.
 *   - `archive` is the only path that flips active→archived.
 *   - Nothing here ever issues DELETE FROM memory or UPDATE memory.{content,title}.
 */

// Bound is measured in JS string length (UTF-16 code units) at the zod/service
// layers; the DB CHECK counts Unicode code points. The JS layers are the
// stricter, binding bound for astral text — they reject before the DB sees it.
export const TITLE_MAX_CHARS = 100;

/**
 * Derive a non-empty, ≤100-char title from a memory's content. Used by
 * non-curated write paths (passive capture, dev seed) and mirrors the SQL
 * backfill in migration 0016. Deterministic, no LLM: first non-empty line,
 * leading Markdown markers stripped, truncated; falls back to the first 100
 * chars of `content` (which is validated non-empty, so the result is 1..100).
 */
export function deriveTitle(content: string): string {
  const firstLine = content.split('\n', 1)[0] ?? '';
  const stripped = firstLine.replace(/^[\s*#`]+/, '').trim();
  // Collapse all whitespace (incl. the newlines kept by the full-content
  // fallback) so a derived title is always a single scannable line. Slice
  // without splitting a surrogate pair — a raw index cut can leave a lone
  // high surrogate that decodes to U+FFFD wherever the title is read back.
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
  /**
   * Optional explicit agent-session id to stamp on the memory row. When
   * omitted, the caller's request context (via the in-process
   * SessionRouter) is consulted; absence there means the memory is saved
   * with `session_id = NULL` for backwards compatibility.
   */
  sessionId?: string | null;
  /**
   * Optional stable topic identifier. When supplied, the save acts as
   * an upsert: the previously-active row in `(scope, project_id,
   * topic_key)` is auto-superseded and the new row gains it in its
   * `replaces[]` array. Empty string is normalized to null. Max 128
   * chars; NUL bytes rejected.
   */
  topicKey?: string | null;
}

/**
 * Output of `MemoryService.save` when called via `saveWithCandidates`.
 * Pure `save()` keeps its old signature (just the row) so existing
 * callers don't have to change.
 */
export interface SaveResult {
  memory: Memory;
  /**
   * If the topic_key upsert path fired, this is the row that was just
   * superseded (its status moved active → superseded). Null otherwise.
   */
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

export interface SearchMemoriesInput {
  query?: string;
  type?: MemoryType;
  tag?: string;
  /** Exact topic_key filter — see openspec/changes/fix-audited-defects. */
  topicKey?: string;
  /**
   * Exact-address retrieval by entity value (see `add-entity-index`):
   * every memory linked to this value, chronological, no ranking, no
   * fusion. Combined with `query`, narrows to the entity's memories that
   * also match the text query — it never fuses the two into one ranked
   * set (design.md Decision 5). `type`/`tag`/`topicKey`/`status` narrow it
   * with the same meaning they carry on the ranked path, except that an
   * omitted `status` means "any but archived" rather than "active" — the
   * branch is specified as complete within scope.
   */
  entity?: string;
  status?: MemoryStatus;
  limit?: number;
  offset?: number;
  /** Widen a `project` scope to also match `global` rows; no-op for `global` scope. */
  includeGlobal?: boolean;
}

export interface MemoryWithHistory {
  memory: Memory;
  /** Bounded to PREDECESSOR_CAP nearest predecessors, breadth-first. */
  predecessors: Memory[];
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
    private readonly repos: Pick<Repositories, 'memory' | 'consolidation' | 'vectors' | 'entities'>,
    private readonly tx: TransactionRunner,
    private readonly now: () => Date = () => new Date(),
    /**
     * Optional lazy embedder for the hybrid search dense branch. When unset,
     * `search` degrades to FTS-only (keeps the many test/seed construction
     * sites compiling unchanged and tolerates pre-embedder bootstrap order).
     */
    private readonly embedQuery?: (text: string) => Promise<Float32Array>,
  ) {}

  save(input: SaveMemoryInput, scope: Scope): Memory {
    const { memory: m } = this.saveWithTopicKey(input, scope);
    return m;
  }

  /**
   * Save plus topic_key upsert. Returns both the new row and the row
   * that was superseded (if any) so the MCP layer can write the
   * accompanying `memory_relations` rows in the same transaction.
   *
   * The save itself is atomic: insert + supersede happen in a single
   * SQLite transaction; a failure rolls both back.
   */
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
          scope: scope.kind === 'global' ? 'global' : 'project',
          projectId: scope.kind === 'project' ? scope.projectId : null,
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
        scope: scope.kind === 'global' ? 'global' : 'project',
        projectId: scope.kind === 'project' ? scope.projectId : null,
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

      return { memory: inserted, supersededByTopicKey };
    });
  }

  /**
   * Get a memory by id, only if it belongs to the given scope. Returns
   * null when the row is missing OR exists but lies outside scope —
   * callers cannot tell the two apart (closes the information-leak
   * channel that v2 had).
   */
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

  /**
   * Scoped batch retrieve. Returns the in-scope memory rows in request id
   * order; missing or out-of-scope ids are simply absent, so callers diff the
   * returned ids against the request to report not-found (no leak — an
   * out-of-scope id is indistinguishable from a missing one). Unlike `get`,
   * this is a pure read: it does NOT touch `last_seen_at`, so a bulk pull does
   * not reshuffle decay/context recency ordering.
   */
  getMany(ids: readonly string[], scope: Scope): Memory[] {
    const byId = new Map(this.unsafeGetByIds(ids).map((m) => [m.id, m]));
    const out: Memory[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (m && memoryMatchesScope(m, scope)) out.push(m);
    }
    return out;
  }

  /**
   * Derive the read-time review state for a batch of memories (used by
   * `memory.search`). Confirmation timestamps are fetched in one grouped
   * query; non-active rows map to a null state. Read-only.
   */
  reviewStateForMemories(
    memories: readonly Memory[],
  ): Map<string, { reviewState: ReviewState | null; reviewAfter: Date | null }> {
    const out = new Map<string, { reviewState: ReviewState | null; reviewAfter: Date | null }>();
    if (memories.length === 0) return out;
    const now = this.now();
    const ids = memories.map((m) => m.id);
    const reviewTs = this.repos.memory.reviewTimestampsByIds(ids);
    for (const m of memories) {
      const { reviewState, reviewAfter } = deriveReviewState(
        {
          type: m.type,
          createdAt: m.createdAt,
          status: m.status,
          lastConfirmedAt: reviewTs.get(m.id)?.affirmedAt ?? null,
          lastRefutedAt: reviewTs.get(m.id)?.refutedAt ?? null,
        },
        now,
      );
      out.set(m.id, { reviewState, reviewAfter });
    }
    return out;
  }

  /**
   * Active in-scope memories past their review shelf life, oldest affirmation
   * baseline first — the `needsReview` channel of `memory.context`. Scope is
   * resolved here (service layer) and passed to the scoped repository read.
   */
  needsReviewForContext(scope: Scope, limit: number): NeedsReviewItem[] {
    if (limit <= 0) return [];
    const now = this.now();
    const rows = this.repos.memory.findNeedsReview({
      scope: scope.kind === 'project' ? 'project' : 'global',
      projectId: scope.kind === 'project' ? scope.projectId : null,
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

  /**
   * Total needs-review count in scope — the queue-depth signal
   * `memory.context` and `memory.stats` surface (separate-access-from-
   * usefulness). An agent that knows the queue is 800 deep can batch-
   * confirm with the `ids` form it already has; seeing only the 3 oldest
   * (`needsReviewForContext`'s cap) can't distinguish a healthy corpus from
   * a collapsing one.
   */
  countNeedsReview(scope: Scope): number {
    return this.repos.memory.countNeedsReview({
      scope: scope.kind === 'project' ? 'project' : 'global',
      projectId: scope.kind === 'project' ? scope.projectId : null,
      nowMs: this.now().getTime(),
      ttlByType: reviewTtlEntries(),
    });
  }

  /**
   * Scope-restricted search. With a text query this is hybrid retrieval
   * (dense vec ⊕ lexical FTS, RRF-fused — see `hybrid-search.ts`); without
   * one it is the chronological listing with exact pagination. Scope is
   * enforced at the SQL level; the agent cannot opt out by widening a filter.
   *
   * Does NOT advance `last_seen_at`: being returned in a page is not evidence
   * a row was useful. Only `memory.get` touches.
   */
  async search(input: SearchMemoriesInput, scope: Scope): Promise<Memory[]> {
    return (await this.searchWithAbstention(input, scope)).memories;
  }

  /**
   * Same as `search`, plus whether the text-query branch abstained (the
   * gates behind it — `ABSTENTION_FLOOR`/`GAP_RATIO_THRESHOLD` in
   * hybrid-search.ts — ship disabled, so `abstained` is always `false`
   * until they're calibrated and enabled). Only `memory.search`'s MCP
   * response surfaces this; other callers use the plain `search` above.
   */
  async searchWithAbstention(
    input: SearchMemoriesInput,
    scope: Scope,
  ): Promise<{
    memories: Memory[];
    abstained: boolean;
    reason?: string;
    viaEntity?: boolean;
    entityIndexDraining?: boolean;
  }> {
    // Ranked-branch default only. A `topic_key` filter addresses a convergent
    // topic's whole history, and every row in that slot but the newest is
    // `superseded` — so an absent `status` means "any but archived" there
    // rather than the usual `active` default. An explicit `status` still
    // narrows. The entity branch is specified as complete within scope, so it
    // takes `input.status` directly and never inherits this default.
    const status = input.status ?? (input.topicKey ? undefined : 'active');
    const limit = clampLimit(input.limit);
    const offset = input.offset ?? 0;
    const memScope = scope.kind === 'global' ? 'global' : 'project';
    const projectId = scope.kind === 'project' ? scope.projectId : null;

    const query = input.query?.trim();
    const entity = input.entity?.trim();

    if (entity) {
      // Exact-address retrieval: no fusion, no rank window, no threshold, no
      // boost. `query` narrows rather than fusing — a containment filter over
      // the entity's own memories, applied AFTER the fetch, so the fetch must
      // cover more than the final page or a match older than one page is
      // silently dropped. `RANK_WINDOW_CEILING` is the over-fetch ceiling used
      // elsewhere in this file; here it doubles as the page size when the
      // caller named no `limit`, since the branch is specified as complete
      // within scope and the 8-row ranked default would truncate that.
      const entityLimit = input.limit === undefined ? RANK_WINDOW_CEILING : limit;
      const rows = this.repos.entities.findMemoriesByEntity({
        scope: memScope,
        projectId,
        value: entity,
        status: input.status,
        type: input.type,
        tag: input.tag,
        topicKey: input.topicKey,
        includeGlobal: input.includeGlobal,
        limit: query ? Math.max(offset + entityLimit, RANK_WINDOW_CEILING) : offset + entityLimit,
      });
      const filtered = query
        ? rows.filter((m) => `${m.title}\n${m.content}`.toLowerCase().includes(query.toLowerCase()))
        : rows;
      const page = filtered.slice(offset, offset + entityLimit);
      // "Unknown entity" and "the index has not reached those memories yet"
      // are the same empty response, and a recipe bump makes the second one
      // last minutes over a large corpus. Only computed on a miss, so the hit
      // path pays nothing for it.
      const draining =
        rows.length === 0 &&
        this.repos.entities.countPendingScans({
          scope: memScope,
          projectId,
          includeGlobal: input.includeGlobal,
        }) > 0;
      return {
        memories: page,
        abstained: false,
        viaEntity: true,
        ...(draining ? { entityIndexDraining: true } : {}),
      };
    }

    let ids: string[];
    let abstained = false;
    let reason: string | undefined;
    if (query) {
      const result = await hybridSearch({
        repos: this.repos,
        embedQuery: this.embedQuery,
        query,
        scope: memScope,
        projectId,
        status,
        type: input.type,
        tag: input.tag,
        topicKey: input.topicKey,
        limit,
        offset,
        includeGlobal: input.includeGlobal,
      });
      ids = result.ids;
      abstained = result.abstained;
      reason = result.reason;
    } else {
      ids = this.repos.memory.searchMemoryIds({
        scope: memScope,
        projectId,
        status,
        type: input.type,
        tag: input.tag,
        topicKey: input.topicKey,
        limit,
        offset,
        includeGlobal: input.includeGlobal,
      });
    }
    if (ids.length === 0) return { memories: [], abstained, reason };

    const raw = this.repos.memory.unsafeGetByIds(ids);
    const byId = new Map(raw.map((m) => [m.id, m]));
    const ordered: Memory[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      // The dense branch's candidate ids come from memory_vec.status, which
      // is derived asynchronously — belt-and-suspenders against any future
      // staleness there: re-check the live row's status before returning it.
      if (m && (status === undefined ? m.status !== 'archived' : m.status === status))
        ordered.push(m);
    }
    return { memories: ordered, abstained, reason };
  }

  /**
   * Record a confirmation event for the head of the supersedes chain
   * reachable from `id`. No-op (throws `memory_not_found`) if the
   * memory is missing or outside scope. Returns whether head resolution
   * stopped at its hop cap without finding an active row — an explicit
   * signal rather than silently confirming a non-active row.
   */
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

  /**
   * Batch confirm: de-duplicates `ids` and records one confirmation per
   * distinct id inside ONE transaction. Atomic — a missing/out-of-scope id
   * aborts the whole batch via `confirm`'s `memory_not_found`.
   */
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
    // Journaled in the same transaction as the flip so an agent-initiated
    // retirement is attributable and reversible through the same
    // consolidation_ops journal the sweep and purge use.
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

  // Journal a single non-sweep lifecycle op (agent archive, operator purges)
  // as a synthetic one-op `maintenance` run. Run scope 'maintenance' stays
  // clear of the sweep's global/project:* throttle keys. Callers own the
  // enclosing transaction so the journal is atomic with the mutation.
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

  // Purge predicate + DELETE live in MemoryRepository (the only file
  // allow-listed for `DELETE FROM memory`); this service keeps the gating
  // and journaling. Spec: openspec/specs/memory/spec.md.
  countPurgeableDisconnectedArchived(): number {
    return this.repos.memory.countPurgeableDisconnectedArchived();
  }

  /**
   * Physically delete archived memories whose ids are referenced by NO
   * other row in the graph. Drops the embedding (`memory_vec`) and FTS
   * (`memory_fts`) shadow rows in the same transaction. Journals the
   * deletion as `consolidation_ops.op_type='archived_memory_purge'`.
   */
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

  // `unsafe*` = deliberate cross-scope read; a CI grep gate pins call
  // sites to the allow-listed modules (consolidation, dashboard).
  /** @internal */
  unsafeGetById(id: string): Memory | undefined {
    return this.repos.memory.unsafeGetById(id);
  }

  /** @internal */
  unsafeGetByIds(ids: readonly string[]): Memory[] {
    return this.repos.memory.unsafeGetByIds(ids);
  }

  /**
   * Breadth-first walk of the `replaces` DAG, bounded to PREDECESSOR_CAP
   * rows so a well-maintained topic_key chain (which can reach thousands of
   * predecessors) cannot make a single `memory.get` fetch an unbounded
   * number of rows. `truncated` is true whenever the reachable graph holds
   * more predecessors than the cap.
   */
  private collectPredecessors(start: Memory): { rows: Memory[]; truncated: boolean } {
    const visited = new Set<string>([start.id]);
    const rows: Memory[] = [];
    const queue = [...start.replaces];
    let truncated = false;
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      if (rows.length >= PREDECESSOR_CAP) {
        truncated = true;
        break;
      }
      const row = this.unsafeGetById(id);
      if (!row) continue;
      rows.push(row);
      for (const r of row.replaces) if (!visited.has(r)) queue.push(r);
    }
    return { rows, truncated };
  }

  /**
   * `truncated` is true ONLY when the 64-hop cap is exhausted without
   * reaching an active row — a genuine dead end (no successor, or a missing
   * row) is not truncation, it is the correct terminal state.
   */
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

const DEFAULT_SEARCH_LIMIT = 8;

/**
 * Max predecessors `memory.get` returns. A daily-updated topic_key chain
 * reaches this depth in ~10 days; the cap plus the id/title/status/createdAt
 * projection (applied at the MCP layer) is what keeps a single call bounded
 * in tokens — see openspec/changes/fix-audited-defects.
 */
const PREDECESSOR_CAP = 10;

/** Bound on forward-successor hops when resolving a supersedes-chain head. */
const HEAD_RESOLUTION_HOP_CAP = 64;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  if (limit < 1) return 1;
  if (limit > 200) return 200;
  return Math.floor(limit);
}

/**
 * Normalize `topic_key`:
 *   - undefined or null   → null
 *   - empty / whitespace  → null (degenerate; treat as "no topic")
 *   - > 128 chars         → throws invalid_input
 *   - NUL bytes           → throws invalid_input (SQLite TEXT does not
 *                            tolerate them)
 */
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
