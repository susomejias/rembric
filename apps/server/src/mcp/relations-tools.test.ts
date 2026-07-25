import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { memory, type NewMemory } from '../db/schema/memory.js';
import type { Project } from '../db/schema/projects.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { deriveTitle, MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { RelationsService } from '../services/relations.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { buildRelationsHandlers } from './relations-tools.js';
import { suggestTopicKey } from './topic-key.js';

let db: TestDb;
let repos: Repositories;
let relations: RelationsService;
let memorySvc: MemoryService;
let handlers: ReturnType<typeof buildRelationsHandlers>;

function fakeContext(project: Project | null = null): RequestContext {
  const token: Token = {
    id: 'tk_test',
    name: 'tester',
    hash: 'hash',
    scope: '*',
    projectId: null,
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
  };
  return {
    token,
    scope: '*',
    project,
    requestedSlug: project?.slug ?? null,
    mcpSessionId: null,
  };
}

function parse<T>(resp: unknown): T {
  const r = resp as { content: { text: string }[]; isError?: boolean };
  return JSON.parse(r.content[0]?.text ?? '') as T;
}

function mem(id: string, content: string): NewMemory {
  return {
    id,
    title: deriveTitle(content),
    content,
    scope: 'global',
    projectId: null,
    type: 'project',
    tags: [],
    status: 'active',
    replaces: [],
    createdAt: new Date(1_000),
    lastSeenAt: new Date(1_000),
  };
}

function memInProject(id: string, content: string, projectId: string): NewMemory {
  return { ...mem(id, content), scope: 'project', projectId };
}

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  relations = new RelationsService(repos, db.handle.db);
  memorySvc = new MemoryService(repos, db.handle.db);
  handlers = buildRelationsHandlers({
    relations,
    router: new SessionRouter(),
    projects: new ProjectsService(repos),
    repos,
  });
});

afterEach(() => db.cleanup());

describe('memory.judge — batch form', () => {
  it('judges each item independently: a bogus id errors without rolling back the good ones', async () => {
    db.handle.db
      .insert(memory)
      .values([mem('A', 'a'), mem('B', 'b'), mem('C', 'c'), mem('D', 'd')])
      .run();
    const p1 = relations.createPending({ sourceId: 'A', targetId: 'B' });
    const p2 = relations.createPending({ sourceId: 'C', targetId: 'D' });

    const r = await runWithContext(fakeContext(), () =>
      Promise.resolve(
        handlers.judge({
          judgments: [
            { judgmentId: p1.judgmentId, relation: 'related' },
            { judgmentId: 'does-not-exist', relation: 'related' },
            { judgmentId: p2.judgmentId, relation: 'related' },
          ],
        }),
      ),
    );

    const { results } = parse<{
      results: { ok: boolean; judgmentId: string; status?: string; code?: string }[];
    }>(r);
    expect(results.map((x) => x.ok)).toEqual([true, false, true]);
    // `not_found` (not `memory_not_found`): change enforce-mcp-authorization
    // unified missing and out-of-scope judgment ids so existence never leaks.
    expect(results[1]?.code).toBe('not_found');
    // The good items persisted (not rolled back by the bad one in the middle).
    expect(repos.relations.findByJudgmentId(p1.judgmentId)?.status).toBe('judged');
    expect(repos.relations.findByJudgmentId(p2.judgmentId)?.status).toBe('judged');
  });

  it('a supersedes item in the batch still marks its target superseded', async () => {
    db.handle.db
      .insert(memory)
      .values([mem('S', 'source'), mem('T', 'target')])
      .run();
    const p = relations.createPending({ sourceId: 'S', targetId: 'T' });

    await runWithContext(fakeContext(), () =>
      Promise.resolve(
        handlers.judge({ judgments: [{ judgmentId: p.judgmentId, relation: 'supersedes' }] }),
      ),
    );
    expect(memorySvc.unsafeGetById('T')?.status).toBe('superseded');
  });

  it('single-form judge is unchanged', async () => {
    db.handle.db
      .insert(memory)
      .values([mem('A', 'a'), mem('B', 'b')])
      .run();
    const p = relations.createPending({ sourceId: 'A', targetId: 'B' });

    const r = await runWithContext(fakeContext(), () =>
      Promise.resolve(handlers.judge({ judgmentId: p.judgmentId, relation: 'related' })),
    );
    const out = parse<{ ok: boolean; judgmentId: string; status: string }>(r);
    expect(out.ok).toBe(true);
    expect(out.judgmentId).toBe(p.judgmentId);
    expect(out.status).toBe('judged');
  });

  it('rejects supplying BOTH single fields and judgments (spec: exactly one)', async () => {
    db.handle.db
      .insert(memory)
      .values([mem('A', 'a'), mem('B', 'b')])
      .run();
    const p = relations.createPending({ sourceId: 'A', targetId: 'B' });
    const r = await runWithContext(fakeContext(), () =>
      Promise.resolve(
        handlers.judge({
          judgmentId: p.judgmentId,
          relation: 'related',
          judgments: [{ judgmentId: p.judgmentId, relation: 'related' }],
        }),
      ),
    );
    const out = parse<{ ok: boolean; code: string }>(r);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('invalid_input');
    // The pending row must remain untouched (no silent partial judge).
    expect(repos.relations.findByJudgmentId(p.judgmentId)?.status).toBe('pending');
  });

  it('rejects supplying NEITHER single fields nor judgments', async () => {
    const r = await runWithContext(fakeContext(), () => Promise.resolve(handlers.judge({})));
    const out = parse<{ ok: boolean; code: string }>(r);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('invalid_input');
  });
});

