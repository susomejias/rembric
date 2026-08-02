import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { memoryRelations } from '../db/schema/memory-relations.js';
import type { Project } from '../db/schema/projects.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { RelationsService } from '../services/relations.js';
import { SCOPE_GLOBAL, projectScope } from '../services/scope.js';
import type { TokenScope } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { buildMemoryHandlers } from './memory-tools.js';

/**
 * Strict path-scoping contract — see src/services/memory.ts and
 * src/services/scope.ts for the application-level RLS pattern this
 * encodes.
 */

let db: TestDb;
let projects: ProjectsService;
let memory: MemoryService;
let handlers: ReturnType<typeof buildMemoryHandlers>;
let projectA: Project;
let projectB: Project;

const ADMIN_TOKEN_SCOPE: TokenScope = '*';

function fakeContext(project: Project | null): RequestContext {
  const token: Token = {
    id: 'tk_test',
    name: 'test-token',
    hash: 'hash',
    scope: ADMIN_TOKEN_SCOPE,
    projectId: null,
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
  };
  return {
    token,
    scope: ADMIN_TOKEN_SCOPE,
    project,
    requestedSlug: project?.slug ?? null,
    mcpSessionId: null,
  };
}

interface McpTextResponse {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function parseText<T = unknown>(resp: unknown): T {
  const r = resp as McpTextResponse;
  const text = r.content[0]?.text ?? '';
  return JSON.parse(text) as T;
}

function isErrorResponse(resp: unknown): boolean {
  return (resp as McpTextResponse).isError === true;
}

beforeEach(() => {
  db = createTestDb();
  projects = new ProjectsService(createRepositories(db.handle.db));
  memory = new MemoryService(createRepositories(db.handle.db), db.handle.db);
  handlers = buildMemoryHandlers({ memory });
  projectA = projects.create({ slug: 'test-rembric' });
  projectB = projects.create({ slug: 'other-project' });
});

afterEach(() => {
  db.cleanup();
});

describe('memory.save — strict path scoping', () => {
  it("rejects scope='global' on a path-scoped connection with code 'scope_locked'", async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.save({
          scope: 'global',
          type: 'user',
          title: 'developer of full-stack',
          content: 'developer of full-stack',
        }),
      ),
    );
    expect(isErrorResponse(r)).toBe(true);
    const payload = parseText<{ code: string; message: string }>(r);
    expect(payload.code).toBe('scope_locked');
    expect(payload.message).toContain('test-rembric');
  });

  it("rejects scope='project' on an unscoped connection with code 'project_required'", async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(handlers.save({ scope: 'project', type: 'user', title: 'x', content: 'x' })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('project_required');
  });

  it('saves under the bound project regardless of the input scope', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.save({
          scope: 'project',
          type: 'user',
          title: 'prefers pnpm',
          content: 'prefers pnpm',
          tags: [],
        }),
      ),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.scope).toBe('project');
    expect(persisted?.projectId).toBe(projectA.id);
  });

  it("rejects a save into an archived project with code 'project_archived'", async () => {
    const guarded = buildMemoryHandlers({ memory, projects });
    projects.archive(projectA.id);
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        guarded.save({
          scope: 'project',
          type: 'user',
          title: 'should be rejected',
          content: 'write into an archived project',
        }),
      ),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('project_archived');
  });

  it('on unscoped connections still saves globals normally', async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(
        handlers.save({ scope: 'global', type: 'user', title: 'dark mode', content: 'dark mode' }),
      ),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.scope).toBe('global');
    expect(persisted?.projectId).toBeNull();
  });

  it('rejects an empty title with code invalid_input', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.save({ scope: 'project', type: 'user', title: '', content: 'has content' }),
      ),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('invalid_input');
  });
});

describe('memory.save — entity extraction and linking (add-entity-index)', () => {
  it('extracts and links entities from title+content on save, independent of candidate detection', async () => {
    const repos = createRepositories(db.handle.db);
    const entityHandlers = buildMemoryHandlers({ memory, repos });
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        entityHandlers.save({
          scope: 'project',
          type: 'project',
          title: 'Fix migration bug',
          content: 'fixed apps/server/src/db/migrate.ts, was throwing ENOENT',
        }),
      ),
    );
    const { id } = parseText<{ id: string }>(r);
    const linked = repos.entities.findEntitiesForMemory(id);
    expect(linked.map((e) => e.value).sort()).toEqual(['ENOENT', 'apps/server/src/db/migrate.ts']);
  });

  it('surfaces an entity-sourced candidate with its shared entityValue', async () => {
    const repos = createRepositories(db.handle.db);
    const relations = new RelationsService(repos, db.handle.db);
    const entityHandlers = buildMemoryHandlers({
      memory,
      repos,
      relations,
      candidates: { perSaveMax: 5 },
    });
    // Dilute the scope so a single existing link stays under the rarity gate.
    for (let i = 0; i < 10; i++) {
      await runWithContext(fakeContext(projectA), () =>
        Promise.resolve(
          entityHandlers.save({
            scope: 'project',
            type: 'project',
            title: `Filler ${i}`,
            content: `filler note ${i}`,
          }),
        ),
      );
    }
    const first = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        entityHandlers.save({
          scope: 'project',
          type: 'project',
          title: 'Use chown 10001',
          content: 'use chown 10001 for the data dir, see docs/docker.md',
        }),
      ),
    );
    const firstId = parseText<{ id: string }>(first).id;

    const second = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        entityHandlers.save({
          scope: 'project',
          type: 'project',
          title: 'Run as root',
          content: 'run as root instead, see docs/docker.md',
        }),
      ),
    );
    const payload = parseText<{
      candidates: { targetId: string; source: string; entityValue?: string }[];
    }>(second);
    const match = payload.candidates.find((c) => c.targetId === firstId && c.source === 'entity');
    expect(match?.entityValue).toBe('docs/docker.md');
  });
});

