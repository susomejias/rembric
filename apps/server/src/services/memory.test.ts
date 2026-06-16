import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { createTestDb, type TestDb, TestClock } from '../test/index.js';

import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { SCOPE_GLOBAL, projectScope } from './scope.js';

let db: TestDb;
let projects: ProjectsService;
let memory: MemoryService;
let clock: TestClock;
let projectId: string;

beforeEach(() => {
  db = createTestDb();
  clock = new TestClock();
  projects = new ProjectsService(createRepositories(db.handle.db), clock.now);
  memory = new MemoryService(createRepositories(db.handle.db), db.handle.db, clock.now);
  projectId = projects.create({ slug: 'test-app' }).id;
});

afterEach(() => {
  db.cleanup();
});

describe('memory.save', () => {
  it('persists with the scope passed in (project)', () => {
    const m = memory.save(
      { type: 'user', content: 'prefers tabs', tags: ['editor'] },
      projectScope(projectId),
    );
    expect(m.scope).toBe('project');
    expect(m.projectId).toBe(projectId);
    expect(m.status).toBe('active');
    expect(m.tags).toEqual(['editor']);
  });

  it('persists with the scope passed in (global)', () => {
    const m = memory.save({ type: 'user', content: 'dark mode' }, SCOPE_GLOBAL);
    expect(m.scope).toBe('global');
    expect(m.projectId).toBeNull();
  });

  it('rejects empty content', () => {
    expect(() => memory.save({ type: 'user', content: '   ' }, SCOPE_GLOBAL)).toThrow(/non-empty/);
  });
});

describe('memory.search', () => {
  it('FTS5 keyword match within scope', async () => {
    memory.save({ type: 'user', content: 'prefers tabs over spaces' }, projectScope(projectId));
    memory.save({ type: 'user', content: 'uses pnpm not npm' }, projectScope(projectId));

    const results = await memory.search({ query: 'tabs' }, projectScope(projectId));
    expect(results.length).toBe(1);
    expect(results[0]!.content).toMatch(/tabs/);
  });

  it('never leaks across projects', async () => {
    const otherId = projects.create({ slug: 'other-app' }).id;
    memory.save({ type: 'user', content: 'in project A' }, projectScope(projectId));
    memory.save({ type: 'user', content: 'in project B' }, projectScope(otherId));

    const a = await memory.search({}, projectScope(projectId));
    expect(a.every((m) => m.projectId === projectId)).toBe(true);
    expect(a.some((m) => m.content.includes('B'))).toBe(false);
  });

  it("global scope returns globals only — projects don't leak", async () => {
    memory.save({ type: 'user', content: 'global one' }, SCOPE_GLOBAL);
    memory.save({ type: 'user', content: 'project one' }, projectScope(projectId));

    const globals = await memory.search({}, SCOPE_GLOBAL);
    expect(globals.every((m) => m.scope === 'global')).toBe(true);
  });

  it("project scope returns project only — globals don't leak", async () => {
    memory.save({ type: 'user', content: 'global g' }, SCOPE_GLOBAL);
    memory.save({ type: 'user', content: 'project p' }, projectScope(projectId));

    const proj = await memory.search({}, projectScope(projectId));
    expect(proj.every((m) => m.scope === 'project' && m.projectId === projectId)).toBe(true);
  });

  it('defaults to at most 8 results when no limit is given (both branches)', async () => {
    for (let i = 0; i < 12; i++) {
      memory.save({ type: 'user', content: `widget number ${i}` }, projectScope(projectId));
    }
    // Hybrid text-query branch (FTS-only here: no embedQuery wired).
    const queried = await memory.search({ query: 'widget' }, projectScope(projectId));
    expect(queried.length).toBe(8);
    // No-query chronological listing branch.
    const listed = await memory.search({}, projectScope(projectId));
    expect(listed.length).toBe(8);
  });

  it('an explicit limit overrides the default in both directions', async () => {
    for (let i = 0; i < 12; i++) {
      memory.save({ type: 'user', content: `widget number ${i}` }, projectScope(projectId));
    }
    expect(
      (await memory.search({ query: 'widget', limit: 3 }, projectScope(projectId))).length,
    ).toBe(3);
    expect((await memory.search({ limit: 12 }, projectScope(projectId))).length).toBe(12);
  });
});

