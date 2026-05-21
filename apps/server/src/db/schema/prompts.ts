import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { agentSessions } from './agent-sessions.js';
import { projects } from './projects.js';

/**
 * Records curated, reusable user prompts (goals, constraints, directives).
 *
 * Saved explicitly by the agent via `memory.save_prompt` when the user
 * states something worth remembering — NOT a passive transcript of every
 * user turn. Surfaced to future sessions via `memory.context.recentPrompts`
 * and retrievable via `memory.search_prompts` (FTS5).
 *
 * Append-only contract:
 *   - `content` is IMMUTABLE — no UPDATE-capable code path.
 *   - Lifecycle changes are expressed via `deleted_at` flips (operator
 *     soft-delete OR atomic refine) and the `replaces` link (refine).
 *   - Physical deletion happens ONLY through `PromptsService.purgeDeleted`
 *     with `adminBypass:true`; the invariants test allow-lists exactly
 *     that file for `DELETE FROM prompts`.
 *
 * Anchored to a session (when the agent has called `memory.session_start`)
 * and to a project (when the session is project-scoped). Both columns are
 * nullable so prompts saved on `/mcp` global connections also work.
 */
export const prompts = sqliteTable(
  'prompts',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').references(() => agentSessions.id),
    projectId: text('project_id').references(() => projects.id),
    content: text('content').notNull(),
    /** Short human-readable label for retrieval lists. ≤100 chars (app-layer). */
    title: text('title'),
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
  }),
);

export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;

// Imported `sql` is referenced via drizzle migration meta when applied; kept
// to keep parity with sibling schema modules.
void sql;
