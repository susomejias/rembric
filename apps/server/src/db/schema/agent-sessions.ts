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
 *   - mutable status FSM: active → ended | abandoned (terminal)
 *   - mutable once: ended_at
 *   - mutable with `final`-flag precedence: summary, title
 *     (a `final:true` write locks the value; subsequent `final:false`
 *      writes are ignored; subsequent `final:true` writes replace)
 *
 * Status transitions:
 *
 *   active    -> ended       (memory.session_end / POST /end)
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
    /**
     * Human-readable label shown in the dashboard list. Initial value is
     * a placeholder `basename(cwd) · HH:MM UTC` written at row insert.
     * Overwritten by model `memory.session_summary({title})` (final:true)
     * or bash hook fallback at SessionEnd (final:false). Cascade in the
     * dashboard: `row.title ?? row.description ?? shortId(row.id)`.
     */
    title: text('title'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    /**
     * Structured summary populated by memory.session_summary (final:true)
     * or by hook fallbacks (final:false). Mutable subject to the
     * `summary_final` precedence flag. Bounded to `SUMMARY_MAX_CHARS`
     * by the server only (service rejects oversize, MCP zod + HTTP enforce
     * the same constant); there is NO SQLite CHECK pinning the length — the
     * `0011` CHECK was dropped in `0012_drop_summary_length_check.sql` so the
     * cap is a tunable constant with no further table rebuilds. The full
     * summary is read back via `memory.session_get`; `memory.context`
     * returns only a snippet.
     */
    summary: text('summary'),
    /** Lock flag for `summary`. Once true, only final writes overwrite. */
    summaryFinal: integer('summary_final', { mode: 'boolean' }).notNull().default(false),
    /** Lock flag for `title`. Same semantics as `summary_final`. */
    titleFinal: integer('title_final', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: AGENT_SESSION_STATUSES }).notNull().default('active'),
    /**
     * Soft-delete timestamp. NULL means visible. Set by operators via
     * `POST /dashboard/sessions/:id/delete` (the dashboard list view's
     * inline form). The row is never physically deleted; `session_id`
     * references from `memory` and `confirmations` remain valid.
     */
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    /**
     * Opaque id of the MCP bridge process (`rembric-bridge.mjs`) this
     * session's client is paired with, set once per bridge startup and
     * carried on lifecycle POSTs via the correlation file the bridge
     * writes. Disambiguates MCP tool-call session auto-attachment when
     * multiple sessions are concurrently active under one token — see
     * `resolveSessionId`/`resolveActiveSessionId`. NULL for sessions from
     * clients that predate this mechanism or never paired with a bridge.
     */
    bridgeInstanceId: text('bridge_instance_id'),
  },
  (table) => ({
    tokenStatusIdx: index('sessions_token_status_idx').on(table.tokenId, table.status),
    projectStartedIdx: index('sessions_project_started_idx').on(table.projectId, table.startedAt),
    statusStartedIdx: index('sessions_status_started_idx').on(table.status, table.startedAt),
    tokenBridgeInstanceIdx: index('sessions_token_bridge_instance_idx').on(
      table.tokenId,
      table.bridgeInstanceId,
    ),
  }),
);

export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;
