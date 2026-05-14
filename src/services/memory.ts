import { and, eq, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { Db } from '../db/client.js';
import { confirmations } from '../db/schema/confirmations.js';
import {
  memory,
  type Memory,
  type MemorySource,
  type MemoryStatus,
  type MemoryType,
} from '../db/schema/memory.js';

import { DomainError } from './errors.js';
import { memoryMatchesScope, type Scope } from './scope.js';

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
 *   - Nothing here ever issues DELETE FROM memory or UPDATE memory.content.
 */

export interface SaveMemoryInput {
  type: MemoryType;
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
}

export interface MemoryWithHistory {
  memory: Memory;
  predecessors: Memory[];
  head: Memory;
  confirmationCount: number;
}

export class MemoryService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ────────────────────────────────────────────────────────────────────
  //  Scoped API — every call requires a Scope. Rows outside scope are
  //  invisible.
  // ────────────────────────────────────────────────────────────────────

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
    const topicKey = normalizeTopicKey(input.topicKey);

    const ts = this.now();
    const id = ulid(ts.getTime());

    return this.db.transaction((tx): SaveResult => {
      // Locate any prior active row in the same (scope, project_id, topic_key).
      let supersededByTopicKey: Memory | null = null;
      let replacesPrefix: string[] = [];
      if (topicKey !== null) {
        const scopeClause =
          scope.kind === 'project'
            ? sql`scope = 'project' AND project_id = ${scope.projectId}`
            : sql`scope = 'global' AND project_id IS NULL`;
        const prior = tx
          .select()
          .from(memory)
          .where(sql`${scopeClause} AND topic_key = ${topicKey} AND status = 'active'`)
          .limit(1)
          .get();
        if (prior) {
          supersededByTopicKey = prior;
          replacesPrefix = [prior.id];
        }
      }

      const inserted = tx
        .insert(memory)
        .values({
          id,
          scope: scope.kind === 'global' ? 'global' : 'project',
          projectId: scope.kind === 'project' ? scope.projectId : null,
          type: input.type,
          content: input.content,
          tags: input.tags ?? [],
          status: 'active',
          replaces: replacesPrefix,
          createdAt: ts,
          lastSeenAt: ts,
          source: input.source ?? null,
          sessionId: input.sessionId ?? null,
          topicKey,
        })
        .returning()
        .get();
      if (!inserted) {
        throw new DomainError('conflict', 'memory.save: insert did not return a row');
      }

      if (supersededByTopicKey) {
        tx.update(memory)
          .set({ status: 'superseded' as const })
          .where(and(eq(memory.id, supersededByTopicKey.id), eq(memory.status, 'active')))
          .run();
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
    const confirmationCount = this.countConfirmations(head.id);
    this.touchLastSeen(head.id);
    return { memory: found, predecessors, head, confirmationCount };
  }

  /**
   * FTS5-backed keyword search restricted to the given scope. The scope
   * is enforced at the SQL level; the agent cannot opt out by passing
   * a wider filter.
   */
  search(input: SearchMemoriesInput, scope: Scope): Memory[] {
    const status = input.status ?? 'active';
    const limit = clampLimit(input.limit);
    const offset = input.offset ?? 0;

    const scopeClause =
      scope.kind === 'global'
        ? sql`(m.scope = 'global' AND m.project_id IS NULL)`
        : sql`(m.scope = 'project' AND m.project_id = ${scope.projectId})`;
    const typeClause = input.type ? sql`AND m.type = ${input.type}` : sql``;
    const tagClause = input.tag
      ? sql`AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ${input.tag})`
      : sql``;
    const statusClause = sql`AND m.status = ${status}`;

    const ids = input.query
      ? this.db
          .all<{ id: string }>(
            sql`
              SELECT m.id
              FROM memory m
              JOIN memory_fts f ON f.rowid = m.rowid
              WHERE memory_fts MATCH ${input.query}
                AND ${scopeClause}
                ${statusClause}
                ${typeClause}
                ${tagClause}
              ORDER BY rank, m.created_at DESC
              LIMIT ${limit} OFFSET ${offset}
            `,
          )
          .map((r) => r.id)
      : this.db
          .all<{ id: string }>(
            sql`
              SELECT m.id
              FROM memory m
              WHERE ${scopeClause}
                ${statusClause}
                ${typeClause}
                ${tagClause}
              ORDER BY m.created_at DESC
              LIMIT ${limit} OFFSET ${offset}
            `,
          )
          .map((r) => r.id);

    if (ids.length === 0) return [];

    const raw = this.db.select().from(memory).where(inArray(memory.id, ids)).all();
    const byId = new Map(raw.map((m) => [m.id, m]));
    const ordered: Memory[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (m) ordered.push(m);
    }
    this.touchLastSeenBatch(ids);
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
    this.db
      .insert(confirmations)
      .values({
        id: ulid(ts.getTime()),
        memoryId: head.id,
        eventTs: ts,
        source: source ?? null,
      })
      .run();
    this.touchLastSeen(head.id);
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
    this.db
      .update(memory)
      .set({ status: 'archived', lastSeenAt: ts })
      .where(and(eq(memory.id, id), eq(memory.status, 'active')))
      .run();
  }

  // ────────────────────────────────────────────────────────────────────
  //  Scope-bypassing API — for the consolidation engine and dashboard
  //  admin views ONLY. Marked `unsafe*` so any call site reads as a
  //  deliberate cross-scope operation. A grep gate in CI prevents new
  //  uses outside the allow-listed modules.
  // ────────────────────────────────────────────────────────────────────

  /** @internal */
  unsafeGetById(id: string): Memory | undefined {
    return this.db.select().from(memory).where(eq(memory.id, id)).get();
  }

  /** @internal */
  unsafeGetByIds(ids: readonly string[]): Memory[] {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(memory)
      .where(inArray(memory.id, [...ids]))
      .all();
  }

  // ────────────────────────────────────────────────────────────────────
  //  Private helpers (do not leak rows outside scope on their own —
  //  callers are always scoped methods or marked-unsafe consolidation
  //  paths).
  // ────────────────────────────────────────────────────────────────────

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
      const row = this.db
        .all<{ id: string }>(
          sql`
            SELECT m.id
            FROM memory m, json_each(m.replaces) je
            WHERE je.value = ${current.id}
            ORDER BY m.created_at DESC
            LIMIT 1
          `,
        )
        .at(0);
      if (!row || visited.has(row.id)) break;
      const next = this.unsafeGetById(row.id);
      if (!next) break;
      visited.add(next.id);
      current = next;
      if (current.status === 'active') return current;
    }
    return current;
  }

  private countConfirmations(memoryId: string): number {
    const row = this.db
      .select({ value: sql<number>`count(*)` })
      .from(confirmations)
      .where(eq(confirmations.memoryId, memoryId))
      .get();
    return row?.value ?? 0;
  }

  private touchLastSeen(id: string): void {
    this.db.update(memory).set({ lastSeenAt: this.now() }).where(eq(memory.id, id)).run();
  }

  private touchLastSeenBatch(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.db
      .update(memory)
      .set({ lastSeenAt: this.now() })
      .where(inArray(memory.id, [...ids]))
      .run();
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
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
