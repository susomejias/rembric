import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { PromptsService } from '../services/prompts.js';
import { RelationsService } from '../services/relations.js';
import { projectScope, type Scope } from '../services/scope.js';
import { createTestDb, defaultProjectScope, mintTestToken, type TestDb } from '../test/index.js';

import { buildMemoryHandlers } from './memory-tools.js';
import { buildObservabilityHandlers } from './observability-tools.js';
import { buildRelationsHandlers } from './relations-tools.js';

/**
 * `memory.context.pendingJudgments[]` is a page of an AGED queue: five rows,
 * older than the orphan threshold. Without a total the caller cannot tell the
 * page from the queue, and without a size the un-aged rows are unreachable from
 * every MCP surface — `memory.judge` needs a judgmentId only this list or
 * save-time `candidates[]` emits, and `memory.compare` needs both ids up front.
 */

const MCP_SESSION_ID = 'mcp-sess-pending-judgments';
const SCOPE = '*' as const;
const ORPHAN_AFTER_MS = 86_400_000;

let db: TestDb;
let defaultScope: Scope;
let repos: Repositories;
let projects: ProjectsService;
let memory: MemoryService;
let relations: RelationsService;
let handlers: ReturnType<typeof buildMemoryHandlers>;
let observability: ReturnType<typeof buildObservabilityHandlers>;
let adminToken: Token;

function makeContext(token: Token): RequestContext {
  return {
    token,
    scope: SCOPE,
    project: null,
    requestedSlug: null,
    mcpSessionId: MCP_SESSION_ID,
  };
}

