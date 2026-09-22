import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { agentSessions } from './agent-sessions.js';
import { projects } from './projects.js';

// `content` is IMMUTABLE — no UPDATE-capable code path (append-only contract).
export const prompts = sqliteTable(
  'prompts',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').references(() => agentSessions.id),
    projectId: text('project_id').references(() => projects.id),
    content: text('content').notNull(),
    /** Short human-readable label for retrieval lists. 1..100 chars (app-layer). */
    title: text('title').notNull(),
    /** JSON array of categorical labels; feeds prompts_fts. */
    tags: text('tags', { mode: 'json' }).$type<string[] | null>(),
    /** Array of predecessor prompt ids this row refines. JSON array of ids. */
    replaces: text('replaces', { mode: 'json' }).$type<string[] | null>(),
    /** Optional agent identifier copied from the active session. */
    agent: text('agent'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    /** Operator soft-delete marker. NULL=visible, non-NULL=hidden. */
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (table) => ({
    projectCreatedIdx: index('prompts_project_created_idx').on(table.projectId, table.createdAt),
    sessionIdx: index('prompts_session_idx').on(table.sessionId),
    createdActiveIdx: index('prompts_created_active_idx')
      .on(table.createdAt)
      .where(sql`deleted_at IS NULL`),
    deletedIdx: index('prompts_deleted_idx')
      .on(table.deletedAt)
      .where(sql`deleted_at IS NOT NULL`),
  }),
);

export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;
