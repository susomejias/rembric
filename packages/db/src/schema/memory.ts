import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { projects } from './projects.js';

/**
 * Memory rows are append-only.
 *
 * Invariants enforced at the application layer (and asserted by CI tests):
 *   - No row is ever DELETEd.
 *   - The `content` and `title` columns are never UPDATEd.
 *   - Status transitions are constrained to active → superseded | archived,
 *     plus undo flips back to active.
 *
 * Lifecycle nuance lives in the consolidation_ops journal, not here.
 */

export type MemoryScope = 'global' | 'project';

/**
 * The single declaration of the type domain, in the shape `ENTITY_KINDS` uses.
 * Adding a type is one edit here plus a migration: the Drizzle enum, the union,
 * the two MCP zod enums and the dashboard filter all derive from this array, so
 * the compiler carries the change instead of a grep.
 */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'procedural'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Single declaration of the status domain, in the shape `MEMORY_TYPES` uses. */
export const MEMORY_STATUSES = ['active', 'superseded', 'archived'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export interface MemorySource {
  /** Token name that produced this memory (never the secret). */
  tokenName?: string;
  /** Agent identifier reported by the client (e.g. "claude-code"). */
  agent?: string;
  /** Session identifier reported by the client, if any. */
  sessionId?: string;
  /** LLM model the agent was using, if reported. */
  model?: string;
}

export const memory = sqliteTable(
  'memory',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: ['global', 'project'] }).notNull(),
    projectId: text('project_id').references(() => projects.id),
    type: text('type', { enum: [...MEMORY_TYPES] }).notNull(),
    /**
     * Short human-readable label (1..100 chars). Required at save; the DB
     * enforces `NOT NULL` + `CHECK(length(title) BETWEEN 1 AND 100)` (the
     * CHECK is declared in the migration — Drizzle can't express it). Set
     * once at INSERT; never UPDATEd, like `content`.
     */
    title: text('title').notNull(),
    content: text('content').notNull(),
    tags: text('tags', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    status: text('status', { enum: [...MEMORY_STATUSES] })
      .notNull()
      .default('active'),
    /** Array of predecessor memory ids this row replaces. */
    replaces: text('replaces', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    /** Last time this memory was retrieved or confirmed. Drives decay. */
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    source: text('source', { mode: 'json' }).$type<MemorySource>(),
    /**
     * Agent session that produced this memory. Nullable for backwards
     * compat: rows saved before sessions existed, or by clients that
     * never call `memory.session_start`, carry NULL here.
     */
    sessionId: text('session_id'),
    /**
     * Stable identifier for an evolving topic. When `memory.save` is
     * called with a `topic_key`, the previously-active row in the same
     * (scope, project_id, topic_key) is auto-superseded and the new row
     * becomes the head. Nullable; max 128 chars (validated at the
     * service layer). The partial index below makes the lookup O(1).
     */
    topicKey: text('topic_key'),
  },
  (table) => ({
    scopeProjectStatusCreatedIdx: index('memory_scope_project_status_created_idx').on(
      table.scope,
      table.projectId,
      table.status,
      table.createdAt,
    ),
    statusCreatedIdx: index('memory_status_created_idx').on(table.status, table.createdAt),
    typeInScopeIdx: index('memory_type_in_scope_idx').on(table.scope, table.projectId, table.type),
    createdAtIdx: index('memory_created_at_idx').on(table.createdAt),
    sessionIdx: index('memory_session_idx').on(table.sessionId),
    topicKeyActiveIdx: index('memory_topic_key_active_idx')
      .on(table.scope, table.projectId, table.topicKey)
      .where(sql`status = 'active' AND topic_key IS NOT NULL`),
    // Two more indexes on this table live in migration SQL only, because
    // drizzle-kit emits invalid DDL for an `sql` index expression:
    // `memory_topic_key_active_uidx` (0018, and only an expression index can
    // enforce that uniqueness across a NULL project_id) and
    // `memory_scope_seen_idx` (0019). test/schema-drift.test.ts allow-lists both.
  }),
);

export type Memory = typeof memory.$inferSelect;
export type NewMemory = typeof memory.$inferInsert;
