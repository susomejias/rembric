import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { memory, type MemorySource } from './memory.js';

export type ConfirmationVerdict = 'affirm' | 'refute';

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
    verdict: text('verdict', { enum: ['affirm', 'refute'] })
      .notNull()
      .default('affirm'),
    /** Agent-supplied justification — required by the service layer for a refutation. */
    reason: text('reason'),
  },
  (table) => ({
    memoryIdIdx: index('confirmations_memory_id_idx').on(table.memoryId),
    sessionIdx: index('confirmations_session_idx').on(table.sessionId),
    memoryVerdictTsIdx: index('confirmations_memory_verdict_ts_idx').on(
      table.memoryId,
      table.verdict,
      table.eventTs,
    ),
    verdictCheck: check(
      'confirmations_verdict_check',
      sql`${table.verdict} IN ('affirm', 'refute')`,
    ),
  }),
);

export type Confirmation = typeof confirmations.$inferSelect;
export type NewConfirmation = typeof confirmations.$inferInsert;
