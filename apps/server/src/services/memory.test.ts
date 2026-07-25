import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { createTestDb, type TestDb, TestClock } from '../test/index.js';

import { DomainError } from './errors.js';
import { deriveTitle, MemoryService } from './memory.js';
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

describe('memory.getMany (scoped batch retrieve)', () => {
  it('returns in-scope rows in request order and omits cross-scope/missing ids', () => {
    const otherId = projects.create({ slug: 'other-app' }).id;
    const a = memory.save({ type: 'user', title: 'A', content: 'a' }, projectScope(projectId));
    const b = memory.save({ type: 'user', title: 'B', content: 'b' }, projectScope(projectId));
    const cross = memory.save({ type: 'user', title: 'X', content: 'x' }, projectScope(otherId));

    const rows = memory.getMany([b.id, 'missing', cross.id, a.id], projectScope(projectId));
    // Order preserved; the cross-scope and missing ids are simply absent (no leak).
    expect(rows.map((m) => m.id)).toEqual([b.id, a.id]);
  });

  it('returns an empty array for an empty id list', () => {
    expect(memory.getMany([], projectScope(projectId))).toEqual([]);
  });
});

describe('memory.save', () => {
  it('persists with the scope passed in (project)', () => {
    const m = memory.save(
      { type: 'user', title: 'Prefers tabs', content: 'prefers tabs', tags: ['editor'] },
      projectScope(projectId),
    );
    expect(m.scope).toBe('project');
    expect(m.projectId).toBe(projectId);
    expect(m.status).toBe('active');
    expect(m.tags).toEqual(['editor']);
  });

  it('persists with the scope passed in (global)', () => {
    const m = memory.save({ type: 'user', title: 'Dark mode', content: 'dark mode' }, SCOPE_GLOBAL);
    expect(m.scope).toBe('global');
    expect(m.projectId).toBeNull();
  });

  it('rejects empty content', () => {
    expect(() =>
      memory.save({ type: 'user', title: 'Blank content', content: '   ' }, SCOPE_GLOBAL),
    ).toThrow(/non-empty/);
  });

  it('rejects an empty title with invalid_input', () => {
    try {
      memory.save({ type: 'user', title: '', content: 'has content' }, SCOPE_GLOBAL);
      expect.unreachable('save should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('invalid_input');
    }
  });

  it('rejects a title longer than 100 chars with invalid_input', () => {
    try {
      memory.save({ type: 'user', title: 'a'.repeat(101), content: 'has content' }, SCOPE_GLOBAL);
      expect.unreachable('save should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('invalid_input');
    }
  });

  it('persists the title it was given', () => {
    const m = memory.save(
      { type: 'user', title: 'Use pnpm workspaces', content: 'the monorepo uses pnpm workspaces' },
      projectScope(projectId),
    );
    expect(m.title).toBe('Use pnpm workspaces');
    const refetched = memory.unsafeGetById(m.id);
    expect(refetched?.title).toBe('Use pnpm workspaces');
  });

  // fix-audited-defects: SQLite's length() (and the CHECK built on it) stops
  // at the first NUL, so a value whose JS .length satisfies a bound can still
  // trip the DB constraint and surface as an opaque internal_error with the
  // row never written. These must be rejected before the DB sees them.
  it('rejects a title containing a NUL byte with invalid_input, never writing a row', () => {
    try {
      memory.save({ type: 'user', title: '\0abc', content: 'has content' }, SCOPE_GLOBAL);
      expect.unreachable('save should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('invalid_input');
    }
  });

  it('rejects content containing an embedded NUL byte with invalid_input', () => {
    try {
      memory.save({ type: 'user', title: 'ok title', content: 'ab\0c' }, SCOPE_GLOBAL);
      expect.unreachable('save should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('invalid_input');
    }
  });

  it('rejects a tag containing a NUL byte with invalid_input', () => {
    try {
      memory.save(
        { type: 'user', title: 'ok title', content: 'ok content', tags: ['fine', 'ba\0d'] },
        SCOPE_GLOBAL,
      );
      expect.unreachable('save should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('invalid_input');
    }
  });

  it('rejects a topic_key containing a NUL byte with invalid_input', () => {
    try {
      memory.saveWithTopicKey(
        { type: 'user', title: 'ok title', content: 'ok content', topicKey: 'topic\0key' },
        SCOPE_GLOBAL,
      );
      expect.unreachable('save should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('invalid_input');
    }
  });
});

describe('memory.search', () => {
  it('FTS5 keyword match within scope', async () => {
    memory.save(
      { type: 'user', title: 'Prefers tabs over spaces', content: 'prefers tabs over spaces' },
      projectScope(projectId),
    );
    memory.save(
      { type: 'user', title: 'Uses pnpm not npm', content: 'uses pnpm not npm' },
      projectScope(projectId),
    );

    const results = await memory.search({ query: 'tabs' }, projectScope(projectId));
    expect(results.length).toBe(1);
    expect(results[0]!.content).toMatch(/tabs/);
  });

  it('never leaks across projects', async () => {
    const otherId = projects.create({ slug: 'other-app' }).id;
    memory.save(
      { type: 'user', title: 'In project A', content: 'in project A' },
      projectScope(projectId),
    );
    memory.save(
      { type: 'user', title: 'In project B', content: 'in project B' },
      projectScope(otherId),
    );

    const a = await memory.search({}, projectScope(projectId));
    expect(a.every((m) => m.projectId === projectId)).toBe(true);
    expect(a.some((m) => m.content.includes('B'))).toBe(false);
  });

  it("global scope returns globals only — projects don't leak", async () => {
    memory.save({ type: 'user', title: 'Global one', content: 'global one' }, SCOPE_GLOBAL);
    memory.save(
      { type: 'user', title: 'Project one', content: 'project one' },
      projectScope(projectId),
    );

    const globals = await memory.search({}, SCOPE_GLOBAL);
    expect(globals.every((m) => m.scope === 'global')).toBe(true);
  });

  it("project scope returns project only — globals don't leak", async () => {
    memory.save({ type: 'user', title: 'Global g', content: 'global g' }, SCOPE_GLOBAL);
    memory.save(
      { type: 'user', title: 'Project p', content: 'project p' },
      projectScope(projectId),
    );

    const proj = await memory.search({}, projectScope(projectId));
    expect(proj.every((m) => m.scope === 'project' && m.projectId === projectId)).toBe(true);
  });

  it('defaults to at most 8 results when no limit is given (both branches)', async () => {
    for (let i = 0; i < 12; i++) {
      memory.save(
        { type: 'user', title: deriveTitle(`widget number ${i}`), content: `widget number ${i}` },
        projectScope(projectId),
      );
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
      memory.save(
        { type: 'user', title: deriveTitle(`widget number ${i}`), content: `widget number ${i}` },
        projectScope(projectId),
      );
    }
    expect(
      (await memory.search({ query: 'widget', limit: 3 }, projectScope(projectId))).length,
    ).toBe(3);
    expect((await memory.search({ limit: 12 }, projectScope(projectId))).length).toBe(12);
  });
});

describe('memory.get', () => {
  it('returns memory + history when in scope', () => {
    const saved = memory.save(
      { type: 'user', title: 'Fresh', content: 'fresh' },
      projectScope(projectId),
    );
    const result = memory.get(saved.id, projectScope(projectId));
    expect(result?.memory.id).toBe(saved.id);
    expect(result?.predecessors).toEqual([]);
    expect(result?.confirmationCount).toBe(0);
  });

  it('returns null for a global id when scope is project', () => {
    const g = memory.save({ type: 'user', title: 'Global g', content: 'g' }, SCOPE_GLOBAL);
    const result = memory.get(g.id, projectScope(projectId));
    expect(result).toBeNull();
  });

  it('returns null for a project id when scope is global', () => {
    const p = memory.save(
      { type: 'user', title: 'Project p', content: 'p' },
      projectScope(projectId),
    );
    const result = memory.get(p.id, SCOPE_GLOBAL);
    expect(result).toBeNull();
  });

  it('returns null for a memory in a different project', () => {
    const otherId = projects.create({ slug: 'other' }).id;
    const m = memory.save(
      { type: 'user', title: 'In other', content: 'in other' },
      projectScope(otherId),
    );
    const result = memory.get(m.id, projectScope(projectId));
    expect(result).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(memory.get('does-not-exist', SCOPE_GLOBAL)).toBeNull();
  });
});

describe('memory.confirm', () => {
  it('records confirmations against the head', () => {
    const m = memory.save(
      { type: 'user', title: 'Count me', content: 'count me' },
      projectScope(projectId),
    );
    memory.confirm(m.id, projectScope(projectId));
    memory.confirm(m.id, projectScope(projectId));
    const result = memory.get(m.id, projectScope(projectId));
    expect(result?.confirmationCount).toBe(2);
  });

  it('throws not_found for cross-scope ids', () => {
    const m = memory.save(
      { type: 'user', title: 'Sample x', content: 'x' },
      projectScope(projectId),
    );
    expect(() => memory.confirm(m.id, SCOPE_GLOBAL)).toThrow(/not found/);
  });

  it('throws not_found for unknown ids', () => {
    expect(() => memory.confirm('nope', SCOPE_GLOBAL)).toThrow(/not found/);
  });
});

describe('memory.archive', () => {
  it('flips active → archived when in scope', () => {
    const m = memory.save(
      { type: 'user', title: 'Sample x', content: 'x' },
      projectScope(projectId),
    );
    memory.archive(m.id, projectScope(projectId));
    const refetched = memory.unsafeGetById(m.id);
    expect(refetched?.status).toBe('archived');
  });

  it('refuses to archive an out-of-scope memory', () => {
    const m = memory.save(
      { type: 'user', title: 'Sample x', content: 'x' },
      projectScope(projectId),
    );
    expect(() => memory.archive(m.id, SCOPE_GLOBAL)).toThrow(/not found/);
  });

  it('refuses to archive a non-active memory', () => {
    const m = memory.save(
      { type: 'user', title: 'Sample x', content: 'x' },
      projectScope(projectId),
    );
    memory.archive(m.id, projectScope(projectId));
    expect(() => memory.archive(m.id, projectScope(projectId))).toThrow(/not in 'active'/);
  });

  it('journals the archive as a reversible agent_memory_archive op', () => {
    const m = memory.save(
      { type: 'user', title: 'Sample x', content: 'x' },
      projectScope(projectId),
    );
    memory.archive(m.id, projectScope(projectId));

    const ops = db.handle.raw
      .prepare(`SELECT op_type, affected_ids, reasoning, reverted_at FROM consolidation_ops`)
      .all() as {
      op_type: string;
      affected_ids: string;
      reasoning: string;
      reverted_at: number | null;
    }[];
    const archiveOp = ops.find((o) => o.op_type === 'agent_memory_archive');
    expect(archiveOp).toBeDefined();
    expect(JSON.parse(archiveOp!.affected_ids)).toEqual([m.id]);
    expect(archiveOp!.reasoning).toMatch(/agent archived memory at explicit user request/);
    // Not reverted, and the row is still physically present → reversible.
    expect(archiveOp!.reverted_at).toBeNull();
    expect(memory.unsafeGetById(m.id)).toBeDefined();
  });

  it('does not mutate content/title/replaces or insert a supersedes relation', () => {
    const m = memory.save(
      { type: 'user', title: 'Immutable title', content: 'immutable body' },
      projectScope(projectId),
    );
    memory.archive(m.id, projectScope(projectId));

    const refetched = memory.unsafeGetById(m.id);
    expect(refetched?.title).toBe('Immutable title');
    expect(refetched?.content).toBe('immutable body');
    expect(refetched?.replaces).toEqual([]);

    const relations = db.handle.raw
      .prepare(`SELECT count(*) AS n FROM memory_relations WHERE source_id = ? OR target_id = ?`)
      .get(m.id, m.id) as { n: number };
    expect(relations.n).toBe(0);
  });
});

describe('memory.purgeDisconnectedArchived', () => {
  it('purges archived memories that are not referenced anywhere', () => {
    const m = memory.save(
      { type: 'user', title: 'Disconnected', content: 'disconnected' },
      projectScope(projectId),
    );
    memory.archive(m.id, projectScope(projectId));

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).toContain(m.id);
    expect(memory.unsafeGetById(m.id)).toBeUndefined();
  });

  // Explicitly pins the `agent_memory_archive` purge carve-out (PURGE_PREDICATE
  // excludes that op_type from the affected_ids pin). Archiving journals an
  // agent_memory_archive op referencing the row; without the carve-out that op
  // would pin the row and this purge would find nothing. Kept separate from the
  // generic "not referenced anywhere" case so a future refactor of that test
  // can't silently stop exercising the carve-out.
  it('purges an agent-archived memory whose only reference is its own archive op', () => {
    const m = memory.save(
      { type: 'user', title: 'Agent archived', content: 'agent-archived' },
      projectScope(projectId),
    );
    memory.archive(m.id, projectScope(projectId));

    const archiveOp = (
      db.handle.raw
        .prepare(`SELECT op_type, affected_ids FROM consolidation_ops WHERE op_type=?`)
        .all('agent_memory_archive') as { op_type: string; affected_ids: string }[]
    ).find((o) => (JSON.parse(o.affected_ids) as string[]).includes(m.id));
    expect(archiveOp, 'archive must journal an agent_memory_archive op for the row').toBeDefined();

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).toContain(m.id);
  });

  it('writes an archived_memory_purge op to consolidation_ops with the ids', () => {
    const m = memory.save(
      { type: 'user', title: 'Journaled', content: 'journaled' },
      projectScope(projectId),
    );
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
    const m = memory.save(
      { type: 'user', title: 'With vec', content: 'with-vec' },
      projectScope(projectId),
    );
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
      { type: 'user', title: 'Old', content: 'old', topicKey: 'demo-topic' },
      projectScope(projectId),
    );
    // Auto-supersede via topic_key: the new save points its `replaces`
    // at oldRow.id, and oldRow transitions to 'superseded'. Manually
    // flip it to archived to satisfy the (a) condition of the predicate.
    memory.save(
      { type: 'user', title: 'New', content: 'new', topicKey: 'demo-topic' },
      projectScope(projectId),
    );
    db.handle.raw.prepare(`UPDATE memory SET status = 'archived' WHERE id = ?`).run(oldRow.id);

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).not.toContain(oldRow.id);
    expect(memory.unsafeGetById(oldRow.id)).toBeDefined();
  });

  it('skips an archived memory referenced by a consolidation_ops.affected_ids row', () => {
    const m = memory.save(
      { type: 'user', title: 'Referenced by op', content: 'referenced-by-op' },
      projectScope(projectId),
    );
    memory.archive(m.id, projectScope(projectId));

    // Manually insert a consolidation_ops row referencing m via affected_ids.
    db.handle.raw
      .prepare(`INSERT INTO consolidation_runs (id, started_at, scope) VALUES (?, ?, 'global')`)
      .run('test-run-001', Date.now());
    db.handle.raw
      .prepare(
        `INSERT INTO consolidation_ops
           (id, run_id, op_type, affected_ids, applied_at)
         VALUES (?, ?, 'decay', ?, ?)`,
      )
      .run('test-op-001', 'test-run-001', JSON.stringify([m.id]), Date.now());

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).not.toContain(m.id);
  });

  it('skips an archived memory referenced by consolidation_ops.created_id', () => {
    const m = memory.save(
      { type: 'user', title: 'Created by merge', content: 'created-by-merge' },
      projectScope(projectId),
    );
    memory.archive(m.id, projectScope(projectId));

    db.handle.raw
      .prepare(`INSERT INTO consolidation_runs (id, started_at, scope) VALUES (?, ?, 'global')`)
      .run('test-run-002', Date.now());
    db.handle.raw
      .prepare(
        `INSERT INTO consolidation_ops
           (id, run_id, op_type, affected_ids, created_id, applied_at)
         VALUES (?, ?, 'merge', ?, ?, ?)`,
      )
      .run('test-op-002', 'test-run-002', JSON.stringify(['other-id']), m.id, Date.now());

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).not.toContain(m.id);
  });

  it('skips an archived memory referenced by memory_relations', () => {
    const m = memory.save(
      { type: 'user', title: 'Referenced by rel', content: 'referenced-by-rel' },
      projectScope(projectId),
    );
    memory.archive(m.id, projectScope(projectId));
    // Insert a memory_relations row using m as source.
    const other = memory.save(
      { type: 'user', title: 'Other', content: 'other' },
      projectScope(projectId),
    );
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
    const m = memory.save(
      { type: 'user', title: 'Confirmed', content: 'confirmed' },
      projectScope(projectId),
    );
    memory.confirm(m.id, projectScope(projectId));
    memory.archive(m.id, projectScope(projectId));

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).not.toContain(m.id);
  });

  it('skips active memories even when disconnected', () => {
    const m = memory.save(
      { type: 'user', title: 'Still active', content: 'still-active' },
      projectScope(projectId),
    );
    const result = memory.purgeDisconnectedArchived({ adminBypass: true });
    expect(result.deletedIds).not.toContain(m.id);
  });

  it('skips superseded memories even when disconnected from the graph', () => {
    const m = memory.save(
      { type: 'user', title: 'Superseded', content: 'superseded' },
      projectScope(projectId),
    );
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
    const m = memory.save(
      { type: 'project', title: 'Ship v1 by Q2', content: 'ship v1 by Q2' },
      projectScope(projectId),
    );

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
    memory.save(
      { type: 'reference', title: 'Dashboard link', content: 'dashboard: https://x' },
      projectScope(projectId),
    );
    clock.advance(400 * DAY);
    expect(memory.needsReviewForContext(projectScope(projectId), 5)).toHaveLength(0);
  });

  it('needsReview respects scope isolation', () => {
    const otherId = projects.create({ slug: 'other-app' }).id;
    memory.save({ type: 'project', title: 'A goal', content: 'A goal' }, projectScope(projectId));
    clock.advance(100 * DAY);

    expect(memory.needsReviewForContext(projectScope(otherId), 5)).toHaveLength(0);
    expect(memory.needsReviewForContext(SCOPE_GLOBAL, 5)).toHaveLength(0);
    expect(memory.needsReviewForContext(projectScope(projectId), 5)).toHaveLength(1);
  });

  it('excludes archived memories from needsReview', () => {
    const m = memory.save(
      { type: 'project', title: 'Old plan', content: 'old plan' },
      projectScope(projectId),
    );
    clock.advance(100 * DAY);
    memory.archive(m.id, projectScope(projectId));
    expect(memory.needsReviewForContext(projectScope(projectId), 5)).toHaveLength(0);
  });

  it('memory.get exposes reviewState/reviewAfter for an active head', () => {
    const m = memory.save(
      { type: 'feedback', title: 'Prefers terse PRs', content: 'prefers terse PRs' },
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
    memory.save(
      { type: 'project', title: 'Find me tabs', content: 'find me tabs' },
      projectScope(projectId),
    );
    clock.advance(100 * DAY);
    const results = await memory.search({ query: 'tabs' }, projectScope(projectId));
    const review = memory.reviewStateForMemories(results);
    expect(review.get(results[0]!.id)?.reviewState).toBe('needs_review');
  });
});

