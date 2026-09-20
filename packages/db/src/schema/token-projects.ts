import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { projects } from './projects.js';
import { tokens } from './tokens.js';

/**
 * Which projects a set-scoped token (`projects` / `read:projects`) reaches.
 * This table is the authorization truth for those two arms — the scope string
 * names no project and authorizes nothing on its own.
 *
 * Both foreign keys are real, so a project SLUG written where an id belongs is
 * rejected by SQLite rather than by convention, exactly as `tokens.project_id`
 * is for the single-project arms.
 *
 * WITHOUT ROWID in 0032, which Drizzle cannot express;
 * test/schema-drift.test.ts asserts it against sqlite_master instead.
 */
export const tokenProjects = sqliteTable(
  'token_projects',
  {
    tokenId: text('token_id')
      .notNull()
      .references(() => tokens.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
  },
  (table) => ({
    // No secondary index: every read is `WHERE token_id = ?`, the leading
    // column of this key, and on a WITHOUT ROWID table the key IS the table.
    pk: primaryKey({ columns: [table.tokenId, table.projectId] }),
  }),
);

export type TokenProject = typeof tokenProjects.$inferSelect;
export type NewTokenProject = typeof tokenProjects.$inferInsert;