describe('memory.judge — cross-scope targets never leak existence', () => {
  let projects: ProjectsService;
  let projectA: Project;
  let projectB: Project;

  beforeEach(() => {
    projects = new ProjectsService(repos);
    projectA = projects.create({ slug: 'relations-proj-a' });
    projectB = projects.create({ slug: 'relations-proj-b' });
  });

  it('a pending judgment created in project B is not_found from a connection scoped to project A; the relation stays pending', async () => {
    db.handle.db
      .insert(memory)
      .values([
        memInProject('SB', 'source-b', projectB.id),
        memInProject('TB', 'target-b', projectB.id),
      ])
      .run();
    const pending = relations.createPending({ sourceId: 'SB', targetId: 'TB' });

    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.judge({ judgmentId: pending.judgmentId, relation: 'related' })),
    );
    const out = parse<{ ok: boolean; code: string }>(r);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('not_found');
    expect(repos.relations.findByJudgmentId(pending.judgmentId)?.status).toBe('pending');
  });

  it('same cross-scope rejection applies to each item of a batch judge', async () => {
    db.handle.db
      .insert(memory)
      .values([
        memInProject('SB2', 'source-b2', projectB.id),
        memInProject('TB2', 'target-b2', projectB.id),
      ])
      .run();
    const pending = relations.createPending({ sourceId: 'SB2', targetId: 'TB2' });

    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.judge({ judgments: [{ judgmentId: pending.judgmentId, relation: 'related' }] }),
      ),
    );
    const { results } = parse<{ results: { ok: boolean; code?: string }[] }>(r);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.code).toBe('not_found');
    expect(repos.relations.findByJudgmentId(pending.judgmentId)?.status).toBe('pending');
  });
});

