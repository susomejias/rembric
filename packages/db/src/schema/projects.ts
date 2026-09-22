import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    /** Canonical project identifier (slug). Cross-machine stable. */
    slug: text('slug').notNull(),
    /** Optional display name; falls back to slug at read time. */
    displayName: text('display_name'),
    /** Archived projects are closed to agents entirely: `auth.ts` refuses at authentication, so reads fail too. Rows are retained. */
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => ({
    slugUnique: uniqueIndex('projects_slug_unique').on(table.slug),
    archivedIdx: index('projects_archived_idx').on(table.archivedAt),
    isDefaultUnique: uniqueIndex('projects_is_default_uidx')
      .on(table.isDefault)
      .where(sql`is_default = 1`),
  }),
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
