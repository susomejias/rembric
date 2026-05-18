import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { memory } from '../db/schema/memory.js';
import { MemoryService } from '../services/memory.js';
import { SCOPE_GLOBAL } from '../services/scope.js';
import { createTestDb } from '../test/index.js';

/**
 * 13.18 — concurrency invariant for the new save path (topic-key
 * upsert + atomic insert). Verifies the new transaction-wrapped save
 * still keeps the row count consistent under fan-out load.
 *
 * The legacy v0.1 consolidator correctness/idempotency/reversibility
 * tests were removed by this change: those code paths
 * (findRedundancyCandidates / findDriftCandidates /
 * findContradictionCandidates + applyMerge / applySupersede driven
 * from the nightly cron) are no longer the canonical model. Save-time
 * candidate detection + memory.judge replaces them, and the
 * orphan-promotion path has its own dedicated test in
 * `consolidation/orphan-promotion.test.ts`.
 */

describe('13.18 concurrency — 100 concurrent memory.save calls leave DB consistent', () => {
  it('persists exactly 100 rows with the correct scope', async () => {
    const test = createTestDb();
    try {
      const svc = new MemoryService(test.handle.db);
      const N = 100;
      const operations = [] as Promise<unknown>[];
      for (let i = 0; i < N; i++) {
        operations.push(
          Promise.resolve(svc.save({ type: 'feedback', content: `c-${i}` }, SCOPE_GLOBAL)),
        );
      }
      await Promise.all(operations);

      const total = test.handle.db
        .select({ v: sql<number>`count(*)` })
        .from(memory)
        .get();
      expect(total?.v).toBe(N);

      const active = test.handle.db
        .select({ v: sql<number>`count(*)` })
        .from(memory)
        .where(sql`status = 'active' AND scope = 'global'`)
        .get();
      expect(active?.v).toBe(N);
    } finally {
      test.cleanup();
    }
  });
});
