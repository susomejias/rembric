import { AgentSessionsService } from '@rembric/core';
import { MemoryService, PIN_MAX_PER_PROJECT } from '@rembric/core';
import { ProjectsService } from '@rembric/core';
import { PromptsService } from '@rembric/core';
import { RelationsService } from '@rembric/core';
import { runWithContext, type RequestContext } from '@rembric/core';
import {
  createRepositories,
  projectScope,
  type Repositories,
  type Scope,
  type Token,
} from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildMemoryHandlers,
  buildObservabilityHandlers,
  PINNED_CONTEXT_CHAR_BUDGET,
  RELEVANCE_LIMIT,
} from '@rembric/mcp';

import {
  createTestDb,
  defaultProject,
  defaultProjectScope,
  mintTestToken,
  type TestDb,
} from './test-support/index.js';
import { logInternalError } from './test-support/test-logger.js';

const CONTEXT_SNIPPET_CHARS = 350;

let db: TestDb;
let scope: Scope;
let otherScope: Scope;
let repos: Repositories;
let memory: MemoryService;
let handlers: ReturnType<typeof buildMemoryHandlers>;
let observability: ReturnType<typeof buildObservabilityHandlers>;
let token: Token;
let now: number;

function ctx(tokenScope: RequestContext['scope'] = '*'): RequestContext {
  return {
    token,
    scope: tokenScope,
    memberProjectIds: [],
    project: null,
    requestedSlug: null,
  };
}

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function parse<T>(resp: unknown): T {
  return JSON.parse((resp as ToolResult).content[0]!.text) as T;
}

interface PinnedRow {
  id: string;
  title: string;
  content: string;
  truncated: boolean;
  pinnedAt: string;
}

interface ContextPayload {
  pinnedMemories: PinnedRow[];
  recentMemories: { id: string }[];
  relevantMemories: { id: string }[];
  needsReview: { id: string }[];
}

const call = <T>(fn: () => unknown, tokenScope: RequestContext['scope'] = '*') =>
  runWithContext(ctx(tokenScope), async () => parse<T>(await fn()));

function save(title: string, content = `${title} body`, inScope: Scope = scope): string {
  now += 1_000;
  return memory.save({ type: 'feedback', title, content }, inScope).id;
}

const context = (args: Record<string, unknown> = {}) =>
  call<ContextPayload>(() => handlers.context(args));

const pin = (id: string, pinned = true) =>
  call<Record<string, unknown>>(() => handlers.pin({ id, pinned }));

beforeEach(() => {
  db = createTestDb();
  scope = defaultProjectScope(db.handle);
  repos = createRepositories(db.handle.db);
  now = Date.parse('2026-01-01T00:00:00Z');
  const clock = () => new Date(now);
  const projects = new ProjectsService(repos, clock);
  otherScope = projectScope(projects.create({ slug: 'other' }).id);
  memory = new MemoryService(repos, db.handle.db, clock);
  token = mintTestToken(db.handle, { scope: '*' }).token;
  const deps = {
    logInternalError,
    repos,
    memory,
    projects,
    agentSessions: new AgentSessionsService(repos, db.handle.db),
    prompts: new PromptsService(repos, db.handle.db),
    relations: new RelationsService(repos, db.handle.db),
    orphanAfterMs: 86_400_000,
  };
  handlers = buildMemoryHandlers(deps);
  observability = buildObservabilityHandlers({ ...deps, doctor: () => ({}) as never });
  expect(defaultProject(db.handle).id).toBe(scope.projectId);
});

afterEach(() => db.cleanup());

describe('memory.pin', () => {
  it('pins an active memory and reports the new state, the count and the bound', async () => {
    const id = save('rule');
    expect(await pin(id)).toEqual({
      ok: true,
      id,
      pinned: true,
      changed: true,
      pinnedCount: 1,
      pinnedMax: PIN_MAX_PER_PROJECT,
    });
    expect((await pin(id)).changed).toBe(false);
    expect(await pin(id, false)).toMatchObject({ pinned: false, changed: true, pinnedCount: 0 });
  });

  it('past the bound fails with pin_limit_reached naming the current pins', async () => {
    const ids = Array.from({ length: PIN_MAX_PER_PROJECT }, (_, i) => save(`rule ${i}`));
    for (const id of ids) await pin(id);
    const extra = save('extra');

    const resp = await runWithContext(ctx(), () => handlers.pin({ id: extra, pinned: true }));

    expect((resp as ToolResult).isError).toBe(true);
    const body = parse<{ code: string; limit: number; pinned: { id: string; title: string }[] }>(
      resp,
    );
    expect(body.code).toBe('pin_limit_reached');
    expect(body.limit).toBe(PIN_MAX_PER_PROJECT);
    expect(body.pinned).toEqual(ids.map((id, i) => ({ id, title: `rule ${i}` })));
  });

  it('a memory of another project is not found', async () => {
    const foreign = save('foreign', 'foreign body', otherScope);
    const resp = await runWithContext(ctx(), () => handlers.pin({ id: foreign, pinned: true }));
    expect((resp as ToolResult).isError).toBe(true);
    expect(parse<{ code: string }>(resp).code).toBe('not_found');
    expect(memory.countPinned(otherScope)).toBe(0);
  });

  it('a read-only token is forbidden and pins nothing', async () => {
    const id = save('rule');
    const resp = await runWithContext(ctx('read:*'), () => handlers.pin({ id, pinned: true }));
    expect((resp as ToolResult).isError).toBe(true);
    expect(parse<{ code: string }>(resp).code).toBe('forbidden');
    expect(memory.countPinned(scope)).toBe(0);
  });
});

