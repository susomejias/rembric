import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { memory } from './memory.js';

export const RELATION_VALUES = [
  'supersedes',
  'conflicts_with',
  'related',
  'compatible',
  'scoped',
  'not_conflict',
] as const;
export type RelationKind = (typeof RELATION_VALUES)[number];

export const RELATION_STATUSES = ['pending', 'judged', 'orphaned'] as const;
export type RelationStatus = (typeof RELATION_STATUSES)[number];

export const MARKED_BY_KINDS = ['agent', 'agent_topic_key', 'consolidator', 'system'] as const;
export type MarkedByKind = (typeof MARKED_BY_KINDS)[number];

export const memoryRelations = sqliteTable(
  'memory_relations',
  {
    id: text('id').primaryKey(),
    /** Opaque token returned by `memory.save`; the agent passes it back to `memory.judge`. */
    judgmentId: text('judgment_id').notNull(),
    sourceId: text('source_id')
      .notNull()
      .references(() => memory.id),
    targetId: text('target_id')
      .notNull()
      .references(() => memory.id),
    relation: text('relation', { enum: RELATION_VALUES }),
    status: text('status', { enum: RELATION_STATUSES }).notNull(),
    reason: text('reason'),
    evidence: text('evidence', { mode: 'json' }).$type<unknown>(),
    confidence: real('confidence'),
    markedByKind: text('marked_by_kind', { enum: MARKED_BY_KINDS }),
    markedByActor: text('marked_by_actor'),
    judgedAt: integer('judged_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    judgmentIdUnique: uniqueIndex('memory_relations_judgment_id_unique').on(table.judgmentId),
    sourceStatusIdx: index('memory_relations_source_status_idx').on(table.sourceId, table.status),
    targetStatusIdx: index('memory_relations_target_status_idx').on(table.targetId, table.status),
    statusCreatedIdx: index('memory_relations_status_created_idx').on(
      table.status,
      table.createdAt,
    ),
    createdAtIdx: index('memory_relations_created_at_idx').on(table.createdAt),
  }),
);

export type MemoryRelation = typeof memoryRelations.$inferSelect;
export type NewMemoryRelation = typeof memoryRelations.$inferInsert;
