import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { projects } from './projects.js';

export type MemoryScope = 'global' | 'project';

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
    sessionId: text('session_id'),
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
  }),
);

export type Memory = typeof memory.$inferSelect;
export type NewMemory = typeof memory.$inferInsert;