describe('memory.save — candidatesDetected', () => {
  interface SavePayload {
    id: string;
    candidates: { judgmentId: string; targetId: string }[];
    judgmentRequired: boolean;
    candidatesDetected: number;
  }

  function handlersWithCap(perSaveMax: number) {
    const repos = createRepositories(db.handle.db);
    return buildMemoryHandlers({
      memory,
      repos,
      relations: new RelationsService(repos, db.handle.db),
      candidates: { perSaveMax },
    });
  }

  function pendingRowsFor(sourceId: string): number {
    return db.handle.db
      .select()
      .from(memoryRelations)
      .where(and(eq(memoryRelations.sourceId, sourceId), eq(memoryRelations.status, 'pending')))
      .all().length;
  }

  function save(
    h: ReturnType<typeof buildMemoryHandlers>,
    title: string,
    content: string,
    extra: { topic_key?: string } = {},
    project: Project | null = projectA,
  ) {
    return runWithContext(fakeContext(project), () =>
      Promise.resolve(h.save({ scope: 'project', type: 'project', title, content, ...extra })),
    );
  }

  const RULE = 'use two-space indentation always in every file';

  it('a truncated save returns perSaveMax candidates and the larger detected count', async () => {
    const h = handlersWithCap(5);
    for (let i = 0; i < 12; i++) await save(h, `Rule ${i}`, `${RULE}, revision ${i}`);
    const r = parseText<SavePayload>(await save(h, 'Rule final', `${RULE}, revision final`));

    expect(r.candidates).toHaveLength(5);
    expect(r.candidatesDetected).toBeGreaterThan(5);
    expect(r.judgmentRequired).toBe(true);
    // The queue grows by the surfaced length, never by the detected count.
    expect(pendingRowsFor(r.id)).toBe(r.candidates.length);
  });

  it('a save with no candidates reports zero, and a cap of zero also reports zero', async () => {
    const h = handlersWithCap(5);
    const lonely = parseText<SavePayload>(
      await save(h, 'Wholly unrelated', 'an utterly singular observation about nothing'),
    );
    expect(lonely.candidates).toEqual([]);
    expect(lonely.candidatesDetected).toBe(0);
    expect(lonely.judgmentRequired).toBe(false);

    const off = handlersWithCap(0);
    for (let i = 0; i < 6; i++) await save(off, `Rule ${i}`, `${RULE}, revision ${i}`);
    const disabled = parseText<SavePayload>(await save(off, 'Rule x', `${RULE}, revision x`));
    expect(disabled.candidates).toEqual([]);
    expect(disabled.candidatesDetected).toBe(0);
  });

  it("a topic_key save's superseded predecessor is neither surfaced nor counted", async () => {
    const h = handlersWithCap(5);
    const first = parseText<SavePayload>(
      await save(h, 'Auth model', 'auth via JWT with rotating refresh tokens', {
        topic_key: 'decision/auth',
      }),
    );
    const second = parseText<SavePayload>(
      await save(h, 'Auth model', 'auth via JWT with rotating refresh tokens, revised', {
        topic_key: 'decision/auth',
      }),
    );
    expect(second.candidates.map((c) => c.targetId)).not.toContain(first.id);
    expect(second.candidatesDetected).toBe(0);
  });

  it('no response field reports truncation as a boolean', async () => {
    const h = handlersWithCap(2);
    for (let i = 0; i < 8; i++) await save(h, `Rule ${i}`, `${RULE}, revision ${i}`);
    const raw = parseText<Record<string, unknown>>(
      await save(h, 'Rule final', `${RULE}, revision final`),
    );
    expect(raw.candidatesDetected).toBeGreaterThan(2);
    const booleans = Object.entries(raw).filter(([, v]) => typeof v === 'boolean');
    expect(booleans.map(([k]) => k)).toEqual(['judgmentRequired']);
    expect(raw).not.toHaveProperty('candidatesTruncated');
  });

  it('counts only in-scope pairs', async () => {
    const h = handlersWithCap(5);
    for (let i = 0; i < 12; i++) await save(h, `Rule ${i}`, `${RULE}, revision ${i}`, {}, projectB);

    // The same save in the project holding the lookalikes DOES count them, so
    // the zero below is scope isolation rather than detection failing to run.
    const inB = parseText<SavePayload>(
      await save(h, 'Rule final', `${RULE}, revision final`, {}, projectB),
    );
    expect(inB.candidatesDetected).toBeGreaterThan(5);

    const inA = parseText<SavePayload>(await save(h, 'Rule final', `${RULE}, revision final`));
    expect(inA.candidates).toEqual([]);
    expect(inA.candidatesDetected).toBe(0);
  });
});

describe('memory.get / memory.search — entitiesTotal', () => {
  const CAP = 10;

  interface EntityView {
    entities: { kind: string; value: string }[];
    entitiesTotal: number;
  }

  function linkPaths(repos: ReturnType<typeof createRepositories>, id: string, n: number): void {
    repos.entities.linkMemory(
      id,
      'project',
      projectA.id,
      Array.from({ length: n }, (_, i) => ({ kind: 'path' as const, value: `src/f${i}.ts` })),
      new Date(),
    );
  }

  async function readAllThreeSurfaces(id: string) {
    const repos = createRepositories(db.handle.db);
    const h = buildMemoryHandlers({ memory, repos });
    return runWithContext(fakeContext(projectA), async () => ({
      single: parseText<EntityView>(await h.get({ id })),
      batch: parseText<{ memories: EntityView[] }>(await h.get({ ids: [id] })).memories[0]!,
      search: parseText<{ memories: EntityView[] }>(await h.search({})).memories.find(
        (r) => (r as unknown as { id: string }).id === id,
      )!,
    }));
  }

  it('reports the true count on all three surfaces when the bound binds', async () => {
    const repos = createRepositories(db.handle.db);
    const m = memory.save(
      { type: 'project', title: 'Wide change', content: 'touches many files' },
      projectScope(projectA.id),
    );
    linkPaths(repos, m.id, 27);

    const seen = await readAllThreeSurfaces(m.id);
    for (const [surface, row] of Object.entries(seen)) {
      expect(row.entities, surface).toHaveLength(CAP);
      expect(row.entitiesTotal, surface).toBe(27);
    }
  });

  function linkMixed(repos: ReturnType<typeof createRepositories>, id: string): void {
    // The measured worst case: paths dominate, three kinds have exactly one link.
    // Under (kind, value) the surviving 10 are env_var + 9 paths; ticket and url
    // — the two that address exactly one thing each — are evicted.
    repos.entities.linkMemory(
      id,
      'project',
      projectA.id,
      [
        ...Array.from({ length: 21 }, (_, i) => ({ kind: 'path' as const, value: `src/f${i}.ts` })),
        { kind: 'env_var' as const, value: 'HOME' },
        { kind: 'ticket' as const, value: '#56' },
        { kind: 'url' as const, value: 'https://opencode.ai' },
      ],
      new Date(),
    );
  }

  it('the bound is fair-shared across kinds, so no kind is evicted whole', async () => {
    const repos = createRepositories(db.handle.db);
    const m = memory.save(
      { type: 'project', title: 'Wide change', content: 'touches many files' },
      projectScope(projectA.id),
    );
    linkMixed(repos, m.id);

    const seen = await readAllThreeSurfaces(m.id);
    for (const [surface, row] of Object.entries(seen)) {
      expect(row.entities, surface).toHaveLength(CAP);
      expect(row.entitiesTotal, surface).toBe(24);
      // Every kind present survives — this is what (kind, value) got wrong.
      expect(new Set(row.entities.map((e) => e.kind)), surface).toEqual(
        new Set(['env_var', 'path', 'ticket', 'url']),
      );
      expect(
        row.entities.slice(0, 4).map((e) => e.kind),
        surface,
      ).toEqual(['env_var', 'path', 'ticket', 'url']);
      // The exact values, not just the kinds. Within a kind the projection
      // preserves its input order, which is the repository's `ORDER BY (kind,
      // value)` — so `src/f1.ts` is followed by `src/f10.ts`, not `src/f2.ts`.
      // Asserting only the kinds leaves that ORDER BY unprotected: removing it
      // failed nothing until this line existed.
      expect(
        row.entities.map((e) => e.value),
        surface,
      ).toEqual([
        'HOME',
        'src/f0.ts',
        '#56',
        'https://opencode.ai',
        'src/f1.ts',
        'src/f10.ts',
        'src/f11.ts',
        'src/f12.ts',
        'src/f13.ts',
        'src/f14.ts',
      ]);
    }
  });

  it('all three surfaces return the identical list, element for element', async () => {
    const repos = createRepositories(db.handle.db);
    const m = memory.save(
      { type: 'project', title: 'Wide change', content: 'touches many files' },
      projectScope(projectA.id),
    );
    linkMixed(repos, m.id);

    const seen = await readAllThreeSurfaces(m.id);
    // Non-empty floor first: an equality between two empty lists proves nothing.
    expect(seen.single.entities).toHaveLength(CAP);
    expect(seen.single.entitiesTotal).toBe(24);
    expect(seen.batch.entities).toEqual(seen.single.entities);
    expect(seen.search.entities).toEqual(seen.single.entities);
  });

  it('two reads with no intervening write return the identical array', async () => {
    const repos = createRepositories(db.handle.db);
    const m = memory.save(
      { type: 'project', title: 'Wide change', content: 'touches many files' },
      projectScope(projectA.id),
    );
    linkMixed(repos, m.id);

    const first = await readAllThreeSurfaces(m.id);
    const second = await readAllThreeSurfaces(m.id);
    expect(first.single.entities).toHaveLength(CAP);
    expect(second.single.entities).toEqual(first.single.entities);
    expect(second.batch.entities).toEqual(first.batch.entities);
    expect(second.search.entities).toEqual(first.search.entities);
  });

  it("fields: ['entities'] matches an unprojected read — order, bound and total", async () => {
    const repos = createRepositories(db.handle.db);
    const m = memory.save(
      { type: 'project', title: 'Wide change', content: 'touches many files' },
      projectScope(projectA.id),
    );
    linkMixed(repos, m.id);
    const h = buildMemoryHandlers({ memory, repos });

    const projected = await runWithContext(fakeContext(projectA), async () =>
      parseText<{ memories: EntityView[] }>(await h.search({ fields: ['entities'] })),
    );
    const row = projected.memories.find((r) => (r as unknown as { id: string }).id === m.id)!;
    const full = await readAllThreeSurfaces(m.id);
    expect(row.entities).toHaveLength(CAP);
    expect(row.entitiesTotal).toBe(24);
    expect(row.entities).toEqual(full.single.entities);
    expect(row.entitiesTotal).toBe(full.single.entitiesTotal);
  });

  it('an untruncated list still carries the count, and an empty one reports zero', async () => {
    const repos = createRepositories(db.handle.db);
    const few = memory.save(
      { type: 'project', title: 'Narrow change', content: 'touches three files' },
      projectScope(projectA.id),
    );
    linkPaths(repos, few.id, 3);
    const none = memory.save(
      { type: 'project', title: 'No identifiers', content: 'a purely prose observation' },
      projectScope(projectA.id),
    );

    const withFew = await readAllThreeSurfaces(few.id);
    for (const [surface, row] of Object.entries(withFew)) {
      expect(row.entitiesTotal, surface).toBe(3);
      expect(row.entitiesTotal, surface).toBe(row.entities.length);
    }
    const withNone = await readAllThreeSurfaces(none.id);
    for (const [surface, row] of Object.entries(withNone)) {
      expect(row.entities, surface).toEqual([]);
      expect(row.entitiesTotal, surface).toBe(0);
    }
  });

  it('no surface reports entity truncation as a boolean', async () => {
    const repos = createRepositories(db.handle.db);
    const m = memory.save(
      { type: 'project', title: 'Wide change', content: 'touches many files' },
      projectScope(projectA.id),
    );
    linkPaths(repos, m.id, 27);
    const h = buildMemoryHandlers({ memory, repos });
    const raw = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(h.get({ id: m.id })),
    );
    const payload = parseText<Record<string, unknown>>(raw);
    expect(payload).not.toHaveProperty('entitiesTruncated');
    // `truncated`/`headTruncated` describe the predecessor chain and stay; what
    // must not exist is a boolean about the ENTITY projection.
    const entityBooleans = Object.entries(payload).filter(
      ([k, v]) => /entit/i.test(k) && typeof v === 'boolean',
    );
    expect(entityBooleans).toEqual([]);
  });

  it('counts only entities in the memory own scope', async () => {
    const repos = createRepositories(db.handle.db);
    const mine = memory.save(
      { type: 'project', title: 'Mine', content: 'touches shared paths' },
      projectScope(projectA.id),
    );
    const theirs = memory.save(
      { type: 'project', title: 'Theirs', content: 'touches shared paths' },
      projectScope(projectB.id),
    );
    linkPaths(repos, mine.id, 4);
    // Same values, other project: a leak would show up as a larger count.
    repos.entities.linkMemory(
      theirs.id,
      'project',
      projectB.id,
      Array.from({ length: 20 }, (_, i) => ({ kind: 'path' as const, value: `src/f${i}.ts` })),
      new Date(),
    );

    const seen = await readAllThreeSurfaces(mine.id);
    for (const [surface, row] of Object.entries(seen)) {
      expect(row.entitiesTotal, surface).toBe(4);
    }
  });
});

