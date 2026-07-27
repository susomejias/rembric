import { readFileSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TransactionRunner } from '../db/client.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { EXTRACTOR_VERSION } from './entities.js';
import { EntityBackfillWorker } from './entity-backfill-worker.js';
import {
  ensureEntityExtractor,
  entityIndexResetWarning,
  entityMarkerPath,
  resetEntityIndex,
} from './entity-state.js';
import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { projectScope, SCOPE_GLOBAL } from './scope.js';

let db: TestDb;
let repos: Repositories;
let memory: MemoryService;
let projectId: string;

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  memory = new MemoryService(repos, db.handle.db);
  projectId = new ProjectsService(repos).create({ slug: 'app' }).id;
});

afterEach(() => db.cleanup());

function scanCount(): number {
  const row = db.handle.raw.prepare('SELECT COUNT(*) c FROM memory_entity_scan').get() as {
    c: number;
  };
  return row.c;
}

describe('ensureEntityExtractor', () => {
  it('resets on a first boot with no marker and writes the current version', () => {
    expect(ensureEntityExtractor(repos, db.dataDir, db.handle.db).reset).toBe(true);
    const marker = JSON.parse(readFileSync(entityMarkerPath(db.dataDir), 'utf8')) as {
      extractorVersion: string;
    };
    expect(marker.extractorVersion).toBe(EXTRACTOR_VERSION);
  });

  it('is a no-op once the marker matches', () => {
    ensureEntityExtractor(repos, db.dataDir, db.handle.db);
    expect(ensureEntityExtractor(repos, db.dataDir, db.handle.db).reset).toBe(false);
  });

  it('re-scans an already-scanned corpus after a recipe change (upgrade path)', () => {
    memory.save(
      { type: 'project', title: 'NAS note', content: 'the NAS lives at 192.168.1.50' },
      projectScope(projectId),
    );
    const worker = new EntityBackfillWorker({ repos, tx: db.handle.db });

    // Boot 1: pre-existing install, fully scanned under the stored recipe.
    ensureEntityExtractor(repos, db.dataDir, db.handle.db);
    worker.processBatch({ force: true });
    expect(scanCount()).toBe(1);
    expect(repos.entities.adminCountEntities({})).toBeGreaterThan(0);

    // Boot 2: recipe changed under the same data dir.
    writeFileSync(entityMarkerPath(db.dataDir), JSON.stringify({ extractorVersion: 'v0-stale' }));
    expect(ensureEntityExtractor(repos, db.dataDir, db.handle.db).reset).toBe(true);
    expect(scanCount()).toBe(0);
    expect(repos.entities.adminCountEntities({})).toBe(0);

    // The regular drain rebuilds it without operator action.
    worker.processBatch({ force: true });
    expect(scanCount()).toBe(1);
    expect(
      repos.entities.findMemoriesByEntity({
        scope: 'project',
        projectId,
        kind: 'ip_address',
        value: '192.168.1.50',
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  it('clears scan bookkeeping even when the old recipe extracted zero entities', () => {
    memory.save(
      { type: 'project', title: 'Plain prose', content: 'no identifiers here at all' },
      projectScope(projectId),
    );
    const worker = new EntityBackfillWorker({ repos, tx: db.handle.db });
    ensureEntityExtractor(repos, db.dataDir, db.handle.db);
    worker.processBatch({ force: true });
    expect(scanCount()).toBe(1);
    expect(repos.entities.adminCountEntities({})).toBe(0);

    writeFileSync(entityMarkerPath(db.dataDir), JSON.stringify({ extractorVersion: 'v0-stale' }));
    ensureEntityExtractor(repos, db.dataDir, db.handle.db);
    expect(scanCount()).toBe(0);
  });

  it('treats an unreadable marker as unknown identity', () => {
    writeFileSync(entityMarkerPath(db.dataDir), 'not json at all');
    expect(ensureEntityExtractor(repos, db.dataDir, db.handle.db).reset).toBe(true);
  });

  it('does not reset over a matching marker that predates the pending protocol', () => {
    const legacy = JSON.stringify({ extractorVersion: EXTRACTOR_VERSION }) + '\n';
    writeFileSync(entityMarkerPath(db.dataDir), legacy);

    expect(ensureEntityExtractor(repos, db.dataDir, db.handle.db).reset).toBe(false);
    expect(readFileSync(entityMarkerPath(db.dataDir), 'utf8')).toBe(legacy);
  });

  it.each([
    ['true', 'true'],
    ['"false"', '"false"'],
    ['0', '0'],
    ['null', 'null'],
  ])('treats a %s pending flag as unsettled rather than settled', (_label, raw) => {
    writeFileSync(
      entityMarkerPath(db.dataDir),
      `{"extractorVersion":${JSON.stringify(EXTRACTOR_VERSION)},"pending":${raw}}\n`,
    );
    expect(ensureEntityExtractor(repos, db.dataDir, db.handle.db).reset).toBe(true);
  });

  it('leaves the marker unsettled when the wipe rolls back, so the retry resets', () => {
    memory.save(
      { type: 'project', title: 'NAS note', content: 'the NAS lives at 192.168.1.50' },
      projectScope(projectId),
    );
    const worker = new EntityBackfillWorker({ repos, tx: db.handle.db });
    ensureEntityExtractor(repos, db.dataDir, db.handle.db);
    worker.processBatch({ force: true });
    expect(scanCount()).toBe(1);
    expect(repos.entities.adminBacklogCount()).toBe(0);

    writeFileSync(entityMarkerPath(db.dataDir), JSON.stringify({ extractorVersion: 'v0-stale' }));
    const rollingBack: TransactionRunner = {
      transaction: (cb) =>
        db.handle.db.transaction((tx) => {
          cb(tx);
          throw new Error('disk I/O error');
        }),
    };
    expect(() => ensureEntityExtractor(repos, db.dataDir, rollingBack)).toThrow(/disk I\/O error/);

    const unsettled = JSON.parse(readFileSync(entityMarkerPath(db.dataDir), 'utf8')) as {
      extractorVersion: string;
      pending?: boolean;
    };
    expect(unsettled.pending).toBe(true);
    // The rollback restored the scan rows, so the backlog alone reads drained:
    // the unsettled marker is the only thing left that knows a reset is owed.
    expect(scanCount()).toBe(1);
    expect(repos.entities.adminBacklogCount()).toBe(0);

    expect(ensureEntityExtractor(repos, db.dataDir, db.handle.db).reset).toBe(true);
    expect(repos.entities.adminBacklogCount()).toBe(1);
    expect(worker.processBatch({ force: true }).processed).toBe(1);
  });
});

describe('resetEntityIndex', () => {
  it('opens one transaction, so a partial wipe cannot survive', () => {
    memory.save(
      { type: 'project', title: 'NAS note', content: 'the NAS lives at 192.168.1.50' },
      projectScope(projectId),
    );
    new EntityBackfillWorker({ repos, tx: db.handle.db }).processBatch({ force: true });
    expect(scanCount()).toBe(1);

    let opened = 0;
    const counting: TransactionRunner = {
      transaction: (cb) => {
        opened++;
        return db.handle.db.transaction(cb);
      },
    };

    resetEntityIndex(repos, counting);

    expect(opened).toBe(1);
    expect(scanCount()).toBe(0);
    expect(repos.entities.adminCountEntities({})).toBe(0);
    expect(repos.entities.adminBacklogCount()).toBe(1);
  });

  it('leaves the worker believing there is work again', () => {
    memory.save({ type: 'project', title: 'A', content: 'apps/a.ts' }, projectScope(projectId));
    const worker = new EntityBackfillWorker({ repos, tx: db.handle.db });
    worker.processBatch({ force: true });
    // A second pass is what clears the flag: it goes false only when
    // `findMissingScans` comes back empty.
    worker.processBatch({ force: true });
    expect(worker.hasPendingWork).toBe(false);

    worker.resetIndex();

    expect(worker.hasPendingWork).toBe(true);
    // No `force`: the flag alone has to be enough, or a rebuild silently
    // leaves the index empty until the hourly forced fallback.
    expect(worker.processBatch().processed).toBe(1);
  });
});

describe('entityIndexResetWarning', () => {
  it('warns while a reset is owed and links exist, and stays silent otherwise', () => {
    let counted = 0;
    const count = (): number => {
      counted += 1;
      return repos.entities.adminCountEntities({});
    };

    memory.save({ type: 'project', title: 'note', content: 'host nas.local is up' }, SCOPE_GLOBAL);
    ensureEntityExtractor(repos, db.dataDir, db.handle.db);
    new EntityBackfillWorker({ repos, tx: db.handle.db }).processBatch({ force: true });
    expect(repos.entities.adminCountEntities({})).toBeGreaterThan(0);

    // Settled and matching: silent, and the count is never paid.
    expect(entityIndexResetWarning(db.dataDir, count)).toBeNull();
    expect(counted).toBe(0);

    // Owed with links present: this is the state whose backlog reads zero.
    writeFileSync(entityMarkerPath(db.dataDir), JSON.stringify({ extractorVersion: 'v0-stale' }));
    expect(entityIndexResetWarning(db.dataDir, count)).toMatch(/owes a reset: \d+ link\(s\)/);

    // Owed but empty: nothing to distrust.
    resetEntityIndex(repos, db.handle.db);
    expect(entityIndexResetWarning(db.dataDir, count)).toBeNull();
  });
});
