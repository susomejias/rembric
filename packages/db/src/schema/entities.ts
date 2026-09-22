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
    identityIdx: uniqueIndex('memory_entities_identity_idx').on(
      table.scope,
      table.projectId,
      table.kind,
      table.value,
    ),
  }),
);

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