describe('memory.title — read payloads expose the saved title', () => {
  it('memory.search returns rows whose title equals what was saved', async () => {
    memory.save(
      { type: 'user', title: 'pnpm is the package manager', content: 'we use pnpm here' },
      projectScope(projectA.id),
    );
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.search({})),
    );
    const { memories } = parseText<{ memories: { title: string; content: string }[] }>(r);
    const row = memories.find((m) => m.content === 'we use pnpm here');
    expect(row?.title).toBe('pnpm is the package manager');
  });

  it('memory.get returns memory.title and head.title for a saved memory', async () => {
    const saved = memory.save(
      { type: 'user', title: 'prefers dark mode', content: 'always dark theme' },
      projectScope(projectA.id),
    );
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.get({ id: saved.id })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const payload = parseText<{ memory: { title: string }; head: { title: string } }>(r);
    expect(payload.memory.title).toBe('prefers dark mode');
    expect(payload.head.title).toBe('prefers dark mode');
  });
});

describe('memory.search — strict path scoping', () => {
  beforeEach(() => {
    memory.save(
      { type: 'user', title: 'global preference one', content: 'global preference one' },
      SCOPE_GLOBAL,
    );
    memory.save(
      { type: 'user', title: 'project-A specific', content: 'project-A specific' },
      projectScope(projectA.id),
    );
    memory.save(
      { type: 'user', title: 'project-B specific', content: 'project-B specific' },
      projectScope(projectB.id),
    );
  });

  it('path-scoped: returns only memories in the bound project — no globals leak', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.search({})),
    );
    const { memories } = parseText<{ memories: { scope: string; projectId: string | null }[] }>(r);
    expect(memories.every((m) => m.scope === 'project' && m.projectId === projectA.id)).toBe(true);
    expect(memories.some((m) => m.scope === 'global')).toBe(false);
  });

  it('path-scoped: never returns memories of a sibling project', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.search({})),
    );
    const { memories } = parseText<{ memories: { projectId: string | null }[] }>(r);
    expect(memories.every((m) => m.projectId === projectA.id)).toBe(true);
  });

  it('unscoped: returns globals only', async () => {
    const r = await runWithContext(fakeContext(null), () => Promise.resolve(handlers.search({})));
    const { memories } = parseText<{ memories: { scope: string }[] }>(r);
    expect(memories.length).toBeGreaterThan(0);
    expect(memories.every((m) => m.scope === 'global')).toBe(true);
  });
});

describe('memory.search — entity filter (add-entity-index)', () => {
  it('exact-address retrieval finds a memory a text query cannot, and reports viaEntity', async () => {
    const repos = createRepositories(db.handle.db);
    const entityHandlers = buildMemoryHandlers({ memory, repos });
    const saved = memory.save(
      { type: 'project', title: 'X', content: 'entirely unrelated wording, no shared terms' },
      projectScope(projectA.id),
    );
    repos.entities.linkMemory(
      saved.id,
      'project',
      projectA.id,
      [{ kind: 'error_code', value: 'ENOENT' }],
      new Date(),
    );

    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(entityHandlers.search({ entity: 'ENOENT' })),
    );
    const payload = parseText<{
      memories: { id: string; entities?: { kind: string; value: string }[] }[];
      viaEntity?: boolean;
    }>(r);
    expect(payload.memories.map((m) => m.id)).toEqual([saved.id]);
    expect(payload.viaEntity).toBe(true);
    expect(payload.memories[0]!.entities).toEqual([{ kind: 'error_code', value: 'ENOENT' }]);
  });

  it('an unknown entity returns empty, not a degraded text search', async () => {
    const repos = createRepositories(db.handle.db);
    const entityHandlers = buildMemoryHandlers({ memory, repos });
    memory.save(
      { type: 'project', title: 'X', content: 'never linked' },
      projectScope(projectA.id),
    );

    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(entityHandlers.search({ entity: 'never-linked-anywhere' })),
    );
    const payload = parseText<{ memories: unknown[] }>(r);
    expect(payload.memories).toEqual([]);
  });

  it('without repos wired, search still works and entities[] is simply empty', async () => {
    const saved = memory.save(
      { type: 'project', title: 'Y', content: 'no repos wired for this handler' },
      projectScope(projectA.id),
    );
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.search({})),
    );
    const payload = parseText<{ memories: { id: string; entities?: unknown[] }[] }>(r);
    const row = payload.memories.find((m) => m.id === saved.id);
    expect(row?.entities).toEqual([]);
  });
});

