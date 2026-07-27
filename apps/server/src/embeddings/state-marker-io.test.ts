import { readFileSync, writeFileSync } from 'node:fs';
import type * as fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { EmbeddingWorker } from '../services/embedding-worker.js';
import { MemoryService } from '../services/memory.js';
import { SCOPE_GLOBAL } from '../services/scope.js';
import { createTestDb, FakeEmbedder, type TestDb } from '../test/index.js';

import { EMBEDDING_INPUT_VERSION, EMBEDDING_MODEL_ID } from './embedder.js';
import {
  embeddingMarkerPath,
  ensureVectorModel,
  vectorIdentityMatches,
  vectorIndexResetWarning,
} from './state.js';

/**
 * Marker-write failures are injected through a partial `node:fs` mock, not
 * through `chmod`: this suite runs as root, root bypasses permission bits, so a
 * read-only marker stays writable and every such test passes vacuously.
 */
const marker = vi.hoisted(() => ({ writes: 0, failFrom: Number.POSITIVE_INFINITY }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const writeFileSync: typeof actual.writeFileSync = (path, data, options) => {
    if (String(path).endsWith('embedding-state.json')) {
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
let mem: MemoryService;

beforeEach(() => {
  marker.writes = 0;
  marker.failFrom = Number.POSITIVE_INFINITY;
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  mem = new MemoryService(repos, db.handle.db);
});

afterEach(() => db.cleanup());

function markerPath(): string {
  return embeddingMarkerPath(db.dataDir);
}

function drain(): Promise<unknown> {
  return new EmbeddingWorker({ repos, embedder: new FakeEmbedder() }).processBatch();
}

async function seedVectors(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    mem.save({ type: 'feedback', title: `row-${i}`, content: `row-${i}` }, SCOPE_GLOBAL);
  }
  await drain();
  expect(repos.vectors.count()).toBe(count);
}

function writeStaleMarker(): void {
  writeFileSync(
    markerPath(),
    JSON.stringify({ modelId: 'stale-model', inputVersion: 'stale' }) + '\n',
  );
}

function readRawMarker(): string {
  return readFileSync(markerPath(), 'utf8');
}

describe('ensureVectorModel marker I/O failures', () => {
  it('loses no vector when the pending marker cannot be written', async () => {
    await seedVectors(2);
    writeStaleMarker();
    const before = readRawMarker();

    marker.failFrom = marker.writes + 1;
    expect(() => ensureVectorModel(repos, db.dataDir)).toThrow(/EACCES/);

    expect(repos.vectors.count()).toBe(2);
    expect(readRawMarker()).toBe(before);
  });

  it('survives a wipe that commits under a marker that cannot settle, and converges', async () => {
    await seedVectors(2);
    writeStaleMarker();

    marker.failFrom = marker.writes + 2;
    expect(ensureVectorModel(repos, db.dataDir)).toEqual({ wiped: 2, markerWritten: false });
    expect(repos.vectors.count()).toBe(0);
    const unsettled = JSON.parse(readRawMarker()) as { pending?: boolean };
    expect(unsettled.pending).toBe(true);

    marker.failFrom = Number.POSITIVE_INFINITY;
    expect(ensureVectorModel(repos, db.dataDir)).toEqual({ wiped: 0, markerWritten: true });
    expect(JSON.parse(readRawMarker())).toMatchObject({
      modelId: EMBEDDING_MODEL_ID,
      inputVersion: EMBEDDING_INPUT_VERSION,
      pending: false,
    });

    await drain();
    expect(repos.vectors.count()).toBe(2);
  });

  it('performs zero wipes across repeated boots on a persistently unwritable data dir', async () => {
    await seedVectors(2);
    writeStaleMarker();

    marker.failFrom = marker.writes + 1;
    for (let boot = 0; boot < 3; boot += 1) {
      expect(() => ensureVectorModel(repos, db.dataDir)).toThrow(/EACCES/);
      expect(repos.vectors.count()).toBe(2);
    }
  });
});

describe('ensureVectorModel pending marker', () => {
  it('runs the reset when the marker carries the current identity but is pending', async () => {
    await seedVectors(1);
    writeFileSync(
      markerPath(),
      JSON.stringify({
        modelId: EMBEDDING_MODEL_ID,
        inputVersion: EMBEDDING_INPUT_VERSION,
        pending: true,
      }) + '\n',
    );

    expect(ensureVectorModel(repos, db.dataDir)).toEqual({ wiped: 1, markerWritten: true });
    expect(repos.vectors.count()).toBe(0);
  });

  it.each([
    ['"true"', '"true"'],
    ['1', '1'],
    ['{}', '{}'],
    ['null', 'null'],
  ])('treats a non-boolean pending (%s) as unsettled rather than settled', async (_label, raw) => {
    await seedVectors(1);
    writeFileSync(
      markerPath(),
      `{"modelId":${JSON.stringify(EMBEDDING_MODEL_ID)},"inputVersion":${JSON.stringify(EMBEDDING_INPUT_VERSION)},"pending":${raw}}\n`,
    );

    expect(vectorIdentityMatches(db.dataDir)).toBe(false);
    expect(ensureVectorModel(repos, db.dataDir)).toEqual({ wiped: 1, markerWritten: true });
  });

  it('re-wipes a rebuilt index when the previous boot left the marker unsettled', async () => {
    await seedVectors(2);
    writeStaleMarker();

    marker.failFrom = marker.writes + 2;
    expect(ensureVectorModel(repos, db.dataDir)).toEqual({ wiped: 2, markerWritten: false });
    marker.failFrom = Number.POSITIVE_INFINITY;

    // The costly ordering: the drain rebuilds under the current recipe BEFORE
    // the retry, so the retry discards valid work. Accepted (design D2), pinned
    // here so the cost is visible rather than inferred from the cheap ordering.
    await drain();
    expect(repos.vectors.count()).toBe(2);
    expect(ensureVectorModel(repos, db.dataDir)).toEqual({ wiped: 2, markerWritten: true });
    expect(repos.vectors.count()).toBe(0);
  });

  it('reports a settled matching marker as trustworthy', async () => {
    await seedVectors(1);
    expect(vectorIdentityMatches(db.dataDir)).toBe(false);

    expect(ensureVectorModel(repos, db.dataDir)).toEqual({ wiped: 1, markerWritten: true });
    expect(vectorIdentityMatches(db.dataDir)).toBe(true);
  });

  it('warns only when a reset is owed AND rows exist, and never counts otherwise', async () => {
    let counts = 0;
    const count = (): number => {
      counts += 1;
      return repos.vectors.count();
    };

    // Owed with rows present: the doctor must not report healthy here.
    await seedVectors(2);
    writeStaleMarker();
    expect(vectorIndexResetWarning(db.dataDir, count)).toMatch(/owes a reset: 2 row\(s\)/);
    expect(counts).toBe(1);

    // Owed but empty: nothing to distrust.
    ensureVectorModel(repos, db.dataDir);
    expect(repos.vectors.count()).toBe(0);
    writeStaleMarker();
    expect(vectorIndexResetWarning(db.dataDir, count)).toBeNull();

    // Settled and matching: silent, and the vec0 count is never paid.
    ensureVectorModel(repos, db.dataDir);
    counts = 0;
    expect(vectorIndexResetWarning(db.dataDir, count)).toBeNull();
    expect(counts).toBe(0);
  });

  it('writes nothing when upgrading over a marker with no pending field', async () => {
    await seedVectors(1);
    writeFileSync(
      markerPath(),
      JSON.stringify({
        modelId: EMBEDDING_MODEL_ID,
        inputVersion: EMBEDDING_INPUT_VERSION,
      }) + '\n',
    );

    marker.writes = 0;
    expect(ensureVectorModel(repos, db.dataDir)).toEqual({ wiped: 0, markerWritten: true });
    expect(marker.writes).toBe(0);
    expect(repos.vectors.count()).toBe(1);
  });
});
