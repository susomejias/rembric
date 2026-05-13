import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * A project is identified by an opaque external name supplied by clients via
 * the `X-Rembric-Project` header (or by an absolute path when resolved
 * locally). The `path` field is the canonical identifier; `displayName`
 * supports rename via the dashboard without touching memory associations.
 */
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    /** Canonical project identifier (absolute path or external name). */
    path: text('path').notNull(),
    /** Optional display name; defaults to basename(path) at read time. */
    displayName: text('display_name'),
    /** Archived projects reject new writes but still surface their memories. */
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    pathUnique: uniqueIndex('projects_path_unique').on(table.path),
    archivedIdx: index('projects_archived_idx').on(table.archivedAt),
  }),
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
