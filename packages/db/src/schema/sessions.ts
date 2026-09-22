import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { tokens } from './tokens.js';

export const dashboardSessions = sqliteTable(
  'dashboard_sessions',
  {
    id: text('id').primaryKey(),
    tokenId: text('token_id')
      .notNull()
      .references(() => tokens.id),
    /** Per-session CSRF secret used to mint per-form CSRF tokens. */
    csrfSecret: text('csrf_secret').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    expiresAtIdx: index('dashboard_sessions_expires_at_idx').on(table.expiresAt),
  }),
);

export type DashboardSession = typeof dashboardSessions.$inferSelect;
export type NewDashboardSession = typeof dashboardSessions.$inferInsert;
