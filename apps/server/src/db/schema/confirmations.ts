import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { memory, type MemorySource } from './memory.js';

/**
 * Append-only event table backing the "confidence" counter.
 *
 * Confidence on a given memory is computed as
 *   SELECT COUNT(*) FROM confirmations WHERE memory_id = ?
 *
 * This makes the counter conflict-free across replicas and trivially
 * undoable (just don't count a given event).
 */
export const confirmations = sqliteTable(
  'confirmations',
  {
    id: text('id').primaryKey(),
    /** Always points to the head of the supersedes chain at confirm time. */
    memoryId: text('memory_id')
      .notNull()
      .references(() => memory.id),
    eventTs: integer('event_ts', { mode: 'timestamp_ms' }).notNull(),
    source: text('source', { mode: 'json' }).$type<MemorySource>(),
    /** Agent session this confirmation was emitted from (nullable). */
    sessionId: text('session_id'),
  },
  (table) => ({
    memoryIdIdx: index('confirmations_memory_id_idx').on(table.memoryId),
    eventTsIdx: index('confirmations_event_ts_idx').on(table.eventTs),
    sessionIdx: index('confirmations_session_idx').on(table.sessionId),
  }),
);

export type Confirmation = typeof confirmations.$inferSelect;
export type NewConfirmation = typeof confirmations.$inferInsert;