describe('memory.get / memory.confirm — strict path scoping', () => {
  let globalId: string;
  let projectAId: string;
  let projectBId: string;

  beforeEach(() => {
    globalId = memory.save({ type: 'user', title: 'global', content: 'global' }, SCOPE_GLOBAL).id;
    projectAId = memory.save(
      { type: 'user', title: 'A', content: 'A' },
      projectScope(projectA.id),
    ).id;
    projectBId = memory.save(
      { type: 'user', title: 'B', content: 'B' },
      projectScope(projectB.id),
    ).id;
  });

  it('path-scoped: get(global id) → not_found', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.get({ id: globalId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
  });

  it('path-scoped: get(other-project id) → not_found', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.get({ id: projectBId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
  });

  it('path-scoped: get(own-project id) → ok', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.get({ id: projectAId })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const payload = parseText<{ memory: { id: string } }>(r);
    expect(payload.memory.id).toBe(projectAId);
  });

  it('unscoped /mcp: get(project id) → not_found  (the previously-leaky path is now closed)', async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(handlers.get({ id: projectAId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
  });

  it('unscoped /mcp: get(global id) → ok', async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(handlers.get({ id: globalId })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
  });

  it('path-scoped: confirm(global id) → not_found', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.confirm({ id: globalId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
  });

  it('path-scoped: confirm(other-project id) → not_found', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.confirm({ id: projectBId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
  });

  it('unscoped /mcp: confirm(project id) → not_found  (was leaky, now closed)', async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(handlers.confirm({ id: projectAId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
  });

  it('path-scoped: confirm(own-project id) → ok', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.confirm({ id: projectAId })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
  });
});

describe('memory.archive — strict path scoping', () => {
  let projectAId: string;
  let projectBId: string;

  beforeEach(() => {
    projectAId = memory.save(
      { type: 'user', title: 'A', content: 'A' },
      projectScope(projectA.id),
    ).id;
    projectBId = memory.save(
      { type: 'user', title: 'B', content: 'B' },
      projectScope(projectB.id),
    ).id;
  });

  it('path-scoped: archive(own-project active id) → ok, flips to archived', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.archive({ id: projectAId })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const payload = parseText<{ ok: boolean; id: string; status: string }>(r);
    expect(payload).toMatchObject({ ok: true, id: projectAId, status: 'archived' });
    expect(memory.unsafeGetById(projectAId)!.status).toBe('archived');
  });

  it('path-scoped: archive(other-project id) → not_found', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.archive({ id: projectBId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
    expect(memory.unsafeGetById(projectBId)!.status).toBe('active');
  });

  it('unscoped /mcp: archive(project id) → not_found (no cross-scope archive)', async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(handlers.archive({ id: projectAId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
    expect(memory.unsafeGetById(projectAId)!.status).toBe('active');
  });

  it('archiving an already-archived memory → conflict', async () => {
    await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.archive({ id: projectAId })),
    );
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.archive({ id: projectAId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('conflict');
  });
});

describe('memory.confirm — batch (ids)', () => {
  it('confirms each id once; duplicates collapse to one; reports the count', async () => {
    const m1 = memory.save({ type: 'user', title: 'c1', content: 'c1' }, projectScope(projectA.id));
    const m2 = memory.save({ type: 'user', title: 'c2', content: 'c2' }, projectScope(projectA.id));
    const m3 = memory.save({ type: 'user', title: 'c3', content: 'c3' }, projectScope(projectA.id));

    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.confirm({ ids: [m1.id, m2.id, m3.id, m2.id] })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    expect(parseText<{ confirmed: number }>(r).confirmed).toBe(3);

    const scope = projectScope(projectA.id);
    expect(memory.get(m1.id, scope)?.confirmationCount).toBe(1);
    expect(memory.get(m2.id, scope)?.confirmationCount).toBe(1); // duplicate recorded once
    expect(memory.get(m3.id, scope)?.confirmationCount).toBe(1);
  });

  it('single-id confirm still returns { ok: true }', async () => {
    const m = memory.save({ type: 'user', title: 's', content: 's' }, projectScope(projectA.id));
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.confirm({ id: m.id })),
    );
    expect(parseText<{ ok: boolean }>(r).ok).toBe(true);
    expect(memory.get(m.id, projectScope(projectA.id))?.confirmationCount).toBe(1);
  });
});

describe('memory.confirm — verdict=refute (separate-access-from-usefulness)', () => {
  it('rejects a refute with no reason', async () => {
    const m = memory.save({ type: 'user', title: 'r', content: 'r' }, projectScope(projectA.id));
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.confirm({ id: m.id, verdict: 'refute' })),
    );
    expect(isErrorResponse(r)).toBe(true);
  });

  it('records a refutation with a reason and does not bump confirmationCount', async () => {
    const m = memory.save({ type: 'user', title: 'r', content: 'r' }, projectScope(projectA.id));
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.confirm({ id: m.id, verdict: 'refute', reason: 'no longer accurate' }),
      ),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    expect(memory.get(m.id, projectScope(projectA.id))?.confirmationCount).toBe(0);
  });

  it('batch ids also accept verdict=refute with a shared reason', async () => {
    const m1 = memory.save({ type: 'user', title: 'r1', content: 'r1' }, projectScope(projectA.id));
    const m2 = memory.save({ type: 'user', title: 'r2', content: 'r2' }, projectScope(projectA.id));
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.confirm({ ids: [m1.id, m2.id], verdict: 'refute', reason: 'batch stale' }),
      ),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    expect(parseText<{ confirmed: number }>(r).confirmed).toBe(2);
  });
});

describe('memory.search — projection (snippet / fields)', () => {
  beforeEach(() => {
    memory.save(
      { type: 'user', title: 'projection target', content: 'X'.repeat(500) },
      projectScope(projectA.id),
    );
  });

  it('default request returns full content and the full row shape', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.search({})),
    );
    const { memories } = parseText<{
      memories: { content: string; scope?: string; tags?: string[] }[];
    }>(r);
    expect(memories[0]?.content.length).toBe(500);
    expect(memories[0]?.scope).toBe('project');
    expect(Array.isArray(memories[0]?.tags)).toBe(true);
  });

  it('snippet truncates content to N chars (same helper as memory.context)', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.search({ snippet: 50 })),
    );
    const { memories } = parseText<{ memories: { content: string }[] }>(r);
    expect(memories[0]?.content.length).toBe(50);
    expect(memories[0]?.content.endsWith('…')).toBe(true);
  });

  it('fields restricts the row but always keeps identity fields, and does not change rows', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.search({ fields: ['status'] })),
    );
    const { count, memories } = parseText<{ count: number; memories: Record<string, unknown>[] }>(
      r,
    );
    expect(count).toBe(1);
    const row: Record<string, unknown> = memories[0] ?? {};
    expect(Object.keys(row).sort()).toEqual(['id', 'status', 'title', 'type']);
    expect(row.content).toBeUndefined();
  });
});

