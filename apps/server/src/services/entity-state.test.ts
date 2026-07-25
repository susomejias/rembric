import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { EXTRACTOR_VERSION } from './entities.js';
import { EntityBackfillWorker } from './entity-backfill-worker.js';
import { ensureEntityExtractor } from './entity-state.js';
import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { projectScope } from './scope.js';

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

const MARKER = 'entity-state.json';

function scanCount(): number {
  const row = db.handle.raw.prepare('SELECT COUNT(*) c FROM memory_entity_scan').get() as {
    c: number;
  };
  return row.c;
}

describe('ensureEntityExtractor', () => {
  it('resets on a first boot with no marker and writes the current version', () => {
    expect(ensureEntityExtractor(repos, db.dataDir).reset).toBe(true);
    const marker = JSON.parse(readFileSync(join(db.dataDir, MARKER), 'utf8')) as {
      extractorVersion: string;
    };
    expect(marker.extractorVersion).toBe(EXTRACTOR_VERSION);
  });

  it('is a no-op once the marker matches', () => {
    ensureEntityExtractor(repos, db.dataDir);
    expect(ensureEntityExtractor(repos, db.dataDir).reset).toBe(false);
  });

  it('re-scans an already-scanned corpus after a recipe change (upgrade path)', () => {
    memory.save(
      { type: 'project', title: 'NAS note', content: 'the NAS lives at 192.168.1.50' },
      projectScope(projectId),
    );
    const worker = new EntityBackfillWorker({ repos });

    // Boot 1: pre-existing install, fully scanned under the stored recipe.
    ensureEntityExtractor(repos, db.dataDir);
    worker.processBatch({ force: true });
    expect(scanCount()).toBe(1);
    expect(repos.entities.adminCountEntities({})).toBeGreaterThan(0);

    // Boot 2: recipe changed under the same data dir.
    writeFileSync(join(db.dataDir, MARKER), JSON.stringify({ extractorVersion: 'v0-stale' }));
    expect(ensureEntityExtractor(repos, db.dataDir).reset).toBe(true);
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
    const worker = new EntityBackfillWorker({ repos });
    ensureEntityExtractor(repos, db.dataDir);
    worker.processBatch({ force: true });
    expect(scanCount()).toBe(1);
    expect(repos.entities.adminCountEntities({})).toBe(0);

    writeFileSync(join(db.dataDir, MARKER), JSON.stringify({ extractorVersion: 'v0-stale' }));
    ensureEntityExtractor(repos, db.dataDir);
    expect(scanCount()).toBe(0);
  });

  it('treats an unreadable marker as unknown identity', () => {
    writeFileSync(join(db.dataDir, MARKER), 'not json at all');
    expect(ensureEntityExtractor(repos, db.dataDir).reset).toBe(true);
  });
});
