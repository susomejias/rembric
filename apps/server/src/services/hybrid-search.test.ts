import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { loadEmbedder, type Embedder } from '../embeddings/embedder.js';
import { createTestDb, FakeEmbedder, type TestDb } from '../test/index.js';

import { EmbeddingWorker } from './embedding-worker.js';
import { fuseRRF, sanitizeFtsQuery } from './hybrid-search.js';
import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { projectScope, SCOPE_GLOBAL } from './scope.js';

describe('fuseRRF', () => {
  it('ranks an item present in both lists above single-list items', () => {
    // dense: [A, B, C]   fts: [D, A, E]  → A appears in both → highest.
    const fused = fuseRRF([
      ['A', 'B', 'C'],
      ['D', 'A', 'E'],
    ]);
    expect(fused[0]).toBe('A');
    expect(new Set(fused)).toEqual(new Set(['A', 'B', 'C', 'D', 'E']));
  });

  it('preserves single-branch order and handles empty lists', () => {
    expect(fuseRRF([[], []])).toEqual([]);
    expect(fuseRRF([['X', 'Y', 'Z'], []])).toEqual(['X', 'Y', 'Z']);
  });
});

describe('sanitizeFtsQuery', () => {
  it('neutralizes punctuation/accents/operators that would crash or mis-parse FTS5', () => {
    // No throw potential: every token is quoted as a phrase.
    expect(sanitizeFtsQuery('¿cómo toma el café?')).toBe('"¿cómo" OR "toma" OR "el" OR "café?"');
    expect(sanitizeFtsQuery('coffee OR tea')).toBe('"coffee" OR "OR" OR "tea"'); // "OR" is a literal phrase, not the operator
    expect(sanitizeFtsQuery('C++')).toBe('"C++"');
    expect(sanitizeFtsQuery('a "b')).toBe('"a" OR "b"'); // stray quote stripped
  });

  it('returns empty for whitespace / pure punctuation (caller skips lexical branch)', () => {
    expect(sanitizeFtsQuery('   ')).toBe('');
    expect(sanitizeFtsQuery('!!! ??? ...')).toBe('');
  });
});

describe('hybrid search plumbing (FakeEmbedder)', () => {
  let db: TestDb;
  let repos: Repositories;
  let projectId: string;
  let fake: FakeEmbedder;
  let mem: MemoryService;

  const embedAll = async () => {
    const worker = new EmbeddingWorker({ repos, embedder: fake });
    // Drain until empty (more than one batch is unlikely at these sizes).
    let guard = 0;
    while ((await worker.processBatch()).processed > 0 && guard++ < 20) {
      /* keep draining */
    }
  };

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
    projectId = new ProjectsService(repos).create({ slug: 'app' }).id;
    fake = new FakeEmbedder();
    mem = new MemoryService(repos, db.handle.db, undefined, (t) => fake.embed(t));
  });

  afterEach(() => db.cleanup());

  it('dense branch surfaces an exact semantic match (identical text → identical vector)', async () => {
    mem.save({ type: 'user', content: 'alpha beta gamma' }, projectScope(projectId));
    mem.save({ type: 'user', content: 'unrelated text here' }, projectScope(projectId));
    await embedAll();
    const results = await mem.search({ query: 'alpha beta gamma' }, projectScope(projectId));
    expect(results[0]!.content).toBe('alpha beta gamma');
  });

  it('isolates scope, status, and type on the hybrid path', async () => {
    const otherId = new ProjectsService(repos).create({ slug: 'other' }).id;
    mem.save({ type: 'user', content: 'shared token here' }, projectScope(projectId));
    mem.save({ type: 'user', content: 'shared token here' }, projectScope(otherId));
    const supersededRow = mem.save(
      { type: 'user', content: 'shared token superseded' },
      projectScope(projectId),
    );
    mem.save({ type: 'project', content: 'shared token typed' }, projectScope(projectId));
    await embedAll();
    // Flip one to superseded via the memory table → the vec status trigger mirrors it.
    db.handle.raw
      .prepare("UPDATE memory SET status = 'superseded' WHERE id = ?")
      .run(supersededRow.id);

    const res = await mem.search({ query: 'shared token', type: 'user' }, projectScope(projectId));
    const ids = res.map((m) => m.id);
    expect(res.every((m) => m.projectId === projectId)).toBe(true); // scope
    expect(res.every((m) => m.status === 'active')).toBe(true); // status
    expect(res.every((m) => m.type === 'user')).toBe(true); // type
    expect(ids).not.toContain(supersededRow.id);
  });

  it('finds a memory with no embedding via the lexical branch (coverage gap)', async () => {
    mem.save({ type: 'user', content: 'embedded one widget' }, projectScope(projectId));
    const unembedded = mem.save(
      { type: 'user', content: 'unembedded widget row' },
      projectScope(projectId),
    );
    // Deliberately do NOT embed — dense is blind to it; FTS must still find it.
    const res = await mem.search({ query: 'unembedded widget' }, projectScope(projectId));
    expect(res.map((m) => m.id)).toContain(unembedded.id);
  });

  it('a malformed lexical query never throws (fault isolation + sanitizer)', async () => {
    mem.save({ type: 'user', content: 'C++ pointers and refs' }, projectScope(projectId));
    await embedAll();
    await expect(
      mem.search({ query: 'C++ "unbalanced AND' }, projectScope(projectId)),
    ).resolves.toBeInstanceOf(Array);
  });

  it('tag filters the dense branch (no wrong-tag rows)', async () => {
    const tagged = mem.save(
      { type: 'user', content: 'taggable subject matter', tags: ['keep'] },
      projectScope(projectId),
    );
    mem.save({ type: 'user', content: 'taggable subject matter' }, projectScope(projectId));
    await embedAll();
    const res = await mem.search(
      { query: 'taggable subject matter', tag: 'keep' },
      projectScope(projectId),
    );
    expect(res.map((m) => m.id)).toEqual([tagged.id]);
  });

  it('degrades to FTS-only when no embedQuery is wired', async () => {
    const ftsOnly = new MemoryService(repos, db.handle.db); // no embedQuery
    ftsOnly.save({ type: 'user', content: 'lexical only lookup' }, projectScope(projectId));
    await embedAll();
    const res = await ftsOnly.search({ query: 'lexical only' }, projectScope(projectId));
    expect(res.map((m) => m.content)).toContain('lexical only lookup');
  });
});

describe('hybrid search cross-lingual recall (real embedder)', () => {
  let embedder: Embedder;
  let db: TestDb;
  let repos: Repositories;
  let mem: MemoryService;

  beforeAll(async () => {
    embedder = await loadEmbedder();
  }, 60_000);

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
    mem = new MemoryService(repos, db.handle.db, undefined, (t) => embedder.embed(t));
  });

  afterEach(() => db.cleanup());
  afterAll(() => {
    /* embedder has no teardown */
  });

  it('a Spanish query surfaces an English-stored memory (the motivating bug)', async () => {
    mem.save({ type: 'user', content: 'user prefers black coffee, no sugar' }, SCOPE_GLOBAL);
    mem.save({ type: 'user', content: 'deploys on Fridays after standup' }, SCOPE_GLOBAL);
    const worker = new EmbeddingWorker({ repos, embedder });
    await worker.processBatch();

    // No lexical overlap + punctuation/accents that would crash a naive FTS query.
    const res = await mem.search({ query: '¿cómo toma el café?' }, SCOPE_GLOBAL);
    expect(res.some((m) => m.content.includes('black coffee'))).toBe(true);
  }, 30_000);
});