describe('memory.search — relation expansion (include_relations)', () => {
  it('caps expansion at 5 entries even when more conflicts_with counterparts exist', async () => {
    const relations = new RelationsService(createRepositories(db.handle.db), db.handle.db);
    const expandedHandlers = buildMemoryHandlers({ memory, relations });

    // No token shared between source and targets, or FTS would pull the targets into the primary results.
    const source = memory.save(
      { type: 'user', title: 'zzsourcemarker', content: 'zzsourcemarker' },
      projectScope(projectA.id),
    );
    const targetIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const target = memory.save(
        { type: 'user', title: `unrelated filler row ${i}`, content: `unrelated filler row ${i}` },
        projectScope(projectA.id),
      );
      targetIds.push(target.id);
      relations.compare({
        sourceId: source.id,
        targetId: target.id,
        relation: 'conflicts_with',
        actor: 'test',
        kind: 'agent',
        confidence: 0.9,
        reason: 'cap test',
      });
    }

    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        expandedHandlers.search({ query: 'zzsourcemarker', include_relations: true }),
      ),
    );
    const { expanded } = parseText<{
      expanded?: { id: string; expandedFrom: string; relationKind: string }[];
    }>(r);
    expect(expanded).toHaveLength(5);
    expect(expanded?.every((e) => e.relationKind === 'conflicts_with')).toBe(true);
    expect(expanded?.every((e) => targetIds.includes(e.id))).toBe(true);
  });
});

describe('memory.search / memory.get — relation annotations', () => {
  const MARKER = 'zzfloodmarker';
  let relHandlers: ReturnType<typeof buildMemoryHandlers>;
  let relations: RelationsService;
  let floodedId: string;
  let conflictTargetId: string;
  let calmId: string;

  interface Row {
    id: string;
    relations: { kind: string; targetId: string }[];
    relationsTotal: number;
  }

  /** `count` judged `related` rows written BEFORE a judged `conflicts_with`, so arrival order buries it. */
  function flood(sourceId: string, count: number): string {
    for (let i = 0; i < count; i++) {
      relations.compare({
        sourceId,
        targetId: memory.save(
          { type: 'user', title: `filler neighbour ${i}`, content: `filler neighbour ${i}` },
          projectScope(projectA.id),
        ).id,
        relation: 'related',
        confidence: 0.5,
        actor: 'test',
      });
    }
    const target = memory.save(
      { type: 'user', title: 'the contradiction', content: 'the contradiction' },
      projectScope(projectA.id),
    );
    relations.compare({
      sourceId,
      targetId: target.id,
      relation: 'conflicts_with',
      confidence: 0.9,
      actor: 'test',
    });
    return target.id;
  }

  beforeEach(() => {
    relations = new RelationsService(createRepositories(db.handle.db), db.handle.db);
    relHandlers = buildMemoryHandlers({ memory, relations });
    floodedId = memory.save(
      { type: 'user', title: MARKER, content: MARKER },
      projectScope(projectA.id),
    ).id;
    conflictTargetId = flood(floodedId, 12);
    calmId = memory.save(
      { type: 'user', title: `${MARKER} calm`, content: `${MARKER} calm` },
      projectScope(projectA.id),
    ).id;
    flood(calmId, 2);
  });

  async function search(args: Record<string, unknown> = {}) {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(relHandlers.search({ query: MARKER, ...args })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    return parseText<{ memories: Row[] }>(r).memories;
  }

  it('a search row surfaces the contradiction and reports the true total', async () => {
    const rows = await search();
    const flooded = rows.find((m) => m.id === floodedId);
    expect(flooded?.relations).toHaveLength(10);
    expect(flooded?.relations[0]).toMatchObject({
      kind: 'conflicts_with',
      targetId: conflictTargetId,
    });
    expect(flooded?.relationsTotal).toBe(13);

    const calm = rows.find((m) => m.id === calmId);
    expect(calm?.relations).toHaveLength(3);
    expect(calm?.relationsTotal).toBe(3);
  });

  it('the batch `memory.get` form agrees with search', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(relHandlers.get({ ids: [floodedId, calmId] })),
    );
    const { memories } = parseText<{ memories: Row[] }>(r);
    expect(memories[0]?.relations).toHaveLength(10);
    expect(memories[0]?.relations[0]?.kind).toBe('conflicts_with');
    expect(memories[0]?.relationsTotal).toBe(13);
    expect(memories[1]?.relations).toHaveLength(3);
    expect(memories[1]?.relationsTotal).toBe(3);

    const searched = (await search()).find((m) => m.id === floodedId);
    expect(memories[0]?.relations).toEqual(searched?.relations);
  });

  it('the single-id `memory.get` form reports the same total at its own default of 50', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(relHandlers.get({ id: floodedId })),
    );
    const payload = parseText<{ relations: { kind: string }[]; relationsTotal: number }>(r);
    expect(payload.relations).toHaveLength(13);
    expect(payload.relations[0]?.kind).toBe('conflicts_with');
    expect(payload.relationsTotal).toBe(13);
  });

  it('relations_limit raises the bound without reordering, and keeps the total', async () => {
    const flooded = (await search({ relations_limit: 25 })).find((m) => m.id === floodedId);
    expect(flooded?.relations).toHaveLength(13);
    expect(flooded?.relations[0]?.kind).toBe('conflicts_with');
    expect(flooded?.relationsTotal).toBe(13);

    const atDefault = (await search()).find((m) => m.id === floodedId);
    expect(flooded?.relations.slice(0, 10)).toEqual(atDefault?.relations);
  });

  it('relations_limit does not change which memories a search returns', async () => {
    const atDefault = await search();
    const raised = await search({ relations_limit: 25 });
    expect(raised.map((m) => m.id)).toEqual(atDefault.map((m) => m.id));
  });

  describe('on a memory with more annotations than any default', () => {
    beforeEach(() => {
      flood(floodedId, 46); // 12 + 46 related + 2 conflicts_with = 60
    });

    it('the per-surface defaults are 10 for search, 10 for the batch and 50 for the single id', async () => {
      const flooded = (await search()).find((m) => m.id === floodedId);
      expect(flooded?.relations).toHaveLength(10);
      expect(flooded?.relationsTotal).toBe(60);

      const batch = await runWithContext(fakeContext(projectA), () =>
        Promise.resolve(relHandlers.get({ ids: [floodedId] })),
      );
      const batchRow = parseText<{ memories: Row[] }>(batch).memories[0];
      expect(batchRow?.relations).toHaveLength(10);
      expect(batchRow?.relationsTotal).toBe(60);

      const single = await runWithContext(fakeContext(projectA), () =>
        Promise.resolve(relHandlers.get({ id: floodedId })),
      );
      const singleRow = parseText<{ relations: unknown[]; relationsTotal: number }>(single);
      expect(singleRow.relations).toHaveLength(50);
      expect(singleRow.relationsTotal).toBe(60);
    });

    it('relations_limit: 25 returns exactly 25 of the 60, contradictions first', async () => {
      const flooded = (await search({ relations_limit: 25 })).find((m) => m.id === floodedId);
      expect(flooded?.relations).toHaveLength(25);
      expect(flooded?.relationsTotal).toBe(60);
      expect(flooded?.relations.filter((rel) => rel.kind === 'conflicts_with')).toHaveLength(2);
      expect(flooded?.relations.slice(0, 2).every((rel) => rel.kind === 'conflicts_with')).toBe(
        true,
      );
    });
  });
});