describe('memory.get', () => {
  it('returns memory + history when in scope', () => {
    const saved = memory.save({ type: 'user', content: 'fresh' }, projectScope(projectId));
    const result = memory.get(saved.id, projectScope(projectId));
    expect(result?.memory.id).toBe(saved.id);
    expect(result?.predecessors).toEqual([]);
    expect(result?.confirmationCount).toBe(0);
  });

  it('returns null for a global id when scope is project', () => {
    const g = memory.save({ type: 'user', content: 'g' }, SCOPE_GLOBAL);
    const result = memory.get(g.id, projectScope(projectId));
    expect(result).toBeNull();
  });

  it('returns null for a project id when scope is global', () => {
    const p = memory.save({ type: 'user', content: 'p' }, projectScope(projectId));
    const result = memory.get(p.id, SCOPE_GLOBAL);
    expect(result).toBeNull();
  });

  it('returns null for a memory in a different project', () => {
    const otherId = projects.create({ slug: 'other' }).id;
    const m = memory.save({ type: 'user', content: 'in other' }, projectScope(otherId));
    const result = memory.get(m.id, projectScope(projectId));
    expect(result).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(memory.get('does-not-exist', SCOPE_GLOBAL)).toBeNull();
  });
});

describe('memory.confirm', () => {
  it('records confirmations against the head', () => {
    const m = memory.save({ type: 'user', content: 'count me' }, projectScope(projectId));
    memory.confirm(m.id, projectScope(projectId));
    memory.confirm(m.id, projectScope(projectId));
    const result = memory.get(m.id, projectScope(projectId));
    expect(result?.confirmationCount).toBe(2);
  });

  it('throws not_found for cross-scope ids', () => {
    const m = memory.save({ type: 'user', content: 'x' }, projectScope(projectId));
    expect(() => memory.confirm(m.id, SCOPE_GLOBAL)).toThrow(/not found/);
  });

  it('throws not_found for unknown ids', () => {
    expect(() => memory.confirm('nope', SCOPE_GLOBAL)).toThrow(/not found/);
  });
});

describe('memory.archive', () => {
  it('flips active → archived when in scope', () => {
    const m = memory.save({ type: 'user', content: 'x' }, projectScope(projectId));
    memory.archive(m.id, projectScope(projectId));
    const refetched = memory.unsafeGetById(m.id);
    expect(refetched?.status).toBe('archived');
  });

  it('refuses to archive an out-of-scope memory', () => {
    const m = memory.save({ type: 'user', content: 'x' }, projectScope(projectId));
    expect(() => memory.archive(m.id, SCOPE_GLOBAL)).toThrow(/not found/);
  });

  it('refuses to archive a non-active memory', () => {
    const m = memory.save({ type: 'user', content: 'x' }, projectScope(projectId));
    memory.archive(m.id, projectScope(projectId));
    expect(() => memory.archive(m.id, projectScope(projectId))).toThrow(/not in 'active'/);
  });
});

