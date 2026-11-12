import {
  createRepositories,
  memoryRelations,
  partitionKeyFor,
  type Repositories,
  type Scope,
} from '@rembric/db';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CANDIDATE_HIGH_BAND_FLOOR,
  CANDIDATE_LOW_BAND_CEILING,
  classifyCandidateBand,
  MemoryService,
  RelationsService,
  runPostSaveSteps,
  VEC_THRESHOLD,
  type CandidateOptions,
} from '@rembric/core';

import { createTestDb, defaultProjectScope, type TestDb } from '../test-support/index.js';

describe('classifyCandidateBand', () => {
  const dense = (vecSimilarity: number | null) => ({
    vecSimilarity,
    lexical: false,
    entity: false,
  });

  it('a pair only the dense channel admits is low below the low-band ceiling and middle from it', () => {
    expect(classifyCandidateBand(dense(VEC_THRESHOLD))).toBe('low');
    expect(classifyCandidateBand(dense(CANDIDATE_LOW_BAND_CEILING - 0.001))).toBe('low');
    expect(classifyCandidateBand(dense(CANDIDATE_LOW_BAND_CEILING))).toBe('middle');
    expect(classifyCandidateBand(dense(CANDIDATE_HIGH_BAND_FLOOR - 0.001))).toBe('middle');
  });

  it('is high from the high-band floor on, whichever channels admitted the pair', () => {
    expect(classifyCandidateBand(dense(CANDIDATE_HIGH_BAND_FLOOR))).toBe('high');
    expect(
      classifyCandidateBand({
        vecSimilarity: CANDIDATE_HIGH_BAND_FLOOR,
        lexical: true,
        entity: true,
      }),
    ).toBe('high');
    expect(classifyCandidateBand({ vecSimilarity: 0.99, lexical: false, entity: true })).toBe(
      'high',
    );
  });

  it('an entity-only pair is low below VEC_THRESHOLD, middle at it, and middle when the cosine is unknown', () => {
    const entity = (vecSimilarity: number | null) => ({
      vecSimilarity,
      lexical: false,
      entity: true,
    });
    expect(classifyCandidateBand(entity(VEC_THRESHOLD - 0.001))).toBe('low');
    expect(classifyCandidateBand(entity(0.2))).toBe('low');
    expect(classifyCandidateBand(entity(VEC_THRESHOLD))).toBe('middle');
    expect(classifyCandidateBand(entity(null))).toBe('middle');
  });

  it('a lexically admitted pair is never low', () => {
    expect(classifyCandidateBand({ vecSimilarity: 0.72, lexical: true, entity: false })).toBe(
      'middle',
    );
    expect(classifyCandidateBand({ vecSimilarity: 0.3, lexical: true, entity: true })).toBe(
      'middle',
    );
    expect(classifyCandidateBand({ vecSimilarity: null, lexical: true, entity: false })).toBe(
      'middle',
    );
  });

  it('a pair no channel admits has no band', () => {
    expect(classifyCandidateBand(dense(VEC_THRESHOLD - 0.001))).toBeNull();
    expect(classifyCandidateBand(dense(null))).toBeNull();
  });
});