describe('memory.get — batch (ids)', () => {
  let aId1: string;
  let aId2: string;
  let bId: string;
  beforeEach(() => {
    aId1 = memory.save({ type: 'user', title: 'a1', content: 'a1' }, projectScope(projectA.id)).id;
    aId2 = memory.save({ type: 'user', title: 'a2', content: 'a2' }, projectScope(projectA.id)).id;
    bId = memory.save({ type: 'user', title: 'b', content: 'b' }, projectScope(projectB.id)).id;
  });

  it('returns an ordered in-scope batch; unknown and cross-scope ids go to notFound (no leak)', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.get({ ids: [aId2, 'nope', bId, aId1] })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const { memories, notFound } = parseText<{
      memories: { id: string }[];
      notFound: string[];
    }>(r);
    expect(memories.map((m) => m.id)).toEqual([aId2, aId1]);
    expect(notFound).toEqual(['nope', bId]);
  });

  it('legacy single-id request is unchanged', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.get({ id: aId1 })),
    );
    const payload = parseText<{ memory: { id: string }; head: { id: string } }>(r);
    expect(payload.memory.id).toBe(aId1);
    expect(payload.head.id).toBe(aId1);
  });

  it('supplying both id and ids is invalid_input', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.get({ id: aId1, ids: [aId2] })),
    );
    expect(parseText<{ code: string }>(r).code).toBe('invalid_input');
  });

  it('supplying neither id nor ids is invalid_input', async () => {
    const r = await runWithContext(fakeContext(projectA), () => Promise.resolve(handlers.get({})));
    expect(parseText<{ code: string }>(r).code).toBe('invalid_input');
  });
});

