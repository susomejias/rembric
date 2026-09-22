import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { projects } from './projects.js';
import { tokens } from './tokens.js';

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
    title: text('title'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    lastActivityAt: integer('last_activity_at', { mode: 'timestamp_ms' }),
    summary: text('summary'),
    /** Lock flag for `summary`. Once true, only final writes overwrite. */
    summaryFinal: integer('summary_final', { mode: 'boolean' }).notNull().default(false),
    /** Lock flag for `title`. Same semantics as `summary_final`. */
    titleFinal: integer('title_final', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: AGENT_SESSION_STATUSES }).notNull().default('active'),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    lastWorkAt: integer('last_work_at', { mode: 'timestamp_ms' }),
    /** Set only by the same site that writes a `final:true` summary. */
    lastSummaryAt: integer('last_summary_at', { mode: 'timestamp_ms' }),
    /** Set only when a turn report's response carries notice lines. */
    lastNudgeAt: integer('last_nudge_at', { mode: 'timestamp_ms' }),
    lastTurnReportAt: integer('last_turn_report_at', { mode: 'timestamp_ms' }),
  },
  (table) => ({
    tokenStatusIdx: index('sessions_token_status_idx').on(table.tokenId, table.status),
    projectStartedIdx: index('sessions_project_started_idx').on(table.projectId, table.startedAt),
    statusStartedIdx: index('sessions_status_started_idx').on(table.status, table.startedAt),
  }),
);

export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;
