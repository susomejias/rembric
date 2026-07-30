import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { projects } from './projects.js';

/**
 * Bearer tokens used to authenticate /mcp requests and (via cookie) the
 * dashboard. The plaintext secret is never persisted; only its hash is.
 *
 * Scope semantics:
 *   - `*`              → full access (admin)
 *   - `read:*`         → read-only across all scopes
 *   - `project:<id>`   → write access scoped to a single project
 *   - `read:project:<id>` → read-only scoped to a single project
 */
export const tokens = sqliteTable(
  'tokens',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** Hash of the bearer secret (argon2id or bcrypt). */
    hash: text('hash').notNull(),
    scope: text('scope').notNull(),
    projectId: text('project_id').references(() => projects.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (table) => ({
    nameUnique: uniqueIndex('tokens_name_unique').on(table.name),
  }),
);

export type Token = typeof tokens.$inferSelect;
export type NewToken = typeof tokens.$inferInsert;
