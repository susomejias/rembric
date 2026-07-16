import { ulid } from 'ulid';

import type { TransactionRunner } from '../db/client.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Memory, MemorySource, MemoryStatus, MemoryType } from '../db/schema/memory.js';

import { DomainError } from './errors.js';
import { hybridSearch } from './hybrid-search.js';
import { deriveReviewState, REVIEW_TTL_MS, type ReviewState } from './review.js';
import { memoryMatchesScope, type Scope } from './scope.js';

const ARCHIVED_MEMORY_PURGE_REASONING = 'operator purge of disconnected archived memories';

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
  // fallback) so a derived title is always a single scannable line.
  return (stripped || content.trim()).replace(/\s+/g, ' ').slice(0, TITLE_MAX_CHARS);
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

export interface SearchMemoriesInput {
  query?: string;
  type?: MemoryType;
  tag?: string;
  status?: MemoryStatus;
  limit?: number;
  offset?: number;
  /** Widen a `project` scope to also match `global` rows; no-op for `global` scope. */
  includeGlobal?: boolean;
}

export interface MemoryWithHistory {
  memory: Memory;
  predecessors: Memory[];
  head: Memory;
  confirmationCount: number;
  /** Derived review state of the active head; null when the head is not active. */
  reviewState: ReviewState | null;
  /** Derived re-verification deadline of the head; null when no TTL applies. */
  reviewAfter: Date | null;
}

/** A single `needsReview` context entry: the stale memory plus its derived timing. */
export interface NeedsReviewItem {
  memory: Memory;
  reviewAfter: Date;
  reviewBaseline: Date;
}