describe('memory.purgeDisconnectedArchived', () => {
  it('purges archived memories that are not referenced anywhere', () => {
    const m = memory.save({ type: 'user', content: 'disconnected' }, projectScope(projectId));
    memory.archive(m.id, projectScope(projectId));

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).toContain(m.id);
    expect(memory.unsafeGetById(m.id)).toBeUndefined();
  });

  it('writes an archived_memory_purge op to consolidation_ops with the ids', () => {
    const m = memory.save({ type: 'user', content: 'journaled' }, projectScope(projectId));
    memory.archive(m.id, projectScope(projectId));

    memory.purgeDisconnectedArchived({ adminBypass: true });

    const ops = db.handle.raw
      .prepare(`SELECT op_type, affected_ids, reasoning FROM consolidation_ops`)
      .all() as { op_type: string; affected_ids: string; reasoning: string }[];
    const purgeOp = ops.find((o) => o.op_type === 'archived_memory_purge');
    expect(purgeOp).toBeDefined();
    const affected = JSON.parse(purgeOp!.affected_ids) as string[];
    expect(affected).toContain(m.id);
    expect(purgeOp!.reasoning).toMatch(/operator purge of disconnected archived memories/);
  });

  it('drops the embedding row from memory_vec in the same transaction', () => {
    const m = memory.save({ type: 'user', content: 'with-vec' }, projectScope(projectId));
    memory.archive(m.id, projectScope(projectId));

    // Insert a fake embedding row directly.
    const fakeEmbedding = Buffer.alloc(768 * 4);
    db.handle.raw
      .prepare(
        'INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) VALUES (?, ?, ?, ?, ?)',
      )
      .run(m.id, m.projectId, 'archived', m.type, fakeEmbedding);
    const beforeCount = (
      db.handle.raw
        .prepare('SELECT COUNT(*) AS v FROM memory_vec WHERE memory_id = ?')
        .get(m.id) as { v: number }
    ).v;
    expect(beforeCount).toBe(1);

    memory.purgeDisconnectedArchived({ adminBypass: true });

    const afterCount = (
      db.handle.raw
        .prepare('SELECT COUNT(*) AS v FROM memory_vec WHERE memory_id = ?')
        .get(m.id) as { v: number }
    ).v;
    expect(afterCount).toBe(0);
  });

  it('skips an archived memory that is referenced via replaces[] from another row', () => {
    const oldRow = memory.save(
      { type: 'user', content: 'old', topicKey: 'demo-topic' },
      projectScope(projectId),
    );
    // Auto-supersede via topic_key: the new save points its `replaces`
    // at oldRow.id, and oldRow transitions to 'superseded'. Manually
    // flip it to archived to satisfy the (a) condition of the predicate.
    memory.save({ type: 'user', content: 'new', topicKey: 'demo-topic' }, projectScope(projectId));
    db.handle.raw.prepare(`UPDATE memory SET status = 'archived' WHERE id = ?`).run(oldRow.id);

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).not.toContain(oldRow.id);
    expect(memory.unsafeGetById(oldRow.id)).toBeDefined();
  });

  it('skips an archived memory referenced by a consolidation_ops.affected_ids row', () => {
    const m = memory.save({ type: 'user', content: 'referenced-by-op' }, projectScope(projectId));
    memory.archive(m.id, projectScope(projectId));

    // Manually insert a consolidation_ops row referencing m via affected_ids.
    db.handle.raw
      .prepare(`INSERT INTO consolidation_runs (id, started_at) VALUES (?, ?)`)
      .run('test-run-001', Date.now());
    db.handle.raw
      .prepare(
        `INSERT INTO consolidation_ops
           (id, consolidation_id, op_type, affected_ids, applied_at)
         VALUES (?, ?, 'decay', ?, ?)`,
      )
      .run('test-op-001', 'test-run-001', JSON.stringify([m.id]), Date.now());

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).not.toContain(m.id);
  });

  it('skips an archived memory referenced by consolidation_ops.created_id', () => {
    const m = memory.save({ type: 'user', content: 'created-by-merge' }, projectScope(projectId));
    memory.archive(m.id, projectScope(projectId));

    db.handle.raw
      .prepare(`INSERT INTO consolidation_runs (id, started_at) VALUES (?, ?)`)
      .run('test-run-002', Date.now());
    db.handle.raw
      .prepare(
        `INSERT INTO consolidation_ops
           (id, consolidation_id, op_type, affected_ids, created_id, applied_at)
         VALUES (?, ?, 'merge', ?, ?, ?)`,
      )
      .run('test-op-002', 'test-run-002', JSON.stringify(['other-id']), m.id, Date.now());

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).not.toContain(m.id);
  });

  it('skips an archived memory referenced by memory_relations', () => {
    const m = memory.save({ type: 'user', content: 'referenced-by-rel' }, projectScope(projectId));
    memory.archive(m.id, projectScope(projectId));
    // Insert a memory_relations row using m as source.
    const other = memory.save({ type: 'user', content: 'other' }, projectScope(projectId));
    db.handle.raw
      .prepare(
        `INSERT INTO memory_relations
           (id, judgment_id, source_id, target_id, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run('rel-001', 'jud-001', m.id, other.id, Date.now());

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).not.toContain(m.id);
  });

  it('skips an archived memory with a surviving confirmation', () => {
    const m = memory.save({ type: 'user', content: 'confirmed' }, projectScope(projectId));
    memory.confirm(m.id, projectScope(projectId));
    memory.archive(m.id, projectScope(projectId));

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).not.toContain(m.id);
  });

  it('skips active memories even when disconnected', () => {
    const m = memory.save({ type: 'user', content: 'still-active' }, projectScope(projectId));
    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).not.toContain(m.id);
  });

  it('skips superseded memories even when disconnected from the graph', () => {
    const m = memory.save({ type: 'user', content: 'superseded' }, projectScope(projectId));
    db.handle.raw.prepare(`UPDATE memory SET status = 'superseded' WHERE id = ?`).run(m.id);

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).not.toContain(m.id);
  });

  it('returns an empty list when nothing matches (no-op)', () => {
    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).toEqual([]);
  });

  it('throws forbidden when adminBypass is not strictly true', () => {
    expect(() =>
      memory.purgeDisconnectedArchived({ adminBypass: false as unknown as true }),
    ).toThrow(/adminBypass:true required/);
    expect(() => memory.purgeDisconnectedArchived({} as unknown as { adminBypass: true })).toThrow(
      /adminBypass:true required/,
    );
  });
});

describe('derived review state', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('needsReviewForContext surfaces a stale memory and memory.confirm clears it', () => {
    const m = memory.save({ type: 'project', content: 'ship v1 by Q2' }, projectScope(projectId));

    expect(memory.needsReviewForContext(projectScope(projectId), 5)).toHaveLength(0);

    clock.advance(100 * DAY); // project TTL is 3 months (~90 days)
    const stale = memory.needsReviewForContext(projectScope(projectId), 5);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.memory.id).toBe(m.id);
    expect(stale[0]!.reviewAfter.getTime()).toBeLessThanOrEqual(clock.value.getTime());

    memory.confirm(m.id, projectScope(projectId));
    expect(memory.needsReviewForContext(projectScope(projectId), 5)).toHaveLength(0);
  });

  it('a reference (no TTL) never needs review', () => {
    memory.save({ type: 'reference', content: 'dashboard: https://x' }, projectScope(projectId));
    clock.advance(400 * DAY);
    expect(memory.needsReviewForContext(projectScope(projectId), 5)).toHaveLength(0);
  });

  it('needsReview respects scope isolation', () => {
    const otherId = projects.create({ slug: 'other-app' }).id;
    memory.save({ type: 'project', content: 'A goal' }, projectScope(projectId));
    clock.advance(100 * DAY);

    expect(memory.needsReviewForContext(projectScope(otherId), 5)).toHaveLength(0);
    expect(memory.needsReviewForContext(SCOPE_GLOBAL, 5)).toHaveLength(0);
    expect(memory.needsReviewForContext(projectScope(projectId), 5)).toHaveLength(1);
  });

  it('excludes archived memories from needsReview', () => {
    const m = memory.save({ type: 'project', content: 'old plan' }, projectScope(projectId));
    clock.advance(100 * DAY);
    memory.archive(m.id, projectScope(projectId));
    expect(memory.needsReviewForContext(projectScope(projectId), 5)).toHaveLength(0);
  });

  it('memory.get exposes reviewState/reviewAfter for an active head', () => {
    const m = memory.save(
      { type: 'feedback', content: 'prefers terse PRs' },
      projectScope(projectId),
    );
    const fresh = memory.get(m.id, projectScope(projectId));
    expect(fresh?.reviewState).toBe('fresh');
    expect(fresh?.reviewAfter).toBeInstanceOf(Date);

    clock.advance(200 * DAY); // feedback TTL is 6 months (~180 days)
    const stale = memory.get(m.id, projectScope(projectId));
    expect(stale?.reviewState).toBe('needs_review');
  });

  it('reviewStateForMemories maps each searched row', async () => {
    memory.save({ type: 'project', content: 'find me tabs' }, projectScope(projectId));
    clock.advance(100 * DAY);
    const results = await memory.search({ query: 'tabs' }, projectScope(projectId));
    const review = memory.reviewStateForMemories(results);
    expect(review.get(results[0]!.id)?.reviewState).toBe('needs_review');
  });
});
