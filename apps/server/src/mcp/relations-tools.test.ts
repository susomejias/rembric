import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { memory, type NewMemory } from '../db/schema/memory.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { deriveTitle, MemoryService } from '../services/memory.js';
import { RelationsService } from '../services/relations.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { buildRelationsHandlers } from './relations-tools.js';

let db: TestDb;
let repos: Repositories;
let relations: RelationsService;
let memorySvc: MemoryService;
let handlers: ReturnType<typeof buildRelationsHandlers>;

function fakeContext(): RequestContext {
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
  return { token, scope: '*', project: null, requestedSlug: null, mcpSessionId: null };
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

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  relations = new RelationsService(repos, db.handle.db);
  memorySvc = new MemoryService(repos, db.handle.db);
  handlers = buildRelationsHandlers({ relations });
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
    expect(results[1]?.code).toBe('memory_not_found');
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
