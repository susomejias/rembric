import { count, desc, eq } from 'drizzle-orm';

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

  // ── journaling writes ──────────────────────────────────────────────

  insertRun(values: NewConsolidationRun): void {
    this.db.insert(consolidationRuns).values(values).run();
  }

  insertOp(values: NewConsolidationOp): void {
    this.db.insert(consolidationOps).values(values).run();
  }

  // ── admin* — unscoped dashboard reads ──────────────────────────────

  adminListRuns(limit: number, offset: number): ConsolidationRun[] {
    return this.db
      .select()
      .from(consolidationRuns)
      .orderBy(desc(consolidationRuns.startedAt))
      .limit(limit)
      .offset(offset)
      .all();
  }

  adminGetRun(id: string): ConsolidationRun | undefined {
    return this.db.select().from(consolidationRuns).where(eq(consolidationRuns.id, id)).get();
  }

  adminListOps(runId: string): ConsolidationOp[] {
    return this.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.consolidationId, runId))
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
      .where(eq(consolidationOps.consolidationId, runId))
      .get();
    return { total: row?.total ?? 0, reverted: row?.reverted ?? 0 };
  }
}
