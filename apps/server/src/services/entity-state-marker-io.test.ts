import { readFileSync, writeFileSync } from 'node:fs';
import type * as fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { EXTRACTOR_VERSION } from './entities.js';
import { EntityBackfillWorker } from './entity-backfill-worker.js';
import { ensureEntityExtractor, entityMarkerPath } from './entity-state.js';
import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { projectScope } from './scope.js';

/**
 * Marker-write failures are injected through a partial `node:fs` mock, not
 * through `chmod`: this suite runs as root, root bypasses permission bits, so a
 * read-only marker stays writable and every such test passes vacuously.
 */
const marker = vi.hoisted(() => ({ writes: 0, failFrom: Number.POSITIVE_INFINITY }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const writeFileSync: typeof actual.writeFileSync = (path, data, options) => {
    if (String(path).endsWith('entity-state.json')) {
      marker.writes += 1;
      if (marker.writes >= marker.failFrom) {
        throw new Error(`EACCES: permission denied, open '${String(path)}'`);
      }
    }
    actual.writeFileSync(path, data, options);
  };
  return { ...actual, writeFileSync };
});

let db: TestDb;
let repos: Repositories;
let memory: MemoryService;
let worker: EntityBackfillWorker;
let projectId: string;

beforeEach(() => {
  marker.writes = 0;
  marker.failFrom = Number.POSITIVE_INFINITY;
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  memory = new MemoryService(repos, db.handle.db);
  worker = new EntityBackfillWorker({ repos, tx: db.handle.db });
  projectId = new ProjectsService(repos).create({ slug: 'app' }).id;
});

afterEach(() => db.cleanup());

function readMarkerRaw(): { extractorVersion: string; pending?: unknown } {
  return JSON.parse(readFileSync(entityMarkerPath(db.dataDir), 'utf8')) as {
    extractorVersion: string;
    pending?: unknown;
  };
}

function seedScannedCorpus(): void {
  memory.save(
    { type: 'project', title: 'NAS note', content: 'the NAS lives at 192.168.1.50' },
    projectScope(projectId),
  );
  ensureEntityExtractor(repos, db.dataDir, db.handle.db);
  worker.processBatch({ force: true });
  expect(repos.entities.adminCountEntities({})).toBeGreaterThan(0);
  writeFileSync(
    entityMarkerPath(db.dataDir),
    JSON.stringify({ extractorVersion: 'v0-stale' }) + '\n',
  );
}

describe('ensureEntityExtractor marker I/O failures', () => {
  it('wipes nothing when the pending marker cannot be written', () => {
    seedScannedCorpus();
    const before = readFileSync(entityMarkerPath(db.dataDir), 'utf8');

    marker.failFrom = marker.writes + 1;
    expect(() => ensureEntityExtractor(repos, db.dataDir, db.handle.db)).toThrow(/EACCES/);

    expect(readFileSync(entityMarkerPath(db.dataDir), 'utf8')).toBe(before);
    expect(repos.entities.adminCountEntities({})).toBeGreaterThan(0);
    expect(repos.entities.adminBacklogCount()).toBe(0);
  });

  it('leaves a committed wipe under a pending marker, and converges on the next boot', () => {
    seedScannedCorpus();

    marker.failFrom = marker.writes + 2;
    expect(() => ensureEntityExtractor(repos, db.dataDir, db.handle.db)).toThrow(/EACCES/);

    // The wipe committed, so the corpus is genuinely unscanned — but the marker
    // must not claim the new recipe, or a drain interrupted here would never be
    // re-checked.
    expect(repos.entities.adminCountEntities({})).toBe(0);
    expect(repos.entities.adminBacklogCount()).toBe(1);
    expect(readMarkerRaw().pending).toBe(true);

    marker.failFrom = Number.POSITIVE_INFINITY;
    expect(ensureEntityExtractor(repos, db.dataDir, db.handle.db).reset).toBe(true);
    expect(readMarkerRaw()).toMatchObject({
      extractorVersion: EXTRACTOR_VERSION,
      pending: false,
    });

    worker.processBatch({ force: true });
    expect(repos.entities.adminBacklogCount()).toBe(0);
    expect(repos.entities.adminCountEntities({})).toBeGreaterThan(0);
  });
});
