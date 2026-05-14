import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { projects } from './projects.js';
import { tokens } from './tokens.js';

/**
 * Agent (MCP) sessions.
 *
 * NOT to be confused with `dashboard_sessions` (cookie auth for the
 * web dashboard). This table records each agent's working span: a
 * single agent under a single token opens a session, optionally bound
 * to a project, accumulates memory writes, and ends with a structured
 * summary that the next session can read back.
 *
 * Append-only contract:
 *
 *   - immutable: id, token_id, project_id, agent, started_at
 *   - mutable:   status (FSM), ended_at, summary
 *
 * Status transitions:
 *
 *   active    -> ended       (memory.session_end / memory.session_summary)
 *   active    -> abandoned   (startup sweep for stale rows)
 *   ended     -> (terminal)
 *   abandoned -> (terminal)
 *
 * `memory.session_id` and `confirmations.session_id` reference this
 * table. Both columns are nullable for backwards-compat with pre-v0.5
 * rows and clients that never call `memory.session_start`.
 */

export const AGENT_SESSION_STATUSES = ['active', 'ended', 'abandoned'] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

export const agentSessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    tokenId: text('token_id')
      .notNull()
      .references(() => tokens.id),
    projectId: text('project_id').references(() => projects.id),
    /** Agent identifier (e.g. "claude-code", "codex-cli", "unknown"). */
    agent: text('agent').notNull(),
    /** Optional seed goal supplied at start time. */
    description: text('description'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    /** Structured summary populated by memory.session_summary. */
    summary: text('summary'),
    status: text('status', { enum: AGENT_SESSION_STATUSES }).notNull().default('active'),
    /**
     * Soft-delete timestamp. NULL means visible. Set by operators via
     * `rembric session delete` (CLI) or `/dashboard/sessions/:id/delete`
     * (dashboard). The row is never physically deleted; `session_id`
     * references from `memory` and `confirmations` remain valid.
     */
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (table) => ({
    tokenStatusIdx: index('sessions_token_status_idx').on(table.tokenId, table.status),
    projectStartedIdx: index('sessions_project_started_idx').on(table.projectId, table.startedAt),
    statusStartedIdx: index('sessions_status_started_idx').on(table.status, table.startedAt),
  }),
);

export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;
