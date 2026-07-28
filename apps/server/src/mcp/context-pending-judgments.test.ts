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
import { projectScope, SCOPE_GLOBAL, type Scope } from '../services/scope.js';
import type { TokenScope } from '../services/tokens.js';
import { createTestDb, mintTestToken, type TestDb } from '../test/index.js';

import { buildMemoryHandlers } from './memory-tools.js';

/**
 * `memory.context.pendingJudgments[]` is a page of an AGED queue: five rows,
 * older than the orphan threshold. Without a total the caller cannot tell the
 * page from the queue, and without a size the un-aged rows are unreachable from
 * every MCP surface — `memory.judge` needs a judgmentId only this list or
 * save-time `candidates[]` emits, and `memory.compare` needs both ids up front.
 */

const MCP_SESSION_ID = 'mcp-sess-pending-judgments';
const SCOPE: TokenScope = '*';
const ORPHAN_AFTER_MS = 86_400_000;

let db: TestDb;
let repos: Repositories;
let projects: ProjectsService;
let memory: MemoryService;
let handlers: ReturnType<typeof buildMemoryHandlers>;
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

/** A pending pair created `ageMs` ago, so the aged/un-aged split is controllable. */
function seedPending(label: string, ageMs: number, scope: Scope = SCOPE_GLOBAL): string {
  const at = new Date(Date.now() - ageMs);
  const source = memory.save({ type: 'project', title: `${label} source`, content: label }, scope);
  const target = memory.save({ type: 'project', title: `${label} target`, content: label }, scope);
  const relations = new RelationsService(repos, db.handle.db, () => at);
  return relations.createPending({ sourceId: source.id, targetId: target.id }).judgmentId;
}

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  projects = new ProjectsService(repos);
  memory = new MemoryService(repos, db.handle.db);
  adminToken = mintTestToken(db.handle, SCOPE).token;
  handlers = buildMemoryHandlers({
    repos,
    memory,
    projects,
    agentSessions: new AgentSessionsService(repos, db.handle.db),
    prompts: new PromptsService(repos, db.handle.db),
    router: new SessionRouter(),
    orphanAfterMs: ORPHAN_AFTER_MS,
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

  it('an explicit size bounds the page and `clamped` stays false within the max', async () => {
    for (let i = 0; i < 8; i += 1) seedPending(`fresh-${i}`, 0);

    const { payload } = decode(await callContext({ judgments: 3 }));

    expect(payload.pendingJudgments).toHaveLength(3);
    expect(payload.pendingJudgmentsTotal).toBe(8);
    expect(payload.clamped).toBe(false);
  });

  it('asking for more than exists returns what exists rather than erroring', async () => {
    seedPending('only', 0);

    const { isError, payload } = decode(await callContext({ judgments: 50 }));

    expect(isError).toBe(false);
    expect(payload.pendingJudgments).toHaveLength(1);
    expect(payload.clamped).toBe(false);
  });

  // Handler-level defence only. Over MCP the input schema's `.max()` rejects
  // `judgments: 999` with invalid_input before this runs, so `clamped` is not
  // observable on the wire — same layering as the three sibling size args.
  it('the in-process clamp bounds a size over the max instead of throwing', async () => {
    for (let i = 0; i < 3; i += 1) seedPending(`fresh-${i}`, 0);

    const { isError, payload } = decode(await callContext({ judgments: 999 }));

    expect(isError).toBe(false);
    expect(payload.pendingJudgments).toHaveLength(3);
    expect(payload.clamped).toBe(true);
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