describe('memory.* — router-activated project on an unscoped /mcp connection', () => {
  // Reproduces the bug where calling `project.use({slug})` on a path-less
  // /mcp connection correctly updates the SessionRouter and is reported by
  // `project.current`, yet subsequent `memory.save({scope:'project'})`
  // calls still returned `project_required` because the memory handlers
  // only consulted `ctx.project` (URL-derived) and never the router.

  const MCP_SESSION = 'mcp-sess-1';

  function unscopedContextWithSession(): RequestContext {
    const token: Token = {
      id: 'tk_test',
      name: 'test-token',
      hash: 'hash',
      scope: ADMIN_TOKEN_SCOPE,
      projectId: null,
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null,
    };
    return {
      token,
      scope: ADMIN_TOKEN_SCOPE,
      project: null,
      requestedSlug: null,
      mcpSessionId: MCP_SESSION,
    };
  }

  let router: SessionRouter;
  let routerHandlers: ReturnType<typeof buildMemoryHandlers>;

  beforeEach(() => {
    router = new SessionRouter();
    routerHandlers = buildMemoryHandlers({ memory, router, projects });
  });

  it('memory.save({scope:project}) succeeds after project.use activates a project', async () => {
    router.setActiveProject('tk_test', MCP_SESSION, projectA.id, 'tool-explicit');
    const r = await runWithContext(unscopedContextWithSession(), () =>
      Promise.resolve(
        routerHandlers.save({
          scope: 'project',
          type: 'user',
          title: 'router-activated save',
          content: 'router-activated save',
        }),
      ),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.scope).toBe('project');
    expect(persisted?.projectId).toBe(projectA.id);
  });

  it('memory.save without router activation still returns project_required', async () => {
    const r = await runWithContext(unscopedContextWithSession(), () =>
      Promise.resolve(
        routerHandlers.save({
          scope: 'project',
          type: 'user',
          title: 'no project',
          content: 'no project',
        }),
      ),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('project_required');
  });

  it('memory.search returns the router-activated project memories, not globals', async () => {
    memory.save({ type: 'user', title: 'global only', content: 'global only' }, SCOPE_GLOBAL);
    const saved = memory.save(
      { type: 'user', title: 'in project A', content: 'in project A' },
      projectScope(projectA.id),
    );
    router.setActiveProject('tk_test', MCP_SESSION, projectA.id, 'tool-explicit');
    const r = await runWithContext(unscopedContextWithSession(), () =>
      Promise.resolve(routerHandlers.search({})),
    );
    const { memories } = parseText<{
      memories: { id: string; scope: string; projectId: string | null }[];
    }>(r);
    expect(memories.some((m) => m.id === saved.id)).toBe(true);
    expect(memories.every((m) => m.scope === 'project' && m.projectId === projectA.id)).toBe(true);
  });

  it('memory.get on a project id resolves once the router has activated that project', async () => {
    const saved = memory.save(
      { type: 'user', title: 'gettable', content: 'gettable' },
      projectScope(projectA.id),
    );
    router.setActiveProject('tk_test', MCP_SESSION, projectA.id, 'tool-explicit');
    const r = await runWithContext(unscopedContextWithSession(), () =>
      Promise.resolve(routerHandlers.get({ id: saved.id })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const payload = parseText<{ memory: { id: string } }>(r);
    expect(payload.memory.id).toBe(saved.id);
  });
});

describe('memory.save — eager roots discovery race (option B fix)', () => {
  // Reproduces the bug where the very first scope-aware call on a fresh
  // transport (e.g. `memory.save({scope:'project'})`) returned
  // `project_required` because roots discovery had not run yet — it was
  // only wired into `project.current` / `memory.session_start`. The fix:
  // `createMcpServer` fires discovery eagerly from `oninitialized` and
  // stashes the in-flight Promise on the router so any tool handler
  // that resolves project scope awaits the same promise (single-flight)
  // instead of falling through to `project_required`.

  const MCP_SESSION = 'mcp-sess-eager';

  function unscopedContextWithSession(): RequestContext {
    const token: Token = {
      id: 'tk_test',
      name: 'test-token',
      hash: 'hash',
      scope: ADMIN_TOKEN_SCOPE,
      projectId: null,
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null,
    };
    return {
      token,
      scope: ADMIN_TOKEN_SCOPE,
      project: null,
      requestedSlug: null,
      mcpSessionId: MCP_SESSION,
    };
  }

  // Minimal stand-in for the McpServer that the handler's `getServer`
  // factory returns. `resolveEffectiveProject` only forwards it to
  // `ensureRootsDiscoveryRun`, which short-circuits when there is an
  // in-flight promise on the router — so the stub is never dereferenced.
  const fakeServer = {} as unknown as Parameters<
    typeof buildMemoryHandlers
  >[0]['getServer'] extends (() => infer S) | undefined
    ? S
    : never;

  let router: SessionRouter;
  let routerHandlers: ReturnType<typeof buildMemoryHandlers>;

  beforeEach(() => {
    router = new SessionRouter();
    routerHandlers = buildMemoryHandlers({
      memory,
      router,
      projects,
      getServer: () => fakeServer,
    });
  });

  it('memory.save awaits an in-flight discovery promise and resolves the activated project', async () => {
    // Simulate the state created by `server.oninitialized`: discovery
    // is in flight; its resolution will activate `projectA` on this
    // transport (mirrors what `maybeDiscoverViaRoots`'s
    // `applyDerivedSlug` does once `listRoots` returns).
    let resolveDiscovery: () => void = () => undefined;
    const discoveryPromise = new Promise<void>((resolve) => {
      resolveDiscovery = resolve;
    }).then(() => {
      router.setActiveProject('tk_test', MCP_SESSION, projectA.id, 'roots');
    });
    router.setDiscoveryPromise('tk_test', MCP_SESSION, discoveryPromise);

    // Kick off the save BEFORE discovery settles. With the fix in place
    // the save awaits the in-flight promise; without it the save would
    // return `project_required` immediately.
    const pending = runWithContext(unscopedContextWithSession(), async () =>
      routerHandlers.save({
        scope: 'project',
        type: 'project',
        title: 'eager-discovery save',
        content: 'eager-discovery save',
      }),
    );
    resolveDiscovery();
    const r = await pending;

    expect(isErrorResponse(r)).toBeFalsy();
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.scope).toBe('project');
    expect(persisted?.projectId).toBe(projectA.id);
  });

  it('memory.search awaits the same in-flight discovery promise', async () => {
    const saved = memory.save(
      {
        type: 'user',
        title: 'visible only with project scope',
        content: 'visible only with project scope',
      },
      projectScope(projectA.id),
    );

    let resolveDiscovery: () => void = () => undefined;
    const discoveryPromise = new Promise<void>((resolve) => {
      resolveDiscovery = resolve;
    }).then(() => {
      router.setActiveProject('tk_test', MCP_SESSION, projectA.id, 'roots');
    });
    router.setDiscoveryPromise('tk_test', MCP_SESSION, discoveryPromise);

    const pending = runWithContext(unscopedContextWithSession(), async () =>
      routerHandlers.search({}),
    );
    resolveDiscovery();
    const r = await pending;

    const { memories } = parseText<{ memories: { id: string; projectId: string | null }[] }>(r);
    expect(memories.some((m) => m.id === saved.id)).toBe(true);
    expect(memories.every((m) => m.projectId === projectA.id)).toBe(true);
  });
});

describe('memory.save — session attachment via HTTP-created sessions', () => {
  // Verifies the bridge that makes `POST /api/<slug>/sessions` (hook) and
  // subsequent `memory.save` (MCP) cohere: when no SessionRouter entry
  // exists, the save attaches to the most-recently-active session for
  // `(tokenId, projectId)`.

  let agentSessions: AgentSessionsService;
  let fallbackHandlers: ReturnType<typeof buildMemoryHandlers>;
  let realTokenId: string;
  let ctxWithRealToken: (project: Project | null) => RequestContext;

  beforeEach(async () => {
    const { AgentSessionsService } = await import('../services/agent-sessions.js');
    const { TokensService } = await import('../services/tokens.js');
    const { tokens: tokensSchema } = await import('../db/schema/tokens.js');
    const { eq } = await import('drizzle-orm');

    agentSessions = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db);
    const tokens = new TokensService(createRepositories(db.handle.db));
    tokens.bootstrapAdmin('attachment-test-token-with-enough-entropy');
    const admin = db.handle.db
      .select()
      .from(tokensSchema)
      .where(eq(tokensSchema.name, 'admin'))
      .get();
    realTokenId = admin!.id;
    ctxWithRealToken = (project) => ({
      ...fakeContext(project),
      token: { ...fakeContext(project).token, id: realTokenId },
    });
    fallbackHandlers = buildMemoryHandlers({ memory, projects, agentSessions });
  });

  it('attaches a memory to the session created via agentSessions.ensure', async () => {
    agentSessions.ensure({
      id: 'sess-http-created-1',
      tokenId: realTokenId,
      projectId: projectA.id,
      agent: 'plugin-hook',
    });

    const r = await runWithContext(ctxWithRealToken(projectA), () =>
      fallbackHandlers.save({
        scope: 'project',
        type: 'project',
        title: 'memory saved after HTTP session create',
        content: 'memory saved after HTTP session create',
      }),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.sessionId).toBe('sess-http-created-1');
  });

  it('saves with session_id=null (never guesses) when two active sessions exist for the same token+project', async () => {
    agentSessions.ensure({
      id: 'sess-older',
      tokenId: realTokenId,
      projectId: projectA.id,
      agent: 'older',
    });
    // Force a later started_at by waiting a tick (clock granularity is ms).
    await new Promise((res) => setTimeout(res, 5));
    agentSessions.ensure({
      id: 'sess-newer',
      tokenId: realTokenId,
      projectId: projectA.id,
      agent: 'newer',
    });

    const r = await runWithContext(ctxWithRealToken(projectA), () =>
      fallbackHandlers.save({
        scope: 'project',
        type: 'project',
        title: 'ambiguous concurrent sessions',
        content: 'ambiguous concurrent sessions',
      }),
    );
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    // Neither candidate was silently (and possibly wrongly) chosen.
    expect(persisted?.sessionId).toBeNull();
  });

  it('saves with session_id=null when no active session exists', async () => {
    const r = await runWithContext(ctxWithRealToken(projectA), () =>
      fallbackHandlers.save({
        scope: 'project',
        type: 'project',
        title: 'no session active',
        content: 'no session active',
      }),
    );
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.sessionId).toBeNull();
  });

  it('SessionRouter entry takes precedence over the DB fallback', async () => {
    const router = new SessionRouter();
    const MCP_SESSION = 'mcp-sess-precedence';
    // DB has a session for the (token, project).
    agentSessions.ensure({
      id: 'sess-db-fallback',
      tokenId: realTokenId,
      projectId: projectA.id,
      agent: 'db',
    });
    // Router explicitly points at a different session.
    agentSessions.ensure({
      id: 'sess-router-explicit',
      tokenId: realTokenId,
      projectId: projectA.id,
      agent: 'router',
    });
    router.setActiveSession(realTokenId, MCP_SESSION, 'sess-router-explicit');

    const handlersWithRouter = buildMemoryHandlers({ memory, projects, agentSessions, router });
    const ctxWithSession: RequestContext = {
      ...ctxWithRealToken(projectA),
      mcpSessionId: MCP_SESSION,
    };
    const r = await runWithContext(ctxWithSession, () =>
      handlersWithRouter.save({
        scope: 'project',
        type: 'project',
        title: 'router precedence',
        content: 'router precedence',
      }),
    );
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.sessionId).toBe('sess-router-explicit');
  });
});

