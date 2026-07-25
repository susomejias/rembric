import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type EntitiesRepository } from '../db/repositories/index.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { EntityBackfillWorker } from './entity-backfill-worker.js';
import { MemoryService } from './memory.js';
import { SCOPE_GLOBAL } from './scope.js';

let db: TestDb;
let mem: MemoryService;
let entities: EntitiesRepository;
let worker: EntityBackfillWorker;

beforeEach(() => {
  db = createTestDb();
  const repos = createRepositories(db.handle.db);
  mem = new MemoryService(repos, db.handle.db);
  entities = repos.entities;
  worker = new EntityBackfillWorker({ repos, tx: db.handle.db, batchSize: 50 });
});

afterEach(() => db.cleanup());

describe('EntityBackfillWorker', () => {
  it('backfills every active memory exactly once, including ones with zero entities', () => {
    const withEntity = mem.save(
      { type: 'project', title: 'Fix', content: 'fixed apps/server/src/db/migrate.ts' },
      SCOPE_GLOBAL,
    );
    const withoutEntity = mem.save(
      { type: 'project', title: 'No entities here', content: 'just plain prose' },
      SCOPE_GLOBAL,
    );

    const result = worker.processBatch();
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);

    expect(entities.findEntitiesForMemory(withEntity.id)).toHaveLength(1);
    expect(entities.findEntitiesForMemory(withoutEntity.id)).toEqual([]);
    expect(entities.adminBacklogCount()).toBe(0);
  });

  it('resumes correctly after a restart (a fresh worker instance sees the same backlog)', () => {
    mem.save({ type: 'project', title: 'A', content: 'apps/a.ts' }, SCOPE_GLOBAL);
    mem.save({ type: 'project', title: 'B', content: 'apps/b.ts' }, SCOPE_GLOBAL);
    const repos = createRepositories(db.handle.db);
    new EntityBackfillWorker({ repos, tx: db.handle.db, batchSize: 1 }).processBatch();
    expect(repos.entities.adminBacklogCount()).toBe(1);

    // A brand-new worker instance (simulating a process restart) picks up
    // exactly where the backlog left off — no separate cursor to lose.
    const resumed = new EntityBackfillWorker({
      repos,
      tx: db.handle.db,
      batchSize: 50,
    }).processBatch();
    expect(resumed.processed).toBe(1);
    expect(repos.entities.adminBacklogCount()).toBe(0);
  });

  it('is idempotent — a second call with nothing pending processes zero', () => {
    mem.save({ type: 'project', title: 'A', content: 'apps/a.ts' }, SCOPE_GLOBAL);
    worker.processBatch();
    const second = worker.processBatch();
    expect(second).toEqual({ processed: 0, failed: 0 });
  });

  it('backfills archived memories too, so status-archived entity lookups can resolve', () => {
    const m = mem.save({ type: 'project', title: 'A', content: 'apps/a.ts' }, SCOPE_GLOBAL);
    mem.archive(m.id, SCOPE_GLOBAL);
    const result = worker.processBatch();
    expect(result.processed).toBe(1);
    expect(entities.findEntitiesForMemory(m.id)).toEqual([{ kind: 'path', value: 'apps/a.ts' }]);
    expect(
      entities
        .findMemoriesByEntity({
          scope: 'global',
          projectId: null,
          value: 'apps/a.ts',
          status: 'archived',
          limit: 10,
        })
        .map((r) => r.id),
    ).toEqual([m.id]);
  });

  it('skips work when nothing is pending and force is not set', () => {
    const result = worker.processBatch();
    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it('force re-scans even when the pending flag has already drained', () => {
    mem.save({ type: 'project', title: 'A', content: 'apps/a.ts' }, SCOPE_GLOBAL);
    worker.processBatch();
    expect(worker.processBatch()).toEqual({ processed: 0, failed: 0 });
    // Forcing re-checks the backlog query even though the flag says drained.
    expect(worker.processBatch({ force: true })).toEqual({ processed: 0, failed: 0 });
  });
});
