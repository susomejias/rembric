import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { consolidationRuns } from './consolidation.js';
import { memory } from './memory.js';
import { projects } from './projects.js';

export const PIN_ACTIONS = ['pin', 'unpin'] as const;
export type PinAction = (typeof PIN_ACTIONS)[number];

export const PIN_CAUSES = [
  'agent',
  'operator',
  'topic_key revision',
  'supersedes verdict',
  'merge',
  'archive',
  'decay',
  'merge undo',
] as const;
export type PinCause = (typeof PIN_CAUSES)[number];

export const memoryPinEvents = sqliteTable(
  'memory_pin_events',
  {
    id: integer('id').primaryKey(),
    memoryId: text('memory_id')
      .notNull()
      .references(() => memory.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    action: text('action', { enum: PIN_ACTIONS }).notNull(),
    cause: text('cause', { enum: PIN_CAUSES }).notNull(),
    runId: text('run_id').references(() => consolidationRuns.id),
    actor: text('actor'),
    eventTs: integer('event_ts', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    memoryIdx: index('memory_pin_events_memory_idx').on(table.memoryId),
    projectIdx: index('memory_pin_events_project_idx').on(table.projectId, table.memoryId),
    actionCheck: check('memory_pin_events_action_check', sql`${table.action} IN ('pin', 'unpin')`),
  }),
);

export type MemoryPinEvent = typeof memoryPinEvents.$inferSelect;
export type NewMemoryPinEvent = typeof memoryPinEvents.$inferInsert;