export class MemoryService {
  constructor(
    private readonly repos: Pick<Repositories, 'memory' | 'consolidation' | 'vectors'>,
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
    const { title } = input;
    if (title.trim().length === 0 || title.length > TITLE_MAX_CHARS) {
      throw new DomainError(
        'invalid_input',
        `memory.save: title must be 1..${TITLE_MAX_CHARS} non-blank chars`,
      );
    }
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

      // Supersede the prior row BEFORE inserting the new active row: the
      // UNIQUE partial index on the active-topic slot (migration 0018) would
      // otherwise reject the insert while both rows are momentarily active.
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

    const predecessors = this.collectPredecessors(found);
    const head = this.findHead(found);
    const confirmationCount = this.repos.memory.countConfirmations(head.id);
    const lastConfirmedAt =
      this.repos.memory.latestConfirmationTsByIds([head.id]).get(head.id) ?? null;
    const { reviewState, reviewAfter } = deriveReviewState(
      { type: head.type, createdAt: head.createdAt, status: head.status, lastConfirmedAt },
      this.now(),
    );
    this.repos.memory.touchLastSeen(head.id, this.now());
    return { memory: found, predecessors, head, confirmationCount, reviewState, reviewAfter };
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
    const lastConfirmed = this.repos.memory.latestConfirmationTsByIds(memories.map((m) => m.id));
    for (const m of memories) {
      const { reviewState, reviewAfter } = deriveReviewState(
        {
          type: m.type,
          createdAt: m.createdAt,
          status: m.status,
          lastConfirmedAt: lastConfirmed.get(m.id) ?? null,
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
      ttlByType: Object.entries(REVIEW_TTL_MS).filter(
        (e): e is [MemoryType, number] => typeof e[1] === 'number',
      ),
    });
    if (rows.length === 0) return [];
    const lastConfirmed = this.repos.memory.latestConfirmationTsByIds(rows.map((m) => m.id));
    const items: NeedsReviewItem[] = [];
    for (const m of rows) {
      const { reviewAfter, reviewBaseline } = deriveReviewState(
        {
          type: m.type,
          createdAt: m.createdAt,
          status: m.status,
          lastConfirmedAt: lastConfirmed.get(m.id) ?? null,
        },
        now,
      );
      if (reviewAfter && reviewBaseline) items.push({ memory: m, reviewAfter, reviewBaseline });
    }
    return items;
  }

  /**
   * Scope-restricted search. With a text query this is hybrid retrieval
   * (dense vec ⊕ lexical FTS, RRF-fused — see `hybrid-search.ts`); without
   * one it is the chronological listing with exact pagination. Scope is
   * enforced at the SQL level; the agent cannot opt out by widening a filter.
   */
  async search(
    input: SearchMemoriesInput,
    scope: Scope,
    opts: { touch?: boolean } = {},
  ): Promise<Memory[]> {
    const status = input.status ?? 'active';
    const limit = clampLimit(input.limit);
    const offset = input.offset ?? 0;
    const memScope = scope.kind === 'global' ? 'global' : 'project';
    const projectId = scope.kind === 'project' ? scope.projectId : null;

    const query = input.query?.trim();
    const ids = query
      ? await hybridSearch({
          repos: this.repos,
          embedQuery: this.embedQuery,
          query,
          scope: memScope,
          projectId,
          status,
          type: input.type,
          tag: input.tag,
          limit,
          offset,
          includeGlobal: input.includeGlobal,
        })
      : this.repos.memory.searchMemoryIds({
          scope: memScope,
          projectId,
          status,
          type: input.type,
          tag: input.tag,
          limit,
          offset,
          includeGlobal: input.includeGlobal,
        });
    if (ids.length === 0) return [];

    const raw = this.repos.memory.unsafeGetByIds(ids);
    const byId = new Map(raw.map((m) => [m.id, m]));
    const ordered: Memory[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (m) ordered.push(m);
    }
    // Passive callers pass touch:false so per-turn recall doesn't inflate the recency signal.
    if (opts.touch !== false) this.repos.memory.touchLastSeenBatch(ids, this.now());
    return ordered;
  }

  /**
   * Record a confirmation event for the head of the supersedes chain
   * reachable from `id`. No-op (throws `memory_not_found`) if the
   * memory is missing or outside scope.
   */
  confirm(id: string, scope: Scope, source?: MemorySource): void {
    const found = this.unsafeGetById(id);
    if (!found || !memoryMatchesScope(found, scope)) {
      throw new DomainError('memory_not_found', `memory.confirm: id=${id} not found`);
    }
    const head = this.findHead(found);
    const ts = this.now();
    this.repos.memory.insertConfirmation({
      id: ulid(ts.getTime()),
      memoryId: head.id,
      eventTs: ts,
      source: source ?? null,
    });
    this.repos.memory.touchLastSeen(head.id, ts);
  }

  /**
   * Batch confirm: de-duplicates `ids` and records one confirmation per
   * distinct id inside ONE transaction. Atomic — a missing/out-of-scope id
   * aborts the whole batch via `confirm`'s `memory_not_found`.
   */
  confirmMany(ids: readonly string[], scope: Scope, source?: MemorySource): { confirmed: number } {
    const unique = [...new Set(ids)];
    return this.tx.transaction(() => {
      for (const id of unique) this.confirm(id, scope, source);
      return { confirmed: unique.length };
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
    this.repos.memory.markArchived(id, this.now());
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

      this.repos.memory.purgeByIds(deletedIds);

      const runId = ulid(ts.getTime());
      this.repos.consolidation.insertRun({
        id: runId,
        startedAt: ts,
        finishedAt: ts,
        scope: 'maintenance',
        summary: JSON.stringify({ kind: 'archived_memory_purge', deleted: deletedIds.length }),
      });
      this.repos.consolidation.insertOp({
        id: ulid(ts.getTime()),
        runId,
        opType: 'archived_memory_purge',
        affectedIds: deletedIds,
        createdId: null,
        reasoning: ARCHIVED_MEMORY_PURGE_REASONING,
        appliedAt: ts,
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

  private collectPredecessors(start: Memory): Memory[] {
    const visited = new Set<string>([start.id]);
    const out: Memory[] = [];
    const queue = [...start.replaces];
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      const row = this.unsafeGetById(id);
      if (row) {
        out.push(row);
        for (const r of row.replaces) queue.push(r);
      }
    }
    return out;
  }

  private findHead(start: Memory): Memory {
    if (start.status === 'active') return start;
    let current = start;
    const visited = new Set<string>([start.id]);
    for (let i = 0; i < 64; i++) {
      const successorId = this.repos.memory.findSuccessorId(current.id);
      if (!successorId || visited.has(successorId)) break;
      const next = this.unsafeGetById(successorId);
      if (!next) break;
      visited.add(next.id);
      current = next;
      if (current.status === 'active') return current;
    }
    return current;
  }
}

const DEFAULT_SEARCH_LIMIT = 8;

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
  if (trimmed.includes('\0')) {
    throw new DomainError('invalid_input', 'memory.save: topic_key contains NUL byte');
  }
  return trimmed;
}
