import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Audit and reversal journal for the consolidation consolidation.
 *
 * Each run produces a row in consolidation_runs and one or more rows in
 * consolidation_ops. Every op is reversible; reversal sets `revertedAt`.
 */

export type ConsolidationOpType =
  | 'merge'
  | 'supersede'
  | 'archive'
  | 'decay'
  | 'noop'
  | 'failed'
  | 'orphan_promote'
  | 'session_purge'
  | 'archived_memory_purge'
  | 'prompt_purge';

export const consolidationRuns = sqliteTable(
  'consolidation_runs',
  {
    id: text('id').primaryKey(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    llmProvider: text('llm_provider'),
    llmModel: text('llm_model'),
    /** Scope tuple processed by this run, e.g. "global" or "project:abc". */
    scope: text('scope'),
    summary: text('summary'),
  },
  (table) => ({
    startedAtIdx: index('consolidation_runs_started_at_idx').on(table.startedAt),
  }),
);

export const consolidationOps = sqliteTable(
  'consolidation_ops',
  {
    id: text('id').primaryKey(),
    consolidationId: text('consolidation_id')
      .notNull()
      .references(() => consolidationRuns.id),
    opType: text('op_type', {
      enum: [
        'merge',
        'supersede',
        'archive',
        'decay',
        'noop',
        'failed',
        'orphan_promote',
        'session_purge',
        'archived_memory_purge',
        'prompt_purge',
      ],
    }).notNull(),
    /** Memory ids touched by this op (predecessors, archived ones). */
    affectedIds: text('affected_ids', { mode: 'json' }).$type<string[]>().notNull(),
    /** New memory id introduced by the op (set for merge/supersede). */
    createdId: text('created_id'),
    /** Free-form LLM reasoning attached for auditability. */
    reasoning: text('reasoning'),
    /** When the op was applied to the DB. */
    appliedAt: integer('applied_at', { mode: 'timestamp_ms' }).notNull(),
    /** Set when the op has been reverted via undo. */
    revertedAt: integer('reverted_at', { mode: 'timestamp_ms' }),
  },
  (table) => ({
    consolidationIdIdx: index('consolidation_ops_consolidation_id_idx').on(table.consolidationId),
    revertedAtIdx: index('consolidation_ops_reverted_at_idx').on(table.revertedAt),
  }),
);

export type ConsolidationRun = typeof consolidationRuns.$inferSelect;
export type NewConsolidationRun = typeof consolidationRuns.$inferInsert;
export type ConsolidationOp = typeof consolidationOps.$inferSelect;
export type NewConsolidationOp = typeof consolidationOps.$inferInsert;
