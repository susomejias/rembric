import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import {
  consolidationOps,
  consolidationRuns,
  type ConsolidationOp,
  type ConsolidationRun,
  type NewConsolidationOp,
  type NewConsolidationRun,
} from '../schema/consolidation.js';

export class ConsolidationRepository {
  constructor(private readonly db: Db) {}

  insertRun(values: NewConsolidationRun): void {
    this.db.insert(consolidationRuns).values(values).run();
  }

  insertOp(values: NewConsolidationOp): void {
    this.db.insert(consolidationOps).values(values).run();
  }

  finishRun(id: string, finishedAt: Date, summary: string): void {
    this.db
      .update(consolidationRuns)
      .set({ finishedAt, summary })
      .where(eq(consolidationRuns.id, id))
      .run();
  }

  /** A non-finished/recent run exists for this scope since `cutoffMs` (throttle). */
  recentRunExists(scope: string, cutoffMs: number): boolean {
    return (
      this.db
        .select({ id: consolidationRuns.id })
        .from(consolidationRuns)
        .where(
          and(
            eq(consolidationRuns.scope, scope),
            sql`${consolidationRuns.startedAt} > ${cutoffMs}`,
          ),
        )
        .limit(1)
        .get() !== undefined
    );
  }

  /**
   * Unscoped — `admin`-prefixed so the confinement gate covers it. The sweep
   * runs per scope but the latest-run banner (dashboard, `memory.doctor`) is
   * deliberately server-wide.
   */
  adminLatestRun(): Pick<ConsolidationRun, 'startedAt' | 'summary'> | undefined {
    return this.db
      .select({ startedAt: consolidationRuns.startedAt, summary: consolidationRuns.summary })
      .from(consolidationRuns)
      .orderBy(desc(consolidationRuns.startedAt))
      .limit(1)
      .get();
  }

  findOpById(opId: string): ConsolidationOp | undefined {
    return this.db.select().from(consolidationOps).where(eq(consolidationOps.id, opId)).get();
  }

  listActiveOps(runId: string): ConsolidationOp[] {
    return this.db
      .select()
      .from(consolidationOps)
      .where(and(eq(consolidationOps.runId, runId), isNull(consolidationOps.revertedAt)))
      .all();
  }

  markReverted(opId: string, revertedAt: Date): void {
    this.db.update(consolidationOps).set({ revertedAt }).where(eq(consolidationOps.id, opId)).run();
  }

  adminListRuns(limit: number, offset: number): ConsolidationRun[] {
    return this.db
      .select()
      .from(consolidationRuns)
      .orderBy(desc(consolidationRuns.startedAt))
      .limit(limit)
      .offset(offset)
      .all();
  }

  adminCountRuns(): number {
    const row = this.db.select({ value: count() }).from(consolidationRuns).get();
    return row?.value ?? 0;
  }

  adminGetRun(id: string): ConsolidationRun | undefined {
    return this.db.select().from(consolidationRuns).where(eq(consolidationRuns.id, id)).get();
  }

  adminListOps(runId: string): ConsolidationOp[] {
    return this.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.runId, runId))
      .orderBy(consolidationOps.appliedAt)
      .all();
  }

  adminGetOp(opId: string): ConsolidationOp | undefined {
    return this.db.select().from(consolidationOps).where(eq(consolidationOps.id, opId)).get();
  }

  /** `count(reverted_at)` skips NULLs, so it counts only reverted ops. */
  adminOpCounts(runId: string): { total: number; reverted: number } {
    const row = this.db
      .select({ total: count(), reverted: count(consolidationOps.revertedAt) })
      .from(consolidationOps)
      .where(eq(consolidationOps.runId, runId))
      .get();
    return { total: row?.total ?? 0, reverted: row?.reverted ?? 0 };
  }
}
