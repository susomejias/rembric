import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { RELATIVE_LEVEL_RATIO, ABSTENTION_FLOOR } from '../services/hybrid-search.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { PromptsService } from '../services/prompts.js';
import { RelationsService } from '../services/relations.js';
import { SCOPE_GLOBAL } from '../services/scope.js';
import { createTestDb, mintTestToken, type TestDb } from '../test/index.js';

import { buildMemoryHandlers } from './memory-tools.js';

/**
 * `memory.context`'s relevance channel runs the same scoped hybrid search and
 * inherits the module gate constants with no separate wiring, so an enabled
 * gate can silently empty a channel the agent reads at session start. Asserted
 * against the SHIPPED constants, not against overrides.
 */

let db: TestDb;
let repos: Repositories;
let memory: MemoryService;
let handlers: ReturnType<typeof buildMemoryHandlers>;
let token: Token;

function ctx(): RequestContext {
  return {
    token,
    scope: '*',
    project: null,
    requestedSlug: null,
    mcpSessionId: 'mcp-sess-context-gates',
  };
}

function payload(resp: unknown): { relevantMemories: { id: string; via: string }[] } {
  return JSON.parse((resp as { content: { text: string }[] }).content[0]!.text) as {
    relevantMemories: { id: string; via: string }[];
  };
}

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  memory = new MemoryService(repos, db.handle.db);
  token = mintTestToken(db.handle, { scope: '*' }).token;
  handlers = buildMemoryHandlers({
    repos,
    memory,
    projects: new ProjectsService(repos),
    agentSessions: new AgentSessionsService(repos, db.handle.db),
    prompts: new PromptsService(repos, db.handle.db),
    relations: new RelationsService(repos, db.handle.db),
    router: new SessionRouter(),
    orphanAfterMs: 86_400_000,
  });
});

afterEach(() => db.cleanup());

describe('memory.context relevance channel under the shipped gates', () => {
  it('is the configuration under test: the ratio is enabled and the floor is not', () => {
    expect(RELATIVE_LEVEL_RATIO).toBe(0.4);
    expect(ABSTENTION_FLOOR).toBeNull();
  });

  it('still returns the best-matching rows, and never empties on a matching focus', async () => {
    const answer = memory.save(
      {
        type: 'project',
        title: 'Scheduler restart runbook',
        content: 'restart the nimbus scheduler by draining the queue first',
      },
      SCOPE_GLOBAL,
    );
    for (let i = 0; i < 12; i++)
      memory.save(
        { type: 'project', title: `Filler ${i}`, content: `the nimbus notes row ${i}` },
        SCOPE_GLOBAL,
      );

    const focused = payload(
      await runWithContext(ctx(), () =>
        handlers.context({ focus: 'how do we restart the nimbus scheduler' }),
      ),
    );
    expect(focused.relevantMemories.length).toBeGreaterThan(0);
    expect(focused.relevantMemories.map((r) => r.id)).toContain(answer.id);
  });

  it('a focus that matches nothing yields an empty channel rather than an error', async () => {
    memory.save(
      { type: 'project', title: 'Unrelated', content: 'billing invoice reconciliation' },
      SCOPE_GLOBAL,
    );

    const resp = await runWithContext(ctx(), () =>
      handlers.context({ focus: 'zzqqxx nonexistentterm' }),
    );
    expect((resp as { isError?: boolean }).isError).not.toBe(true);
    expect(payload(resp).relevantMemories).toEqual([]);
  });
});
