import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { projects } from './projects.js';

/**
 * Memory rows are append-only.
 *
 * Invariants enforced at the application layer (and asserted by CI tests):
 *   - No row is ever DELETEd.
 *   - The `content` column is never UPDATEd.
 *   - Status transitions are constrained to active → superseded | archived,
 *     plus undo flips back to active.
 *
 * Lifecycle nuance lives in the consolidation_ops journal, not here.
 */

export type MemoryScope = 'global' | 'project';
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
export type MemoryStatus = 'active' | 'superseded' | 'archived';

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
    type: text('type', { enum: ['user', 'feedback', 'project', 'reference'] }).notNull(),
    content: text('content').notNull(),
    tags: text('tags', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    status: text('status', { enum: ['active', 'superseded', 'archived'] })
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
  },
  (table) => ({
    scopeProjectStatusIdx: index('memory_scope_project_status_idx').on(
      table.scope,
      table.projectId,
      table.status,
    ),
    statusLastSeenIdx: index('memory_status_last_seen_idx').on(table.status, table.lastSeenAt),
    createdAtIdx: index('memory_created_at_idx').on(table.createdAt),
    sessionIdx: index('memory_session_idx').on(table.sessionId),
  }),
);

export type Memory = typeof memory.$inferSelect;
export type NewMemory = typeof memory.$inferInsert;
