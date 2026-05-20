import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * A project is identified by an opaque slug supplied by clients via the
 * `/mcp/<slug>` URL path or the `project.use({slug})` MCP tool. The slug
 * is the cross-machine logical identity of the project — same slug on
 * different machines points to the same memory.
 *
 * The `slug` column was renamed from `path` in migration 0003. Existing
 * rows whose value was a path (or a slug under the v0.1 looser regex)
 * continue to function read/write under their original value.
 */
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    /** Canonical project identifier (slug). Cross-machine stable. */
    slug: text('slug').notNull(),
    /** Optional display name; falls back to slug at read time. */
    displayName: text('display_name'),
    /** Archived projects reject new writes but still surface their memories. */
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    slugUnique: uniqueIndex('projects_slug_unique').on(table.slug),
    archivedIdx: index('projects_archived_idx').on(table.archivedAt),
  }),
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