describe('memory.context pinned section', () => {
  it('loads a pinned memory older than the recency window; unpinned it is absent', async () => {
    const old = save('standing rule');
    for (let i = 0; i < 10; i++) save(`recent ${i}`);

    const unpinned = await context();
    expect(unpinned.pinnedMemories).toEqual([]);
    expect(unpinned.recentMemories.map((r) => r.id)).not.toContain(old);

    await pin(old);
    const pinned = await context();
    expect(pinned.pinnedMemories).toMatchObject([
      { id: old, content: 'standing rule body', truncated: false },
    ]);
    expect(Object.keys(pinned)[0]).toBe('pinnedMemories');
  });

  it('a pinned memory is not repeated in the ranked channels and costs them no slot', async () => {
    for (let i = 0; i < 40; i++) save(`ledger ${i}`, `ledger entry ${i}`);
    const pinnedId = save('nimbus scheduler rule', 'restart the nimbus scheduler carefully');
    const others = Array.from({ length: 12 }, (_, i) =>
      save(`nimbus scheduler note ${i}`, `nimbus scheduler note number ${i}`),
    );
    await pin(pinnedId);

    const out = await context({ focus: 'nimbus scheduler', memories: 3 });

    expect(out.pinnedMemories.map((r) => r.id)).toEqual([pinnedId]);
    expect(out.recentMemories.map((r) => r.id)).not.toContain(pinnedId);
    expect(out.recentMemories).toHaveLength(3);
    expect(out.relevantMemories.map((r) => r.id)).not.toContain(pinnedId);
    expect(out.relevantMemories).toHaveLength(RELEVANCE_LIMIT);
    expect(others.length).toBeGreaterThan(RELEVANCE_LIMIT);
  });

  it('the most recent memory, pinned, leaves the recency channel full of unpinned rows', async () => {
    const older = Array.from({ length: 4 }, (_, i) => save(`older ${i}`));
    const newest = save('newest rule');
    await pin(newest);

    const out = await context({ memories: 3 });

    expect(out.pinnedMemories.map((r) => r.id)).toEqual([newest]);
    expect(out.recentMemories.map((r) => r.id)).toEqual(older.slice(1).reverse());
  });

  it('the entity pass skips pinned rows and still fills the relevance channel', async () => {
    const path = 'src/billing/reconcile.ts';
    const linked = Array.from({ length: RELEVANCE_LIMIT + 4 }, (_, i) => {
      const id = save(`linked ${i}`, 'billing invoice reconciliation notes');
      repos.entities.linkMemory(id, scope.projectId, [{ kind: 'path', value: path }], new Date());
      return id;
    });
    const pinnedIds = [linked[0]!, linked[1]!, linked.at(-2)!, linked.at(-1)!];
    for (const id of pinnedIds) await pin(id);

    const out = await context({ focus: path });
    const relevant = out.relevantMemories as { id: string; via: string }[];

    expect(relevant).toHaveLength(RELEVANCE_LIMIT);
    expect(relevant.every((r) => r.via === 'entity')).toBe(true);
    expect(relevant.some((r) => pinnedIds.includes(r.id))).toBe(false);
  });

  it('content past the character budget is snippet-truncated and flagged', async () => {
    const big = 'x'.repeat(PINNED_CONTEXT_CHAR_BUDGET - 100);
    const first = save('first', big);
    const second = save('second', 'y'.repeat(1_000));
    const third = save('third', 'short');
    for (const id of [first, second, third]) await pin(id);

    const out = await context();

    expect(out.pinnedMemories.map((r) => [r.id, r.truncated])).toEqual([
      [first, false],
      [second, true],
      [third, false],
    ]);
    expect(out.pinnedMemories[0]!.content).toBe(big);
    expect(out.pinnedMemories[1]!.content.length).toBeLessThanOrEqual(CONTEXT_SNIPPET_CHARS);
    expect(out.pinnedMemories[2]!.content).toBe('short');
  });

  it('holds the published budget of 4000 characters', () => {
    expect(PINNED_CONTEXT_CHAR_BUDGET).toBe(4000);
  });

  it("another project's pins are not loaded", async () => {
    const foreign = save('foreign', 'foreign body', otherScope);
    memory.setPinned(foreign, otherScope, true, { cause: 'agent', name: null });
    expect((await context()).pinnedMemories).toEqual([]);
  });

  it('a stale pinned memory is listed both pinned and as needing review', async () => {
    const id = save('rule');
    await pin(id);
    now += 400 * 86_400_000;
    const out = await context();
    expect(out.pinnedMemories.map((r) => r.id)).toEqual([id]);
    expect(out.needsReview.map((r) => r.id)).toContain(id);
  });
});

describe('pin state on reads', () => {
  it('memory.search and memory.get_batch rows carry pinned', async () => {
    const pinned = save('alpha rule', 'alpha body');
    const control = save('alpha other', 'alpha other body');
    await pin(pinned);

    const search = await call<{ memories: { id: string; pinned: boolean }[] }>(() =>
      handlers.search({ query: 'alpha' }),
    );
    const byId = new Map(search.memories.map((m) => [m.id, m.pinned]));
    expect(byId.get(pinned)).toBe(true);
    expect(byId.get(control)).toBe(false);

    const got = await call<{ memories: { id: string; pinned: boolean }[] }>(() =>
      handlers.get({ ids: [pinned, control] }),
    );
    expect(got.memories.map((m) => [m.id, m.pinned])).toEqual([
      [pinned, true],
      [control, false],
    ]);
  });

  it('memory.stats reports the scoped pinned total', async () => {
    await pin(save('mine'));
    memory.setPinned(save('foreign', 'f', otherScope), otherScope, true, {
      cause: 'agent',
      name: null,
    });
    const stats = await call<{ pinnedTotal: number }>(() => observability.stats());
    expect(stats.pinnedTotal).toBe(1);
  });
});
