import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { projects } from './projects.js';

export const projectRepositories = sqliteTable(
  'project_repositories',
  {
    fingerprint: text('fingerprint').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    remotes: text('remotes', { mode: 'json' }).$type<string[]>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    createdBy: text('created_by').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.fingerprint, table.projectId] }),
    projectIdx: index('project_repositories_project_idx').on(table.projectId),
  }),
);

export const REPOSITORY_PENDING_KINDS = ['unbound', 'suggestion', 'unknown_remote'] as const;
export type RepositoryPendingKind = (typeof REPOSITORY_PENDING_KINDS)[number];

export const repositoryPending = sqliteTable(
  'repository_pending',
  {
    id: text('id').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    kind: text('kind', { enum: REPOSITORY_PENDING_KINDS }).notNull(),
    projectId: text('project_id').references(() => projects.id),
    remotes: text('remotes', { mode: 'json' }).$type<string[]>().notNull(),
    rootName: text('root_name'),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
    discardedAt: integer('discarded_at', { mode: 'timestamp_ms' }),
  },
  (table) => ({
    kindCheck: check(
      'repository_pending_kind_check',
      sql`kind IN ('unbound', 'suggestion', 'unknown_remote')`,
    ),
    identityUnique: uniqueIndex('repository_pending_identity_uidx').on(
      table.fingerprint,
      table.kind,
      sql`coalesce(${table.projectId}, '')`,
    ),
  }),
);

export const repositoryPendingTokens = sqliteTable(
  'repository_pending_tokens',
  {
    pendingId: text('pending_id')
      .notNull()
      .references(() => repositoryPending.id, { onDelete: 'cascade' }),
    tokenId: text('token_id').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pendingId, table.tokenId] }),
    tokenIdx: index('repository_pending_tokens_token_idx').on(table.tokenId),
  }),
);

export type ProjectRepository = typeof projectRepositories.$inferSelect;
export type NewProjectRepository = typeof projectRepositories.$inferInsert;
export type RepositoryPending = typeof repositoryPending.$inferSelect;
export type NewRepositoryPending = typeof repositoryPending.$inferInsert;
