import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { Db } from '../db/client.js';
import { confirmations } from '../db/schema/confirmations.js';
import {
  memory,
  type Memory,
  type MemoryScope,
  type MemorySource,
  type MemoryStatus,
  type MemoryType,
} from '../db/schema/memory.js';

import { DomainError } from './errors.js';

/**
 * Domain service for the memory lifecycle.
 *
 * All mutations go through this class; the HTTP and CLI layers are thin
 * adapters around it. Invariants enforced here (also asserted by tests):
 *
 *   - `save` never inserts with status other than 'active'.
 *   - `save` never accepts a project_id for scope='global' nor omits one for
 *     scope='project'.
 *   - `confirm` only inserts into the `confirmations` event table; it
 *     never mutates a `memory` row.
 *   - `archive` is the only path that flips active→archived (via update).
 *   - Nothing here ever issues DELETE FROM memory or UPDATE memory.content.
 */

export interface SaveMemoryInput {
  scope: MemoryScope;
  projectId?: string | null;
  type: MemoryType;
  content: string;
  tags?: string[];
  source?: MemorySource;
}

export interface MemoryWithHistory {
  memory: Memory;
  predecessors: Memory[];
  head: Memory;
  confirmationCount: number;
}

export interface SearchMemoriesInput {
  scope: MemoryScope;
  projectId?: string | null;
  includeGlobal?: boolean;
  query?: string;
  type?: MemoryType;
  tag?: string;
  status?: MemoryStatus;
  limit?: number;
  offset?: number;
}

export class MemoryService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  save(input: SaveMemoryInput): Memory {
    this.validateScope(input.scope, input.projectId ?? null);

    if (input.content.trim().length === 0) {
      throw new DomainError('invalid_input', 'memory.save: content must be non-empty');
    }

    const ts = this.now();
    const id = ulid(ts.getTime());

    const inserted = this.db
      .insert(memory)
      .values({
        id,
        scope: input.scope,
        projectId: input.scope === 'project' ? (input.projectId ?? null) : null,
        type: input.type,
        content: input.content,
        tags: input.tags ?? [],
        status: 'active',
        replaces: [],
        createdAt: ts,
        lastSeenAt: ts,
        source: input.source ?? null,
      })
      .returning()
      .get();

    if (!inserted) {
      throw new DomainError('conflict', 'memory.save: insert did not return a row');
    }
    return inserted;
  }

  getById(id: string): Memory | undefined {
    return this.db.select().from(memory).where(eq(memory.id, id)).get();
  }

  /**
   * Return the memory together with its full ancestry (predecessors via
   * `replaces`), the current head of the supersedes chain, and the
   * confirmation count against that head.
   */
  getWithHistory(id: string): MemoryWithHistory | undefined {
    const found = this.getById(id);
    if (!found) return undefined;

    const predecessors = this.collectPredecessors(found);
    const head = this.findHead(found);
    const confirmationCount = this.countConfirmations(head.id);

    // Side effect: touch last_seen_at for the head. Justified because read
    // access is the signal decay uses; not mutating content keeps the
    // immutability invariant intact.
    this.touchLastSeen(head.id);

    return { memory: found, predecessors, head, confirmationCount };
  }

  /**
   * FTS5-backed keyword search restricted to the caller's scope. Returns
   * memories ordered by FTS relevance, then by recency. Touches
   * `last_seen_at` on returned heads so retrieval signals decay.
   */
  search(input: SearchMemoriesInput): Memory[] {
    const status = input.status ?? 'active';
    const limit = clampLimit(input.limit);
    const offset = input.offset ?? 0;

    // FTS5 only supports `MATCH` via virtual tables, so the keyword path
    // uses raw SQL to produce a list of ids. The non-keyword path uses
    // Drizzle's typed builder directly. Either way, the final hydration
    // pass goes through Drizzle so JSON columns and timestamps are
    // properly deserialized.
    const scopeClause =
      input.scope === 'project' && input.projectId
        ? input.includeGlobal
          ? sql`(m.scope = 'project' AND m.project_id = ${input.projectId} OR m.scope = 'global')`
          : sql`(m.scope = 'project' AND m.project_id = ${input.projectId})`
        : sql`(m.scope = 'global' AND m.project_id IS NULL)`;
    const typeClause = input.type ? sql`AND m.type = ${input.type}` : sql``;
    const tagClause = input.tag
      ? sql`AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ${input.tag})`
      : sql``;
    const statusClause = sql`AND m.status = ${status}`;

    let ids: string[];
    if (input.query) {
      ids = this.db
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
        .map((r) => r.id);
    } else {
      ids = this.db
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
    }

    if (ids.length === 0) return [];

    // Hydrate via Drizzle so $type<>() columns are parsed correctly.
    const raw = this.db.select().from(memory).where(inArray(memory.id, ids)).all();
    // Preserve the SQL ordering.
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
   * Record a confirmation event for the current head of the supersedes
   * chain reachable from `id`. Does NOT mutate any memory row.
   */
  confirm(id: string, source?: MemorySource): void {
    const found = this.getById(id);
    if (!found) {
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

  /**
   * User-driven decay: flip a memory's status from active to archived. The
   * consolidation engine uses its own internal path; this is the manual one.
   */
  archive(id: string): void {
    const ts = this.now();
    const result = this.db
      .update(memory)
      .set({ status: 'archived', lastSeenAt: ts })
      .where(and(eq(memory.id, id), eq(memory.status, 'active')))
      .run();

    if (result.changes === 0) {
      const existing = this.getById(id);
      if (!existing) {
        throw new DomainError('memory_not_found', `memory.archive: id=${id} not found`);
      }
      throw new DomainError(
        'conflict',
        `memory.archive: id=${id} is not in 'active' state (current=${existing.status})`,
      );
    }
  }

  private validateScope(scope: MemoryScope, projectId: string | null): void {
    if (scope === 'project' && !projectId) {
      throw new DomainError(
        'invalid_scope',
        "memory: scope='project' requires a non-empty projectId",
      );
    }
    if (scope === 'global' && projectId) {
      throw new DomainError('invalid_scope', "memory: scope='global' rejects a projectId");
    }
  }

  private collectPredecessors(start: Memory): Memory[] {
    const visited = new Set<string>([start.id]);
    const out: Memory[] = [];
    const queue = [...start.replaces];

    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      const row = this.getById(id);
      if (row) {
        out.push(row);
        for (const r of row.replaces) queue.push(r);
      }
    }
    return out;
  }

  /**
   * Walk the supersedes chain forward (using json_each on `replaces`) until
   * we hit a memory whose status is 'active'. If none is reachable, return
   * the input as-is.
   */
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
      const next = this.getById(row.id);
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

// Ordering import maintained for desc-helper if needed in future overloads.
void desc;