describe('save-time bands through the curation path', () => {
  const DIMS = 768;
  let db: TestDb;
  let repos: Repositories;
  let memorySvc: MemoryService;
  let relations: RelationsService;
  let scope: Scope;
  let nextAxis: number;

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
    memorySvc = new MemoryService(repos, db.handle.db);
    relations = new RelationsService(repos, db.handle.db);
    scope = defaultProjectScope(db.handle);
    nextAxis = 2;
  });

  afterEach(() => db.cleanup());

  function vectorAt(cosine: number, axis: number): Buffer {
    const v = new Float32Array(DIMS);
    v[0] = cosine;
    v[axis] = Math.sqrt(1 - cosine * cosine);
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }

  function seed(title: string, content: string, opts: { cosine?: number; path?: string } = {}) {
    const m = memorySvc.save({ type: 'project', title, content }, scope);
    if (opts.cosine !== undefined) {
      repos.vectors.insertEmbedding(
        m.id,
        vectorAt(opts.cosine, nextAxis++),
        partitionKeyFor(scope.projectId),
      );
    }
    if (opts.path) {
      repos.entities.linkMemory(
        m.id,
        scope.projectId,
        [{ kind: 'path', value: opts.path }],
        new Date(),
      );
    }
    return m;
  }

  async function saveProbe(
    content: string,
    candidates: CandidateOptions = { perSaveMax: 5 },
    r: Repositories = repos,
  ) {
    const m = memorySvc.save({ type: 'project', title: 'Probe', content }, scope);
    repos.vectors.insertEmbedding(m.id, vectorAt(1, 1), partitionKeyFor(scope.projectId));
    return { id: m.id, ...(await runPostSaveSteps({ repos: r, relations, candidates }, m, scope)) };
  }

  function pendingRow(sourceId: string, targetId: string) {
    return db.handle.db
      .select()
      .from(memoryRelations)
      .where(
        and(
          eq(memoryRelations.sourceId, sourceId),
          eq(memoryRelations.targetId, targetId),
          eq(memoryRelations.status, 'pending'),
        ),
      )
      .get();
  }

  it('a low-band pair writes no pending row and is reported in related[] without a judgmentId', async () => {
    const target = seed('Quarterly restore drill', 'staging restores happen every quarter', {
      cosine: 0.72,
    });
    const out = await saveProbe('backup copies sit in an off-site bucket');

    expect(out.candidates).toEqual([]);
    expect(out.related.map((r) => [r.targetId, r.source])).toEqual([[target.id, 'vec']]);
    expect(out.related[0]).not.toHaveProperty('judgmentId');
    expect(out.convergeWith).toEqual([]);
    expect(out.candidatesDetected).toBe(0);
    expect(pendingRow(out.id, target.id)).toBeUndefined();
  });

  it('an entity-only pair below VEC_THRESHOLD is related, still labelled with its entity', async () => {
    const target = seed('Session module owner', 'platform team reviews src/lib/session.ts', {
      cosine: 0.4,
      path: 'src/lib/session.ts',
    });
    const out = await saveProbe(
      'lint forbids default exports inside src/lib/session.ts everywhere',
    );

    expect(out.candidates).toEqual([]);
    expect(out.related).toMatchObject([
      { targetId: target.id, source: 'entity', entityValue: 'src/lib/session.ts' },
    ]);
    expect(pendingRow(out.id, target.id)).toBeUndefined();
  });

  it('a high-band pair still writes a pending row and convergeWith names its judgment id', async () => {
    const target = seed('Scheduler port', 'scheduler binds port 8781', { cosine: 0.92 });
    const out = await saveProbe('the job runner listens on a non-default socket');

    expect(out.candidates.map((c) => c.targetId)).toEqual([target.id]);
    expect(out.candidates[0]!.judgmentId).toBe(pendingRow(out.id, target.id)?.judgmentId);
    expect(out.convergeWith).toEqual([out.candidates[0]!.judgmentId]);
    expect(out.related).toEqual([]);
  });

  it('a middle-band pair is a pending candidate exactly as before, with no steer', async () => {
    const target = seed('Webhook retries', 'outbound hooks retry eight times', { cosine: 0.8 });
    const out = await saveProbe('dead deliveries can be replayed by operators');

    expect(out.candidates.map((c) => c.targetId)).toEqual([target.id]);
    expect(pendingRow(out.id, target.id)).toBeDefined();
    expect(out.convergeWith).toEqual([]);
    expect(out.related).toEqual([]);
    expect(out.candidatesDetected).toBe(1);
  });

  it('an entity-only pair whose target has no vector stays middle', async () => {
    const target = seed('Flag file', 'config/flags.yaml lists every toggle', {
      path: 'config/flags.yaml',
    });
    const out = await saveProbe('prettier formats config/flags.yaml during the commit hook');

    expect(out.candidates).toMatchObject([{ targetId: target.id, source: 'entity' }]);
    expect(pendingRow(out.id, target.id)).toBeDefined();
    expect(out.related).toEqual([]);
  });

  it('an entity target outside the dense pool is classified by its exact cosine', async () => {
    seed('Nearest neighbour', 'scheduler binds port 8781', { cosine: 0.9 });
    const target = seed('Session owners', 'platform team reviews src/lib/session.ts', {
      cosine: 0.3,
      path: 'src/lib/session.ts',
    });
    const out = await saveProbe(
      'lint forbids default exports inside src/lib/session.ts everywhere',
      {
        perSaveMax: 5,
        poolSize: 1,
      },
    );

    expect(out.related.map((r) => r.targetId)).toEqual([target.id]);
    expect(pendingRow(out.id, target.id)).toBeUndefined();
  });

  it('a low-band pair takes no candidate slot and is not counted', async () => {
    const low = seed('Session owners', 'platform team reviews src/lib/session.ts', {
      cosine: 0.3,
      path: 'src/lib/session.ts',
    });
    const middle = seed('Cookie lifetime', 'cookies last twelve hours', { cosine: 0.8 });
    const out = await saveProbe(
      'lint forbids default exports inside src/lib/session.ts everywhere',
      {
        perSaveMax: 1,
      },
    );

    expect(out.candidates.map((c) => c.targetId)).toEqual([middle.id]);
    expect(out.related.map((r) => r.targetId)).toEqual([low.id]);
    expect(out.candidatesDetected).toBe(1);
  });

  it('related[] is bounded by the same per-save maximum', async () => {
    for (let i = 0; i < 3; i++)
      seed(`Loose neighbour ${i}`, `alpha${i} beta${i}`, { cosine: 0.71 });
    const out = await saveProbe('gamma delta epsilon', { perSaveMax: 2 });

    expect(out.related).toHaveLength(2);
    expect(out.candidates).toEqual([]);
  });

  it('with bands disabled every admitted pair is a pending candidate (the sweep baseline)', async () => {
    const target = seed('Quarterly restore drill', 'staging restores happen every quarter', {
      cosine: 0.72,
    });
    const out = await saveProbe('backup copies sit in an off-site bucket', {
      perSaveMax: 5,
      bands: false,
    });

    expect(out.candidates.map((c) => c.targetId)).toEqual([target.id]);
    expect(out.related).toEqual([]);
    expect(pendingRow(out.id, target.id)).toBeDefined();
  });

  it('looks up a cosine only for targets outside the dense pool, and not at all without vectors', async () => {
    const record = (calls: string[]): Repositories =>
      new Proxy(repos, {
        get(target, repoName: string) {
          const repo = target[repoName as keyof Repositories] as object;
          return new Proxy(repo, {
            get(r, method: string) {
              const value = (r as Record<string, unknown>)[method];
              if (typeof value !== 'function') return value;
              return (...args: unknown[]) => {
                calls.push(`${repoName}.${method}`);
                return (value as (...a: unknown[]) => unknown).apply(r, args);
              };
            },
          });
        },
      });

    seed('Flag file', 'config/flags.yaml lists every toggle', { path: 'config/flags.yaml' });
    const withoutVectors: string[] = [];
    const bare = memorySvc.save(
      { type: 'project', title: 'Probe', content: 'prettier formats config/flags.yaml on commit' },
      scope,
    );
    await runPostSaveSteps(
      { repos: record(withoutVectors), relations, candidates: { perSaveMax: 5 } },
      bare,
      scope,
    );
    expect(withoutVectors).not.toContain('vectors.cosineDistances');

    seed('Unrelated vector', 'something else entirely', { cosine: 0.1 });
    const withVectors: string[] = [];
    await saveProbe(
      'prettier formats config/flags.yaml on commit',
      { perSaveMax: 5 },
      record(withVectors),
    );
    expect(withVectors).toContain('vectors.cosineDistances');
  });
});
