import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { agentSessions } from './agent-sessions.js';
import { projects } from './projects.js';

/**
 * Agent prompts.
 *
 * Records what the user asked so future sessions have context about
 * goals and intent. Append-only: prompts are never updated; deletion
 * happens only via explicit operator action (out of scope for v0.5).
 *
 * Anchored to a session (when the agent has called `memory.session_start`)
 * and to a project (when the session is project-scoped). Both columns
 * are nullable so prompts saved on `/mcp` global connections also work.
 */
export const prompts = sqliteTable(
  'prompts',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').references(() => agentSessions.id),
    projectId: text('project_id').references(() => projects.id),
    content: text('content').notNull(),
    /** Optional agent identifier copied from the active session. */
    agent: text('agent'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    projectCreatedIdx: index('prompts_project_created_idx').on(table.projectId, table.createdAt),
    sessionIdx: index('prompts_session_idx').on(table.sessionId),
  }),
);

export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;
