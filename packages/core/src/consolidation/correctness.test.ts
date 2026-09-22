import { createRepositories, memory } from '@rembric/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { MemoryService } from '@rembric/core';

import { createTestDb, defaultProjectScope } from '../test-support/index.js';

describe('13.18 concurrency — 100 concurrent memory.save calls leave DB consistent', () => {
  it('persists exactly 100 rows with the correct scope', async () => {
    const test = createTestDb();
    try {
      const svc = new MemoryService(createRepositories(test.handle.db), test.handle.db);
      const N = 100;
      const operations = [] as Promise<unknown>[];
      for (let i = 0; i < N; i++) {
        operations.push(
          Promise.resolve(
            svc.save(
              { type: 'feedback', title: `c-${i}`, content: `c-${i}` },
              defaultProjectScope(test.handle),
            ),
          ),
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
        .where(sql`status = 'active' AND scope = 'project'`)
        .get();
      expect(active?.v).toBe(N);
    } finally {
      test.cleanup();
    }
  });
});
