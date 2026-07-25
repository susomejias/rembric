import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { memory, type MemorySource } from './memory.js';

export type ConfirmationVerdict = 'affirm' | 'refute';

/**
 * Append-only event table backing the "confidence" counter and its negative
 * mirror.
 *
 * Confidence on a given memory is computed as
 *   SELECT COUNT(*) FROM confirmations WHERE memory_id = ? AND verdict = 'affirm'
 *
 * This makes the counter conflict-free across replicas and trivially
 * undoable (just don't count a given event). `verdict` carries the sign:
 * affirmation and refutation are the same kind of fact — "an agent looked at
 * this and rendered a verdict" — with opposite direction, so they share one
 * channel rather than doubling the read path with a second table. Every
 * query that reads this table for the affirmation baseline (review TTL,
 * decay's confidence floor, `countConfirmations`) MUST filter to
 * `verdict = 'affirm'` — a refutation is evidence AGAINST trust, so letting
 * it inflate an affirmation count would be exactly backwards.
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
    verdict: text('verdict', { enum: ['affirm', 'refute'] })
      .notNull()
      .default('affirm'),
    /** Agent-supplied justification — required by the service layer for a refutation. */
    reason: text('reason'),
  },
  (table) => ({
    memoryIdIdx: index('confirmations_memory_id_idx').on(table.memoryId),
    eventTsIdx: index('confirmations_event_ts_idx').on(table.eventTs),
    sessionIdx: index('confirmations_session_idx').on(table.sessionId),
    // Covering index for the review-axis subqueries. Column order is
    // load-bearing: equality, equality, then the MAX/range column last.
    memoryVerdictTsIdx: index('confirmations_memory_verdict_ts_idx').on(
      table.memoryId,
      table.verdict,
      table.eventTs,
    ),
  }),
);

export type Confirmation = typeof confirmations.$inferSelect;
export type NewConfirmation = typeof confirmations.$inferInsert;
