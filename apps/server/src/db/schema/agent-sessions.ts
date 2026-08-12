import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
 *   - mutable status FSM: active → ended | abandoned → active
 *   - mutable once per terminal transition, cleared on resume: ended_at
 *   - mutable with `final`-flag precedence: summary, title
 *     (a `final:true` write locks the value; subsequent `final:false`
 *      writes are ignored; subsequent `final:true` writes replace)
 *
 * Status transitions:
 *
 *   active            -> ended       (memory.session_end / POST /end)
 *   active            -> abandoned   (startup sweep for stale rows)
 *   ended | abandoned -> active      (memory.session_resume, the only
 *                                     edge back; `ended_at` is cleared)
 *
 * A terminal row still accepts `summary`/`title` writes under the `final`
 * precedence, and moves `status`/`ended_at` only through `resume`.
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
     * Last time this session produced a lifecycle write or an attached
     * memory write — NOT bumped by reads. Backfilled from `started_at` at
     * migration. Distinct from `started_at`: a session can run for hours,
     * and a session killed without SessionEnd stops advancing this while
     * `started_at` recedes into the past — that gap is what lets
     * findActiveForTransport and the periodic retirement pass tell a
     * zombie active row from a genuinely live one. See
     * openspec/changes/fix-audited-defects.
     */
    lastActivityAt: integer('last_activity_at', { mode: 'timestamp_ms' }),
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
  },
  (table) => ({
    tokenStatusIdx: index('sessions_token_status_idx').on(table.tokenId, table.status),
    projectStartedIdx: index('sessions_project_started_idx').on(table.projectId, table.startedAt),
    statusStartedIdx: index('sessions_status_started_idx').on(table.status, table.startedAt),
  }),
);

export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;

/**
 * Successive stored values of one session's curated `summary`. Appended
 * inside the same transaction as the `sessions.summary` UPDATE it records —
 * see `services/agent-sessions.ts`. Append-only: no row is ever UPDATEd or
 * DELETEd by application code, except by the cascade when its session is
 * purged (`sessions`, "Sessions MAY be physically purged when empty").
 *
 * `title` carries the `sessions.title` value IN EFFECT at the moment this row
 * was written (the post-update column value, not this write's own argument),
 * so a version pairs the content with the label that was live alongside it —
 * without it a reader sees old content next to the CURRENT title. Nullable:
 * a session can be curated before it ever has a title.
 */
export const sessionSummaryVersions = sqliteTable(
  'session_summary_versions',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    title: text('title'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    sessionVersionUnq: uniqueIndex('session_summary_versions_session_version_unq').on(
      table.sessionId,
      table.version,
    ),
  }),
);

export type SessionSummaryVersion = typeof sessionSummaryVersions.$inferSelect;
export type NewSessionSummaryVersion = typeof sessionSummaryVersions.$inferInsert;
