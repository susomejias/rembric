import { decodeTime } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import {
  createTestDb,
  defaultProject,
  defaultProjectScope,
  TestClock,
  type TestDb,
} from '../test/index.js';

import { EntityBackfillWorker } from './entity-backfill-worker.js';
import { DomainError } from './errors.js';
import { deriveTitle, MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { projectScope } from './scope.js';

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

  it('persists into the default project when that is the scope passed in', () => {
    const m = memory.save(
      { type: 'user', title: 'Dark mode', content: 'dark mode' },
      defaultProjectScope(db.handle),
    );
    expect(m.scope).toBe('project');
    expect(m.projectId).toBe(defaultProject(db.handle).id);
  });

  it('accepts the procedural type and round-trips it through get (improve-recall-relevance)', () => {
    const m = memory.save(
      { type: 'procedural', title: 'Deploy runbook', content: 'how deploys work here' },
      defaultProjectScope(db.handle),
    );
    expect(m.type).toBe('procedural');
    const fetched = memory.get(m.id, defaultProjectScope(db.handle));
    expect(fetched?.memory.type).toBe('procedural');
  });

  it('rejects empty content', () => {
    expect(() =>
      memory.save(
        { type: 'user', title: 'Blank content', content: '   ' },
        defaultProjectScope(db.handle),
      ),
    ).toThrow(/non-empty/);
  });

  it('rejects an empty title with invalid_input', () => {
    try {
      memory.save(
        { type: 'user', title: '', content: 'has content' },
        defaultProjectScope(db.handle),
      );
      expect.unreachable('save should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('invalid_input');
    }
  });

  it('rejects a title longer than 100 chars with invalid_input', () => {
    try {
      memory.save(
        { type: 'user', title: 'a'.repeat(101), content: 'has content' },
        defaultProjectScope(db.handle),
      );
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
      memory.save(
        { type: 'user', title: '\0abc', content: 'has content' },
        defaultProjectScope(db.handle),
      );
      expect.unreachable('save should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('invalid_input');
    }
  });

  it('rejects content containing an embedded NUL byte with invalid_input', () => {
    try {
      memory.save(
        { type: 'user', title: 'ok title', content: 'ab\0c' },
        defaultProjectScope(db.handle),
      );
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
        defaultProjectScope(db.handle),
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
        defaultProjectScope(db.handle),
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

  it("the default project is a project like any other — a named project's rows don't leak into it", async () => {
    const defaultId = defaultProject(db.handle).id;
    memory.save(
      { type: 'user', title: 'Default one', content: 'default one' },
      defaultProjectScope(db.handle),
    );
    memory.save(
      { type: 'user', title: 'Project one', content: 'project one' },
      projectScope(projectId),
    );

    const rows = await memory.search({}, defaultProjectScope(db.handle));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((m) => m.projectId === defaultId)).toBe(true);
  });

  it("project scope returns project only — globals don't leak", async () => {
    memory.save(
      { type: 'user', title: 'Global g', content: 'global g' },
      defaultProjectScope(db.handle),
    );
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

  it('never touches last_seen_at, in either the query or chronological branch (separate-access-from-usefulness)', async () => {
    const m = memory.save(
      { type: 'user', title: 'Prefers tabs over spaces', content: 'prefers tabs over spaces' },
      projectScope(projectId),
    );
    const originalLastSeen = memory.unsafeGetById(m.id)!.lastSeenAt?.getTime();

    clock.advance(1000);
    await memory.search({ query: 'tabs' }, projectScope(projectId));
    await memory.search({ query: 'tabs' }, projectScope(projectId));
    await memory.search({}, projectScope(projectId));

    expect(memory.unsafeGetById(m.id)!.lastSeenAt?.getTime()).toBe(originalLastSeen);
  });
});

describe('memory.search — entity filter (add-entity-index)', () => {
  it('returns every memory linked to an entity, bypassing ranking, and reports viaEntity', async () => {
    const repos = createRepositories(db.handle.db);
    const a = memory.save(
      { type: 'project', title: 'Fix', content: 'fixed the migration bug' },
      projectScope(projectId),
    );
    repos.entities.linkMemory(
      a.id,
      projectId,
      [{ kind: 'path', value: 'apps/server/src/db/migrate.ts' }],
      clock.now(),
    );

    const result = await memory.searchWithAbstention(
      { entity: 'apps/server/src/db/migrate.ts' },
      projectScope(projectId),
    );
    expect(result.memories.map((m) => m.id)).toEqual([a.id]);
    expect(result.viaEntity).toBe(true);
    expect(result.abstained).toBe(false);
  });

  it('finds a rare identifier invisible to a plain text query', async () => {
    const repos = createRepositories(db.handle.db);
    const a = memory.save(
      {
        type: 'project',
        title: 'X',
        content: 'completely unrelated prose with no shared vocabulary',
      },
      projectScope(projectId),
    );
    repos.entities.linkMemory(
      a.id,
      projectId,
      [{ kind: 'error_code', value: 'ENOENT' }],
      clock.now(),
    );

    // The content never mentions "ENOENT" literally, so a text query for
    // it finds nothing — the entity link is the only way to surface this.
    const byText = await memory.search({ query: 'ENOENT' }, projectScope(projectId));
    expect(byText.map((m) => m.id)).not.toContain(a.id);

    const byEntity = await memory.search({ entity: 'ENOENT' }, projectScope(projectId));
    expect(byEntity.map((m) => m.id)).toEqual([a.id]);
  });

  it('an unknown entity returns empty and does not degrade into a text query', async () => {
    memory.save(
      { type: 'project', title: 'X', content: 'never-linked-anywhere' },
      projectScope(projectId),
    );
    const result = await memory.search(
      { entity: 'never-linked-anywhere' },
      projectScope(projectId),
    );
    expect(result).toEqual([]);
  });

  it('distinguishes an unscanned index from an unknown entity', async () => {
    const repos = createRepositories(db.handle.db);
    const m = memory.save(
      { type: 'project', title: 'Fix', content: 'fixed apps/server/src/db/migrate.ts' },
      projectScope(projectId),
    );

    // The row exists but has never been scanned — exactly the state a recipe
    // bump leaves the whole corpus in. Empty alone would read as "unknown".
    const draining = await memory.searchWithAbstention(
      { entity: 'apps/server/src/db/migrate.ts' },
      projectScope(projectId),
    );
    expect(draining.memories).toEqual([]);
    expect(draining.entityIndexDraining).toBe(true);

    new EntityBackfillWorker({ repos, tx: db.handle.db }).processBatch({ force: true });

    const hit = await memory.searchWithAbstention(
      { entity: 'apps/server/src/db/migrate.ts' },
      projectScope(projectId),
    );
    expect(hit.memories.map((r) => r.id)).toEqual([m.id]);
    expect(hit.entityIndexDraining).toBeUndefined();

    // A genuine miss over a fully-drained scope says nothing about the index.
    const miss = await memory.searchWithAbstention(
      { entity: 'apps/server/src/db/never.ts' },
      projectScope(projectId),
    );
    expect(miss.memories).toEqual([]);
    expect(miss.entityIndexDraining).toBeUndefined();
  });

  it('the same path in two projects does not join them', async () => {
    const repos = createRepositories(db.handle.db);
    const otherId = projects.create({ slug: 'other-app' }).id;
    const a = memory.save(
      { type: 'project', title: 'A', content: 'in project A' },
      projectScope(projectId),
    );
    const b = memory.save(
      { type: 'project', title: 'B', content: 'in project B' },
      projectScope(otherId),
    );
    repos.entities.linkMemory(
      a.id,
      projectId,
      [{ kind: 'path', value: 'src/shared.ts' }],
      clock.now(),
    );
    repos.entities.linkMemory(
      b.id,
      otherId,
      [{ kind: 'path', value: 'src/shared.ts' }],
      clock.now(),
    );

    const result = await memory.search({ entity: 'src/shared.ts' }, projectScope(projectId));
    expect(result.map((m) => m.id)).toEqual([a.id]);
  });

  it('entity plus query narrows rather than fusing — only entity memories matching the query too', async () => {
    const repos = createRepositories(db.handle.db);
    const matching = memory.save(
      { type: 'project', title: 'A', content: 'discusses migration ordering concerns' },
      projectScope(projectId),
    );
    const nonMatching = memory.save(
      { type: 'project', title: 'B', content: 'discusses something else entirely' },
      projectScope(projectId),
    );
    for (const m of [matching, nonMatching]) {
      repos.entities.linkMemory(
        m.id,
        projectId,
        [{ kind: 'path', value: 'apps/server/src/db/migrate.ts' }],
        clock.now(),
      );
    }

    const result = await memory.search(
      { entity: 'apps/server/src/db/migrate.ts', query: 'ordering' },
      projectScope(projectId),
    );
    expect(result.map((m) => m.id)).toEqual([matching.id]);
  });

  it('entity plus query finds a matching memory older than the default page size (regression: narrowing must not window-drop)', async () => {
    const repos = createRepositories(db.handle.db);
    const old = memory.save(
      { type: 'project', title: 'Old', content: 'discusses migration ordering concerns' },
      projectScope(projectId),
    );
    repos.entities.linkMemory(
      old.id,
      projectId,
      [{ kind: 'path', value: 'apps/server/src/db/migrate.ts' }],
      clock.now(),
    );
    // 20 newer memories sharing the same entity but not the query text —
    // more than the default page size, so `old` sits outside a naive
    // offset+limit fetch window if the query filter is applied afterward
    // on too small a pool.
    for (let i = 0; i < 20; i++) {
      const m = memory.save(
        { type: 'project', title: `Newer ${i}`, content: `unrelated note ${i}` },
        projectScope(projectId),
      );
      repos.entities.linkMemory(
        m.id,
        projectId,
        [{ kind: 'path', value: 'apps/server/src/db/migrate.ts' }],
        clock.now(),
      );
    }

    const result = await memory.search(
      { entity: 'apps/server/src/db/migrate.ts', query: 'ordering' },
      projectScope(projectId),
    );
    expect(result.map((m) => m.id)).toEqual([old.id]);
  });

  it('combines with the status, type, tag and topic_key filters', async () => {
    const repos = createRepositories(db.handle.db);
    const pref = memory.save(
      { type: 'user', title: 'Pref', content: 'prefers tabs', tags: ['editor'] },
      projectScope(projectId),
    );
    const note = memory.save(
      { type: 'project', title: 'Note', content: 'a project note', topicKey: 'topic/note' },
      projectScope(projectId),
    );
    const retired = memory.save(
      { type: 'project', title: 'Retired', content: 'retired note' },
      projectScope(projectId),
    );
    memory.archive(retired.id, projectScope(projectId));
    for (const m of [pref, note, retired]) {
      repos.entities.linkMemory(
        m.id,
        projectId,
        [{ kind: 'path', value: 'src/mixed.ts' }],
        clock.now(),
      );
    }
    const scope = projectScope(projectId);

    expect(
      (await memory.search({ entity: 'src/mixed.ts', type: 'user' }, scope)).map((m) => m.id),
    ).toEqual([pref.id]);
    expect(
      (await memory.search({ entity: 'src/mixed.ts', tag: 'editor' }, scope)).map((m) => m.id),
    ).toEqual([pref.id]);
    expect(
      (await memory.search({ entity: 'src/mixed.ts', topicKey: 'topic/note' }, scope)).map(
        (m) => m.id,
      ),
    ).toEqual([note.id]);
    expect(
      (await memory.search({ entity: 'src/mixed.ts', status: 'archived' }, scope)).map((m) => m.id),
    ).toEqual([retired.id]);
    expect(
      (await memory.search({ entity: 'src/mixed.ts', status: 'active' }, scope))
        .map((m) => m.id)
        .sort(),
    ).toEqual([note.id, pref.id].sort());
  });

  it('defaults to any status but archived, not to active, and an explicit status still filters exactly', async () => {
    const repos = createRepositories(db.handle.db);
    const scope = projectScope(projectId);
    const old = memory.save(
      { type: 'project', title: 'Old take', content: 'the old take', topicKey: 'decision/take' },
      scope,
    );
    const fresh = memory.save(
      { type: 'project', title: 'New take', content: 'the new take', topicKey: 'decision/take' },
      scope,
    );
    const retired = memory.save(
      { type: 'project', title: 'Retired take', content: 'the retired take' },
      scope,
    );
    memory.archive(retired.id, scope);
    for (const m of [old, fresh, retired]) {
      repos.entities.linkMemory(
        m.id,
        projectId,
        [{ kind: 'path', value: 'src/takes.ts' }],
        clock.now(),
      );
    }

    expect(
      (await memory.search({ entity: 'src/takes.ts' }, scope)).map((m) => m.id).sort(),
    ).toEqual([fresh.id, old.id].sort());
    expect(
      (await memory.search({ entity: 'src/takes.ts', status: 'active' }, scope)).map((m) => m.id),
    ).toEqual([fresh.id]);
    expect(
      (await memory.search({ entity: 'src/takes.ts', status: 'superseded' }, scope)).map(
        (m) => m.id,
      ),
    ).toEqual([old.id]);
    expect(
      (await memory.search({ entity: 'src/takes.ts', status: 'archived' }, scope)).map((m) => m.id),
    ).toEqual([retired.id]);
  });

  it('returns every linked memory when no limit is given, past the ranked default page of 8', async () => {
    const repos = createRepositories(db.handle.db);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const m = memory.save(
        { type: 'project', title: `Note ${i}`, content: `note ${i}` },
        projectScope(projectId),
      );
      ids.push(m.id);
      repos.entities.linkMemory(
        m.id,
        projectId,
        [{ kind: 'error_code', value: 'ERR_TWELVE' }],
        clock.now(),
      );
    }

    const result = await memory.search({ entity: 'ERR_TWELVE' }, projectScope(projectId));
    expect(result.map((m) => m.id).sort()).toEqual([...ids].sort());
    // An explicit `limit` still bounds the page.
    const bounded = await memory.search(
      { entity: 'ERR_TWELVE', limit: 3 },
      projectScope(projectId),
    );
    expect(bounded).toHaveLength(3);
  });

  it('an entity shared with another scope returns only the read scope, on every branch', async () => {
    const repos = createRepositories(db.handle.db);
    const globalMem = memory.save(
      { type: 'user', title: 'Global', content: 'user-wide convention' },
      defaultProjectScope(db.handle),
    );
    const projectMem = memory.save(
      { type: 'project', title: 'Project', content: 'project convention' },
      projectScope(projectId),
    );
    repos.entities.linkMemory(
      globalMem.id,
      defaultProjectScope(db.handle).projectId,
      [{ kind: 'path', value: 'src/both.ts' }],
      clock.now(),
    );
    repos.entities.linkMemory(
      projectMem.id,
      projectId,
      [{ kind: 'path', value: 'src/both.ts' }],
      clock.now(),
    );

    expect(
      (await memory.search({ entity: 'src/both.ts' }, projectScope(projectId))).map((m) => m.id),
    ).toEqual([projectMem.id]);
    // The control: the excluded memory IS linked to the same entity and is
    // returned in its own scope, so the exclusion is the scope predicate.
    expect(
      (await memory.search({ entity: 'src/both.ts' }, defaultProjectScope(db.handle))).map(
        (m) => m.id,
      ),
    ).toEqual([globalMem.id]);
  });
});

describe('memory.search — topic_key history', () => {
  it('returns every memory ever saved under a key, and an explicit status still narrows', async () => {
    for (let i = 0; i < 4; i++) {
      memory.save(
        {
          type: 'project',
          title: `Runbook v${i}`,
          content: `deploy runbook revision ${i}`,
          topicKey: 'decision/deploy-runbook',
        },
        projectScope(projectId),
      );
    }

    const history = await memory.search(
      { topicKey: 'decision/deploy-runbook' },
      projectScope(projectId),
    );
    expect(history).toHaveLength(4);
    expect(history.filter((m) => m.status === 'active')).toHaveLength(1);
    expect(history.filter((m) => m.status === 'superseded')).toHaveLength(3);

    const activeOnly = await memory.search(
      { topicKey: 'decision/deploy-runbook', status: 'active' },
      projectScope(projectId),
    );
    expect(activeOnly).toHaveLength(1);
  });

  it('omits an archived row but keeps the superseded ones, on both the listing and the lexical branch', async () => {
    const scope = projectScope(projectId);
    const topicKey = 'decision/deploy-runbook';
    const retired = memory.save(
      { type: 'project', title: 'Runbook v0', content: 'deploy runbook revision zero', topicKey },
      scope,
    );
    memory.archive(retired.id, scope);
    const old = memory.save(
      { type: 'project', title: 'Runbook v1', content: 'deploy runbook revision one', topicKey },
      scope,
    );
    const fresh = memory.save(
      { type: 'project', title: 'Runbook v2', content: 'deploy runbook revision two', topicKey },
      scope,
    );

    const listing = await memory.search({ topicKey }, scope);
    expect(listing.map((m) => m.id).sort()).toEqual([fresh.id, old.id].sort());
    expect(listing.map((m) => m.status).sort()).toEqual(['active', 'superseded']);

    // Same default through the hybrid path, whose lexical branch is the one
    // that used to drop the status predicate entirely.
    const lexical = await memory.search({ topicKey, query: 'deploy runbook revision' }, scope);
    expect(lexical.map((m) => m.id).sort()).toEqual([fresh.id, old.id].sort());

    for (const query of [undefined, 'deploy runbook revision']) {
      expect(
        (await memory.search({ topicKey, query, status: 'archived' }, scope)).map((m) => m.id),
      ).toEqual([retired.id]);
      expect(
        (await memory.search({ topicKey, query, status: 'superseded' }, scope)).map((m) => m.id),
      ).toEqual([old.id]);
      expect(
        (await memory.search({ topicKey, query, status: 'active' }, scope)).map((m) => m.id),
      ).toEqual([fresh.id]);
    }
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
    const g = memory.save(
      { type: 'user', title: 'Global g', content: 'g' },
      defaultProjectScope(db.handle),
    );
    const result = memory.get(g.id, projectScope(projectId));
    expect(result).toBeNull();
  });

  it('returns null for a project id when scope is global', () => {
    const p = memory.save(
      { type: 'user', title: 'Project p', content: 'p' },
      projectScope(projectId),
    );
    const result = memory.get(p.id, defaultProjectScope(db.handle));
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
    expect(memory.get('does-not-exist', defaultProjectScope(db.handle))).toBeNull();
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
    expect(() => memory.confirm(m.id, defaultProjectScope(db.handle))).toThrow(/not found/);
  });

  it('throws not_found for unknown ids', () => {
    expect(() => memory.confirm('nope', defaultProjectScope(db.handle))).toThrow(/not found/);
  });
});

describe('memory.confirm — refutation (separate-access-from-usefulness)', () => {
  it('requires a non-empty reason', () => {
    const m = memory.save({ type: 'project', title: 'X', content: 'x' }, projectScope(projectId));
    expect(() => memory.confirm(m.id, projectScope(projectId), { verdict: 'refute' })).toThrow(
      /reason/,
    );
    expect(() =>
      memory.confirm(m.id, projectScope(projectId), { verdict: 'refute', reason: '   ' }),
    ).toThrow(/reason/);
  });

  it('rejects a reason containing a NUL byte', () => {
    const m = memory.save({ type: 'project', title: 'X', content: 'x' }, projectScope(projectId));
    expect(() =>
      memory.confirm(m.id, projectScope(projectId), { verdict: 'refute', reason: 'bad\0reason' }),
    ).toThrow(/invalid_input|NUL/i);
  });

  it('flips derived review state to needs_review immediately, without touching last_seen_at, content, title, or status', () => {
    const m = memory.save(
      { type: 'project', title: 'Runbook', content: 'do the thing' },
      projectScope(projectId),
    );
    const before = memory.unsafeGetById(m.id)!;
    clock.advance(1000); // refutation must postdate createdAt to flip the baseline
    memory.confirm(m.id, projectScope(projectId), {
      verdict: 'refute',
      reason: 'this step is now wrong',
    });
    const after = memory.unsafeGetById(m.id)!;

    expect(after.lastSeenAt?.getTime()).toBe(before.lastSeenAt?.getTime());
    expect(after.content).toBe(before.content);
    expect(after.title).toBe(before.title);
    expect(after.status).toBe(before.status);

    const result = memory.get(m.id, projectScope(projectId));
    expect(result?.reviewState).toBe('needs_review');
  });

  it('a later affirmation clears a refutation (advances the baseline past it)', () => {
    const m = memory.save(
      { type: 'project', title: 'Runbook', content: 'do the thing' },
      projectScope(projectId),
    );
    clock.advance(1000);
    memory.confirm(m.id, projectScope(projectId), { verdict: 'refute', reason: 'wrong' });
    expect(memory.get(m.id, projectScope(projectId))?.reviewState).toBe('needs_review');

    clock.advance(1000); // affirmation must postdate the refutation to clear it
    memory.confirm(m.id, projectScope(projectId));
    expect(memory.get(m.id, projectScope(projectId))?.reviewState).toBe('fresh');
  });

  it('does not count toward the affirmation confirmationCount', () => {
    const m = memory.save({ type: 'project', title: 'X', content: 'x' }, projectScope(projectId));
    memory.confirm(m.id, projectScope(projectId), { verdict: 'refute', reason: 'wrong' });
    memory.confirm(m.id, projectScope(projectId), { verdict: 'refute', reason: 'still wrong' });
    memory.confirm(m.id, projectScope(projectId));
    const result = memory.get(m.id, projectScope(projectId));
    expect(result?.confirmationCount).toBe(1);
  });

  it('forces needs_review even for a type with no TTL (reference)', () => {
    const m = memory.save(
      { type: 'reference', title: 'Doc link', content: 'https://example.com' },
      projectScope(projectId),
    );
    expect(memory.get(m.id, projectScope(projectId))?.reviewState).toBe('fresh');
    clock.advance(1000);
    memory.confirm(m.id, projectScope(projectId), { verdict: 'refute', reason: 'link is dead' });
    expect(memory.get(m.id, projectScope(projectId))?.reviewState).toBe('needs_review');
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
    expect(() => memory.archive(m.id, defaultProjectScope(db.handle))).toThrow(/not found/);
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

  it('purges a backlog larger than the 32 766 bind-variable ceiling', () => {
    const backlog = 40_000;
    const insert = db.handle.raw.prepare(
      `INSERT INTO memory (id, scope, project_id, type, title, content, tags, status, replaces, created_at, last_seen_at)
       VALUES (?, 'global', NULL, 'project', 't', 'c', '[]', 'archived', '[]', 1000, 1000)`,
    );
    db.handle.raw.transaction(() => {
      for (let i = 0; i < backlog; i++) insert.run(`backlog-${i}`);
    })();

    const result = memory.purgeDisconnectedArchived({ adminBypass: true });

    expect(result.deletedIds).toHaveLength(backlog);
    expect(memory.countPurgeableDisconnectedArchived()).toBe(0);
    const remaining = db.handle.raw.prepare(`SELECT count(*) AS n FROM memory`).get() as {
      n: number;
    };
    expect(remaining.n).toBe(0);
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
    expect(memory.needsReviewForContext(defaultProjectScope(db.handle), 5)).toHaveLength(0);
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

  describe('countNeedsReview (separate-access-from-usefulness)', () => {
    it('counts stale memories in scope, isolated from other scopes', () => {
      const otherId = projects.create({ slug: 'other-app' }).id;
      memory.save({ type: 'project', title: 'A goal', content: 'A goal' }, projectScope(projectId));
      memory.save({ type: 'project', title: 'B goal', content: 'B goal' }, projectScope(otherId));

      expect(memory.countNeedsReview(projectScope(projectId))).toBe(0);
      clock.advance(100 * DAY);
      expect(memory.countNeedsReview(projectScope(projectId))).toBe(1);
      expect(memory.countNeedsReview(projectScope(otherId))).toBe(1);
      expect(memory.countNeedsReview(defaultProjectScope(db.handle))).toBe(0);
    });

    it('stays consistent with needsReviewForContext for the same scope (task 5.3)', () => {
      memory.save(
        { type: 'project', title: 'Ship v1', content: 'ship v1' },
        projectScope(projectId),
      );
      memory.save(
        { type: 'project', title: 'Ship v2', content: 'ship v2' },
        projectScope(projectId),
      );
      clock.advance(100 * DAY);

      const total = memory.countNeedsReview(projectScope(projectId));
      const surfaced = memory.needsReviewForContext(projectScope(projectId), 10);
      expect(total).toBe(surfaced.length);
    });

    it('a refuted no-TTL reference memory counts too', () => {
      const m = memory.save(
        { type: 'reference', title: 'Doc link', content: 'https://example.com' },
        projectScope(projectId),
      );
      expect(memory.countNeedsReview(projectScope(projectId))).toBe(0);
      clock.advance(1000);
      memory.confirm(m.id, projectScope(projectId), { verdict: 'refute', reason: 'dead link' });
      expect(memory.countNeedsReview(projectScope(projectId))).toBe(1);
    });
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

// Prerequisite for the deferred `order-entity-fanout-by-link-pk` follow-up.
describe('ULID prefix equals created_at', () => {
  it('holds for every saved row, so id order is created_at order', () => {
    const rows = Array.from({ length: 25 }, (_, i) => {
      clock.advance(1000);
      return memory.save(
        { type: 'project', title: `t${i}`, content: `c${i}` },
        defaultProjectScope(db.handle),
      );
    });
    for (const r of rows) {
      expect(decodeTime(r.id)).toBe(r.createdAt.getTime());
    }
    const byId = [...rows].sort((a, b) => b.id.localeCompare(a.id)).map((r) => r.id);
    const byCreated = [...rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .map((r) => r.id);
    expect(byId).toEqual(byCreated);
  });

  it('holds for a backdated clock, which is how the dev seed writes history', () => {
    const past = new Date('2020-06-01T00:00:00.000Z');
    const backdated = new MemoryService(
      createRepositories(db.handle.db),
      db.handle.db,
      new TestClock(past).now,
    );
    const row = backdated.save(
      { type: 'project', title: 'old', content: 'old' },
      defaultProjectScope(db.handle),
    );
    expect(decodeTime(row.id)).toBe(past.getTime());
    expect(row.createdAt.getTime()).toBe(past.getTime());
  });
});