describe('deriveTitle', () => {
  it('strips a leading markdown marker and keeps the first line', () => {
    expect(deriveTitle('**Bold lead** then body')).toBe('Bold lead** then body');
    expect(deriveTitle('### Heading here\nbody')).toBe('Heading here');
  });

  it('uses only the first line of multi-line content', () => {
    expect(deriveTitle('First line\nsecond\nthird')).toBe('First line');
  });

  it('strips a trailing carriage return (CRLF content)', () => {
    expect(deriveTitle('Windows note\r\nsecond')).toBe('Windows note');
  });

  it('truncates to 100 chars', () => {
    expect(deriveTitle('x'.repeat(250))).toBe('x'.repeat(100));
  });

  it('falls back to a single-line collapse when the first line is marker-only', () => {
    // First line strips to empty → fallback to content, whitespace collapsed so
    // the title never contains an embedded newline.
    expect(deriveTitle('### \nreal second line')).toBe('### real second line');
    expect(deriveTitle('   \nReal title')).toBe('Real title');
  });

  it('does not split a surrogate pair at the 100-char truncation boundary', () => {
    // 99 ASCII chars + one astral emoji (2 UTF-16 units) = 101 units; a raw
    // slice(0,100) would cut the emoji in half, leaving a lone high surrogate
    // that decodes to U+FFFD when read back.
    const content = 'x'.repeat(99) + '😀' + 'trailing text';
    const title = deriveTitle(content);
    expect(title.length).toBeLessThanOrEqual(100);
    const lastCode = title.charCodeAt(title.length - 1);
    const isLoneHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
    expect(isLoneHighSurrogate).toBe(false);
  });
});
