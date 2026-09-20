import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { memory } from './memory.js';
import { projects } from './projects.js';

/**
 * `memory_entities` and `memory_entity_links` are derived data — pure
 * functions of `memory.title`/`memory.content`, in the same class as
 * `memory_vec`/`memory_fts`. Both are truncate-and-recompute safe; neither
 * is ever hand-edited or referenced from outside the entity subsystem.
 *
 * `memory_entity_scan` is bookkeeping, not a knowledge table: it records
 * which memories have already been scanned for entities, which a plain
 * LEFT JOIN over `memory_entity_links` cannot do on its own — a memory
 * legitimately extracting zero entities must still count as "done" so the
 * resumable backfill never rescans it forever.
 */

export const ENTITY_KINDS = [
  'path',
  'git_ref',
  'url',
  'error_code',
  'ticket',
  'cve_id',
  'ip_address',
  'hostname',
  'env_var',
  'uuid',
  'systemd_unit',
  'mac_address',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const memoryEntities = sqliteTable(
  'memory_entities',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: ['global', 'project'] }).notNull(),
    projectId: text('project_id').references(() => projects.id),
    kind: text('kind', { enum: [...ENTITY_KINDS] }).notNull(),
    value: text('value').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    // The same literal value in two different (scope, project) pairs is two
    // distinct entities — a path in one project must never join it to
    // another's memories.
    identityIdx: uniqueIndex('memory_entities_identity_idx').on(
      table.scope,
      table.projectId,
      table.kind,
      table.value,
    ),
  }),
);

// Both tables below are WITHOUT ROWID in 0023, which Drizzle cannot express;
// test/schema-drift.test.ts asserts it against sqlite_master instead.
export const memoryEntityLinks = sqliteTable(
  'memory_entity_links',
  {
    entityId: text('entity_id')
      .notNull()
      .references(() => memoryEntities.id),
    memoryId: text('memory_id')
      .notNull()
      .references(() => memory.id),
  },
  (table) => ({
    // Composite PK leads with entity_id: the load-bearing access pattern is
    // "every memory linked to this entity" (exact-address retrieval), so
    // that's the leftmost, index-native lookup. `memory_entity_links_memory_idx`
    // below serves the opposite direction (a memory's own entities[]).
    pk: primaryKey({ columns: [table.entityId, table.memoryId] }),
    memoryIdx: index('memory_entity_links_memory_idx').on(table.memoryId),
  }),
);

export const memoryEntityScan = sqliteTable('memory_entity_scan', {
  memoryId: text('memory_id')
    .primaryKey()
    .references(() => memory.id),
  scannedAt: integer('scanned_at', { mode: 'timestamp_ms' }).notNull(),
});

export type MemoryEntity = typeof memoryEntities.$inferSelect;
export type NewMemoryEntity = typeof memoryEntities.$inferInsert;
export type MemoryEntityLink = typeof memoryEntityLinks.$inferSelect;
export type NewMemoryEntityLink = typeof memoryEntityLinks.$inferInsert;