describe('memory.confirm — session attachment (fix-audited-defects)', () => {
  let agentSessions: AgentSessionsService;
  let confirmHandlers: ReturnType<typeof buildMemoryHandlers>;
  let realTokenId: string;
  let ctxWithRealToken: (project: Project | null) => RequestContext;
  let confirmationSessionIdFor: (memoryId: string) => string | null;

  beforeEach(async () => {
    const { AgentSessionsService } = await import('../services/agent-sessions.js');
    const { TokensService } = await import('../services/tokens.js');
    const { tokens: tokensSchema } = await import('../db/schema/tokens.js');
    const { confirmations } = await import('../db/schema/confirmations.js');
    const { eq } = await import('drizzle-orm');

    agentSessions = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db);
    const tokens = new TokensService(createRepositories(db.handle.db));
    tokens.bootstrapAdmin('confirm-attachment-test-token-with-enough-entropy');
    const admin = db.handle.db
      .select()
      .from(tokensSchema)
      .where(eq(tokensSchema.name, 'admin'))
      .get();
    realTokenId = admin!.id;
    ctxWithRealToken = (project) => ({
      ...fakeContext(project),
      token: { ...fakeContext(project).token, id: realTokenId },
    });
    confirmHandlers = buildMemoryHandlers({ memory, projects, agentSessions });

    confirmationSessionIdFor = (memoryId: string) => {
      const row = db.handle.db
        .select({ sessionId: confirmations.sessionId })
        .from(confirmations)
        .where(eq(confirmations.memoryId, memoryId))
        .get();
      return row?.sessionId ?? null;
    };
  });

  it('an explicit sessionId is attached to the confirmation event', async () => {
    agentSessions.ensure({
      id: 'sess-confirm-explicit',
      tokenId: realTokenId,
      projectId: projectA.id,
      agent: 'plugin-hook',
    });
    const m = memory.save(
      { type: 'user', title: 'confirm session attach', content: 'confirm session attach' },
      projectScope(projectA.id),
    );

    const r = await runWithContext(ctxWithRealToken(projectA), () =>
      confirmHandlers.confirm({ id: m.id, sessionId: 'sess-confirm-explicit' }),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    expect(confirmationSessionIdFor(m.id)).toBe('sess-confirm-explicit');
  });

  it('falls back to the unambiguous active session when no explicit sessionId is passed', async () => {
    agentSessions.ensure({
      id: 'sess-confirm-fallback',
      tokenId: realTokenId,
      projectId: projectA.id,
      agent: 'plugin-hook',
    });
    const m = memory.save(
      { type: 'user', title: 'confirm session fallback', content: 'confirm session fallback' },
      projectScope(projectA.id),
    );

    const r = await runWithContext(ctxWithRealToken(projectA), () =>
      confirmHandlers.confirm({ id: m.id }),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    expect(confirmationSessionIdFor(m.id)).toBe('sess-confirm-fallback');
  });

  it('records session_id=null when no session resolves', async () => {
    const m = memory.save(
      { type: 'user', title: 'confirm no session', content: 'confirm no session' },
      projectScope(projectA.id),
    );

    const r = await runWithContext(ctxWithRealToken(projectA), () =>
      confirmHandlers.confirm({ id: m.id }),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    expect(confirmationSessionIdFor(m.id)).toBeNull();
  });
});

describe('memory.search — include_global is gated on connection and token', () => {
  // Each case isolates one of the two gates: the project.use cases can only
  // fail on the token check, the path-scoped ones only on the connection check.

  const MCP_SESSION = 'mcp-sess-gate';

  function scopedCtx(
    scope: TokenScope,
    opts: { project?: Project | null; mcpSessionId?: string | null },
  ): RequestContext {
    const token: Token = {
      id: 'tk_test',
      name: 'test-token',
      hash: 'hash',
      scope,
      projectId: null,
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null,
    };
    return {
      token,
      scope,
      project: opts.project ?? null,
      requestedSlug: opts.project?.slug ?? null,
      mcpSessionId: opts.mcpSessionId ?? null,
    };
  }

  let router: SessionRouter;
  let gateHandlers: ReturnType<typeof buildMemoryHandlers>;
  let repos: ReturnType<typeof createRepositories>;

  const rows = (r: unknown): { scope: string; title: string }[] =>
    parseText<{ memories: { scope: string; title: string }[] }>(r).memories;
  const globalTitles = (r: unknown): string[] =>
    rows(r)
      .filter((m) => m.scope === 'global')
      .map((m) => m.title);

  beforeEach(() => {
    repos = createRepositories(db.handle.db);
    router = new SessionRouter();
    gateHandlers = buildMemoryHandlers({ memory, router, projects, repos });
    memory.save(
      { type: 'user', title: 'user-wide convention', content: 'user-wide convention about tabs' },
      SCOPE_GLOBAL,
    );
    memory.save(
      { type: 'user', title: 'project-A convention', content: 'project-A convention about tabs' },
      projectScope(projectA.id),
    );
  });

  // Spec scenario: auth — "Project-restricted token requests global widening".
  // A project.use-derived scope, so the connection half cannot mask the token half.
  // The prefix, not the whole scope: `projectA` does not exist yet at collection time.
  it.each(['project', 'read:project'] as const)(
    'a %s:<id> token asking for globals succeeds and receives none',
    async (prefix) => {
      router.setActiveProject('tk_test', MCP_SESSION, projectA.id, 'tool-explicit');
      const scope = `${prefix}:${projectA.id}` as TokenScope;
      const r = await runWithContext(scopedCtx(scope, { mcpSessionId: MCP_SESSION }), () =>
        Promise.resolve(gateHandlers.search({ query: 'convention', include_global: true })),
      );
      expect(isErrorResponse(r)).toBeFalsy();
      expect(globalTitles(r)).toEqual([]);
    },
  );

  // Spec scenario: mcp-api — "Path-scoped connection with a full-access token".
  it('a path-scoped connection ignores include_global even for a `*` token', async () => {
    const r = await runWithContext(scopedCtx(ADMIN_TOKEN_SCOPE, { project: projectA }), () =>
      Promise.resolve(gateHandlers.search({ query: 'convention', include_global: true })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    expect(globalTitles(r)).toEqual([]);
  });

  // Spec scenario: mcp-api — "The entity branch is gated identically".
  it('gates the entity branch on the same terms', async () => {
    const ENT = [{ kind: 'path' as const, value: 'src/gate-probe.ts' }];
    const g = memory.save(
      { type: 'reference', title: 'global note on file', content: 'see the probe file for this' },
      SCOPE_GLOBAL,
    );
    const p = memory.save(
      { type: 'reference', title: 'project note on file', content: 'see the probe file here too' },
      projectScope(projectA.id),
    );
    repos.entities.linkMemory(g.id, 'global', null, ENT, new Date());
    repos.entities.linkMemory(p.id, 'project', projectA.id, ENT, new Date());
    const r = await runWithContext(scopedCtx(ADMIN_TOKEN_SCOPE, { project: projectA }), () =>
      Promise.resolve(gateHandlers.search({ entity: 'src/gate-probe.ts', include_global: true })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    // Without this the entity lookup could return nothing and satisfy the
    // global-exclusion assertion for free.
    expect(rows(r).some((m) => m.title === 'project note on file')).toBe(true);
    expect(globalTitles(r)).toEqual([]);
  });

  // Spec scenario: mcp-api — "`project.use` scope with an authorized token".
  // The control: the capability still works where it is authorized.
  it('still widens for a `*` token on a project.use-derived scope', async () => {
    router.setActiveProject('tk_test', MCP_SESSION, projectA.id, 'tool-explicit');
    const r = await runWithContext(
      scopedCtx(ADMIN_TOKEN_SCOPE, { mcpSessionId: MCP_SESSION }),
      () => Promise.resolve(gateHandlers.search({ query: 'convention', include_global: true })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    expect(globalTitles(r)).toEqual(['user-wide convention']);
  });
});

describe('an unresolvable path slug establishes no scope', () => {
  // The inverted characterization test for the leak this suite used to
  // document: a slug naming no project used to resolve to SCOPE_GLOBAL, so the
  // connection read user-wide memory while presenting as path-scoped. It now
  // resolves to nothing and the call is refused, reads included.
  it('refuses a `*` token at /mcp/<unknown-slug> instead of serving global memories', async () => {
    memory.save({ type: 'user', title: 'user-wide row', content: 'user-wide row' }, SCOPE_GLOBAL);
    const token: Token = {
      id: 'tk_test',
      name: 'test-token',
      hash: 'hash',
      scope: ADMIN_TOKEN_SCOPE,
      projectId: null,
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null,
    };
    const ctx: RequestContext = {
      token,
      scope: ADMIN_TOKEN_SCOPE,
      project: null,
      requestedSlug: 'no-such-project',
      mcpSessionId: null,
    };
    const r = await runWithContext(ctx, () =>
      Promise.resolve(handlers.search({ query: 'user-wide' })),
    );
    expect(isErrorResponse(r)).toBe(true);
    const payload = parseText<{ code: string; message: string; memories?: unknown }>(r);
    expect(payload.code).toBe('project_not_found');
    expect(payload.message).toContain('no-such-project');
    expect(payload.memories).toBeUndefined();
  });
});
