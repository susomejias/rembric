import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { projects } from './projects.js';
import { tokens } from './tokens.js';

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
    pk: primaryKey({ columns: [table.tokenId, table.projectId] }),
  }),
);

export type TokenProject = typeof tokenProjects.$inferSelect;
export type NewTokenProject = typeof tokenProjects.$inferInsert;