interface McpResp {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function decode(resp: unknown): { isError: boolean; payload: Record<string, unknown> } {
  const r = resp as McpResp;
  const text = r.content[0]?.text ?? '';
  return { isError: r.isError === true, payload: JSON.parse(text) as Record<string, unknown> };
}

interface PendingEntry {
  judgmentId: string;
  sourceId: string;
  targetId: string;
  sourceTitle: string;
  targetTitle: string;
  sourceSnippet: string;
  targetSnippet: string;
}

function callContext(args: Record<string, unknown> = {}) {
  return runWithContext(makeContext(adminToken), () => handlers.context(args));
}

function callStats() {
  return runWithContext(makeContext(adminToken), () => observability.stats());
}

/** A pending pair created `ageMs` ago, so the aged/un-aged split is controllable. */
function seedPending(label: string, ageMs: number, scope: Scope = defaultScope): string {
  const source = memory.save({ type: 'project', title: `${label} source`, content: label }, scope);
  const target = memory.save({ type: 'project', title: `${label} target`, content: label }, scope);
  return pendingBetween(source.id, target.id, ageMs);
}

function pendingBetween(sourceId: string, targetId: string, ageMs: number): string {
  const at = new Date(Date.now() - ageMs);
  return new RelationsService(repos, db.handle.db, () => at).createPending({ sourceId, targetId })
    .judgmentId;
}

beforeEach(() => {
  db = createTestDb();
  defaultScope = defaultProjectScope(db.handle);
  repos = createRepositories(db.handle.db);
  projects = new ProjectsService(repos);
  memory = new MemoryService(repos, db.handle.db);
  adminToken = mintTestToken(db.handle, { scope: SCOPE }).token;
  const agentSessions = new AgentSessionsService(repos, db.handle.db);
  const router = new SessionRouter();
  relations = new RelationsService(repos, db.handle.db);
  handlers = buildMemoryHandlers({
    repos,
    memory,
    projects,
    agentSessions,
    prompts: new PromptsService(repos, db.handle.db),
    relations,
    router,
    orphanAfterMs: ORPHAN_AFTER_MS,
  });
  observability = buildObservabilityHandlers({
    repos,
    memory,
    projects,
    agentSessions,
    router,
    relations,
    doctor: () => {
      throw new Error('memory.doctor is not under test here');
    },
  });
});

afterEach(() => db.cleanup());

describe('memory.context reports the pending-judgment total beside the page', () => {
  it('the total is the full scoped count while the list is a page of it', async () => {
    for (let i = 0; i < 8; i += 1) seedPending(`aged-${i}`, 2 * ORPHAN_AFTER_MS);

    const { isError, payload } = decode(await callContext());

    expect(isError).toBe(false);
    const list = payload.pendingJudgments as PendingEntry[];
    // Asserting only `total >= list.length` would pass against the very bug
    // this change fixes (returning the page length as the total).
    expect(list).toHaveLength(5);
    expect(payload.pendingJudgmentsTotal).toBe(8);
    expect(list.length).toBeLessThan(payload.pendingJudgmentsTotal as number);
  });

  it('counts un-aged pendings the default list deliberately hides', async () => {
    seedPending('aged', 2 * ORPHAN_AFTER_MS);
    seedPending('fresh-a', 0);
    seedPending('fresh-b', 0);

    const { payload } = decode(await callContext());

    expect(payload.pendingJudgments).toHaveLength(1);
    expect(payload.pendingJudgmentsTotal).toBe(3);
  });

  it('a pending pair in another project does not raise the total', async () => {
    const other = projects.create({ slug: 'pending-total-other', displayName: null });
    seedPending('other-project', 2 * ORPHAN_AFTER_MS, projectScope(other.id));

    const { payload } = decode(await callContext());

    expect(payload.pendingJudgments).toEqual([]);
    expect(payload.pendingJudgmentsTotal).toBe(0);
  });
});

describe('memory.context `judgments` size lifts the age filter', () => {
  it('the default still returns only aged pairs', async () => {
    const aged = seedPending('aged', 2 * ORPHAN_AFTER_MS);
    seedPending('fresh', 0);

    const { payload } = decode(await callContext());

    const list = payload.pendingJudgments as PendingEntry[];
    expect(list.map((r) => r.judgmentId)).toEqual([aged]);
  });

  it('an explicit size returns the un-aged pair too, oldest first', async () => {
    const aged = seedPending('aged', 2 * ORPHAN_AFTER_MS);
    const fresh = seedPending('fresh', 0);

    const { payload } = decode(await callContext({ judgments: 10 }));

    const list = payload.pendingJudgments as PendingEntry[];
    expect(list.map((r) => r.judgmentId)).toEqual([aged, fresh]);
    expect(payload.pendingJudgmentsTotal).toBe(2);
  });

  it('an explicit size bounds the page within the max', async () => {
    for (let i = 0; i < 8; i += 1) seedPending(`fresh-${i}`, 0);

    const { payload } = decode(await callContext({ judgments: 3 }));

    expect(payload.pendingJudgments).toHaveLength(3);
    expect(payload.pendingJudgmentsTotal).toBe(8);
  });

  it('asking for more than exists returns what exists rather than erroring', async () => {
    seedPending('only', 0);

    const { isError, payload } = decode(await callContext({ judgments: 50 }));

    expect(isError).toBe(false);
    expect(payload.pendingJudgments).toHaveLength(1);
  });

  it('`judgments: 0` returns no rows but still reports the total', async () => {
    seedPending('aged', 2 * ORPHAN_AFTER_MS);

    const { payload } = decode(await callContext({ judgments: 0 }));

    expect(payload.pendingJudgments).toEqual([]);
    expect(payload.pendingJudgmentsTotal).toBe(1);
  });

  it('inventory rows still carry both endpoints so the caller can judge from the response', async () => {
    seedPending('judgeable-marker', 0);

    const { payload } = decode(await callContext({ judgments: 10 }));

    const [entry] = payload.pendingJudgments as PendingEntry[];
    expect(entry?.judgmentId).toBeTruthy();
    expect(entry?.sourceTitle).toBe('judgeable-marker source');
    expect(entry?.targetTitle).toBe('judgeable-marker target');
    expect(entry?.sourceSnippet).toContain('judgeable-marker');
    expect(entry?.targetSnippet).toContain('judgeable-marker');
    expect(entry?.sourceId).not.toBe(entry?.targetId);
  });

  it('an explicit size does not reach across scopes', async () => {
    const other = projects.create({ slug: 'pending-inventory-other', displayName: null });
    seedPending('other-project', 0, projectScope(other.id));

    const { payload } = decode(await callContext({ judgments: 50 }));

    expect(payload.pendingJudgments).toEqual([]);
    expect(payload.pendingJudgmentsTotal).toBe(0);
  });
});

describe('memory.context withholds pending pairs whose endpoint is retired', () => {
  function seedTopicKeyRevision(): { a: string; b: string; live: string } {
    const a = memory.saveWithTopicKey(
      { type: 'project', title: 'A on t', content: 'a on t', topicKey: 't' },
      defaultScope,
    ).memory;
    for (let i = 0; i < 5; i += 1) {
      const target = memory.save(
        { type: 'project', title: `x${i}`, content: `x${i}` },
        defaultScope,
      );
      pendingBetween(a.id, target.id, 3 * ORPHAN_AFTER_MS - i);
    }
    const b = memory.saveWithTopicKey(
      { type: 'project', title: 'B on t', content: 'b on t', topicKey: 't' },
      defaultScope,
    ).memory;
    const target = memory.save({ type: 'project', title: 'y', content: 'y' }, defaultScope);
    const live = pendingBetween(b.id, target.id, 2 * ORPHAN_AFTER_MS);
    return { a: a.id, b: b.id, live };
  }

  it('a topic_key revision does not evict the live pending from the page', async () => {
    const { a, b, live } = seedTopicKeyRevision();

    expect(repos.memory.unsafeGetById(a)?.status).toBe('superseded');
    expect(repos.memory.unsafeGetById(b)?.status).toBe('active');

    const { payload } = decode(await callContext());

    const list = payload.pendingJudgments as PendingEntry[];
    expect(list.map((r) => r.judgmentId)).toEqual([live]);
    expect(list.map((r) => r.sourceId)).toEqual([b]);
    expect(payload.pendingJudgmentsTotal).toBe(1);
  });

  it('a withheld pair stays reachable and closable through its annotation', async () => {
    const a = memory.saveWithTopicKey(
      { type: 'project', title: 'A on u', content: 'a on u', topicKey: 'u' },
      defaultScope,
    ).memory;
    const counterpart = memory.save({ type: 'project', title: 'z', content: 'z' }, defaultScope);
    const jid = pendingBetween(a.id, counterpart.id, 3 * ORPHAN_AFTER_MS);
    memory.saveWithTopicKey(
      { type: 'project', title: 'B on u', content: 'b on u', topicKey: 'u' },
      defaultScope,
    );
    expect(repos.memory.unsafeGetById(a.id)?.status).toBe('superseded');
    expect(repos.memory.unsafeGetById(counterpart.id)?.status).toBe('active');

    const { payload } = decode(await callContext({ judgments: 50 }));
    expect(payload.pendingJudgments).toEqual([]);
    expect(payload.pendingJudgmentsTotal).toBe(0);

    const got = decode(
      await runWithContext(makeContext(adminToken), () => handlers.get({ id: counterpart.id })),
    ).payload;
    const annotations = got.relations as { judgmentId?: string; status: string }[];
    expect(annotations.map((r) => r.judgmentId)).toContain(jid);

    const relationHandlers = buildRelationsHandlers({
      relations,
      router: new SessionRouter(),
      projects,
      repos,
    });
    const judged = decode(
      await runWithContext(makeContext(adminToken), () =>
        relationHandlers.judge({ judgmentId: jid, relation: 'related', reason: 'still reachable' }),
      ),
    );
    expect(judged.isError).toBe(false);
    expect(judged.payload.status).toBe('judged');
  });

  it('an aged pair whose target was archived is withheld on the same terms', async () => {
    const source = memory.save({ type: 'project', title: 's', content: 's' }, defaultScope);
    const target = memory.save({ type: 'project', title: 't', content: 't' }, defaultScope);
    pendingBetween(source.id, target.id, 2 * ORPHAN_AFTER_MS);
    memory.archive(target.id, defaultScope);

    expect(repos.memory.unsafeGetById(target.id)?.status).toBe('archived');

    const { payload } = decode(await callContext());

    expect(payload.pendingJudgments).toEqual([]);
    expect(payload.pendingJudgmentsTotal).toBe(0);
  });

  it('an explicit size does not readmit a pair withheld for a retired endpoint', async () => {
    for (let i = 0; i < 3; i += 1) {
      const source = memory.save(
        { type: 'project', title: `dead-src-${i}`, content: `dead-src-${i}` },
        defaultScope,
      );
      const target = memory.save(
        { type: 'project', title: `dead-tgt-${i}`, content: `dead-tgt-${i}` },
        defaultScope,
      );
      pendingBetween(source.id, target.id, 0);
      memory.archive(target.id, defaultScope);
    }
    const live = seedPending('adjudicable', 0);

    const { payload } = decode(await callContext({ judgments: 50 }));

    const list = payload.pendingJudgments as PendingEntry[];
    expect(list.map((r) => r.judgmentId)).toEqual([live]);
    expect(payload.pendingJudgmentsTotal).toBe(1);
  });

  it('memory.stats reports the same pending depth as memory.context', async () => {
    seedTopicKeyRevision();

    const context = decode(await callContext());
    const stats = decode(await callStats());

    expect(stats.isError).toBe(false);
    expect(stats.payload.pendingJudgmentsTotal).toBe(1);
    expect(stats.payload.pendingJudgmentsTotal).toBe(context.payload.pendingJudgmentsTotal);
  });

  it('control: an adjudicable pair is still listed and counted, with and without a size', async () => {
    const live = seedPending('both-active', 2 * ORPHAN_AFTER_MS);

    const bare = decode(await callContext());
    expect((bare.payload.pendingJudgments as PendingEntry[]).map((r) => r.judgmentId)).toEqual([
      live,
    ]);
    expect(bare.payload.pendingJudgmentsTotal).toBe(1);

    const sized = decode(await callContext({ judgments: 50 }));
    expect((sized.payload.pendingJudgments as PendingEntry[]).map((r) => r.judgmentId)).toEqual([
      live,
    ]);
    expect(sized.payload.pendingJudgmentsTotal).toBe(1);
  });
});