describe('memory.suggest_topic_key — scope-aware occupied/nearby (fix-audited-defects)', () => {
  it('reports occupied:true with the occupant when the exact suggested key is already active', async () => {
    const title = 'Dev stack data dir needs chown 10001';
    const suggestion = suggestTopicKey({ type: 'project', title });
    const held = memorySvc.saveWithTopicKey(
      { type: 'project', title, content: 'x', topicKey: suggestion },
      { kind: 'global' },
    ).memory;

    const r = await runWithContext(fakeContext(), () =>
      Promise.resolve(
        handlers.suggestTopicKey({
          type: 'project',
          title: 'Dev stack data dir needs chown 10001',
        }),
      ),
    );
    const out = parse<{
      topic_key: string;
      occupied: boolean;
      occupantId?: string;
      occupantTitle?: string;
      nearby: { topicKey: string; title: string }[];
    }>(r);
    expect(out.topic_key).toBe(suggestion);
    expect(out.occupied).toBe(true);
    expect(out.occupantId).toBe(held.id);
    expect(out.occupantTitle).toBe(held.title);
  });

  it('reports occupied:false and no occupant fields when the exact key is free', async () => {
    const r = await runWithContext(fakeContext(), () =>
      Promise.resolve(
        handlers.suggestTopicKey({ type: 'project', title: 'Genuinely novel topic' }),
      ),
    );
    const out = parse<{ occupied: boolean; occupantId?: string }>(r);
    expect(out.occupied).toBe(false);
    expect(out.occupantId).toBeUndefined();
  });

  it('surfaces a near-miss active key sharing a prefix in nearby[]', async () => {
    const heldTitle = 'Dev stack data dir needs chown permissions';
    const heldKey = suggestTopicKey({ type: 'project', title: heldTitle });
    const held = memorySvc.saveWithTopicKey(
      { type: 'project', title: heldTitle, content: 'x', topicKey: heldKey },
      { kind: 'global' },
    ).memory;

    const r = await runWithContext(fakeContext(), () =>
      Promise.resolve(
        handlers.suggestTopicKey({ type: 'project', title: 'Dev stack data dir chown fix' }),
      ),
    );
    const out = parse<{
      occupied: boolean;
      nearby: { topicKey: string; title: string }[];
    }>(r);
    expect(out.occupied).toBe(false);
    expect(out.nearby.map((n) => n.topicKey)).toContain(held.topicKey);
  });

  it('does not leak a key held only in another project into nearby or occupied', async () => {
    const projects = new ProjectsService(repos);
    const projectA = projects.create({ slug: 'suggest-proj-a' });
    const projectB = projects.create({ slug: 'suggest-proj-b' });
    const title = 'Dev stack data dir needs chown 10001';
    memorySvc.saveWithTopicKey(
      {
        type: 'project',
        title,
        content: 'x',
        topicKey: suggestTopicKey({ type: 'project', title }),
      },
      { kind: 'project', projectId: projectB.id },
    );

    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.suggestTopicKey({
          type: 'project',
          title: 'Dev stack data dir needs chown 10001',
        }),
      ),
    );
    const out = parse<{
      occupied: boolean;
      occupantId?: string;
      nearby: { topicKey: string; title: string }[];
    }>(r);
    expect(out.occupied).toBe(false);
    expect(out.occupantId).toBeUndefined();
    expect(out.nearby).toEqual([]);
  });
});

describe('memory.compare — cross-scope targets never leak existence', () => {
  let projects: ProjectsService;
  let projectA: Project;

  beforeEach(() => {
    projects = new ProjectsService(repos);
    projectA = projects.create({ slug: 'compare-proj-a' });
  });

  it('comparing a project-A memory against a global memory from a project-A connection is not_found', async () => {
    db.handle.db
      .insert(memory)
      .values([memInProject('CA', 'compare-a', projectA.id), mem('CG', 'compare-global')])
      .run();

    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.compare({
          memoryIdA: 'CA',
          memoryIdB: 'CG',
          relation: 'related',
          confidence: 0.9,
        }),
      ),
    );
    const out = parse<{ ok: boolean; code: string }>(r);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('not_found');
    expect(repos.relations.findBySourceAndTarget('CA', 'CG')).toBeUndefined();
  });
});
