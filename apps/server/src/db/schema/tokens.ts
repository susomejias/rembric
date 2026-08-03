import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
 *
 * For the two project arms `project_id` is the enforced binding: the FK
 * proves it names a real project and the CHECK proves the scope string
 * names the same one.
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
    // Deliberately one-directional: rows predating the enforced binding
    // carry a slug in the scope string and NULL here, and must stay
    // storable — asserting the converse would reject them.
    projectScopeCheck: check(
      'tokens_project_scope_check',
      sql`project_id IS NULL OR scope = 'project:' || project_id OR scope = 'read:project:' || project_id`,
    ),
  }),
);

export type Token = typeof tokens.$inferSelect;
export type NewToken = typeof tokens.$inferInsert;
