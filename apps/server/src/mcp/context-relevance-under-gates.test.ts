import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import {
  RELATIVE_LEVEL_RATIO,
  ABSTENTION_FLOOR,
  EMPTY_POOL_REASON,
} from '../services/hybrid-search.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { PromptsService } from '../services/prompts.js';
import { RelationsService } from '../services/relations.js';
import { SCOPE_GLOBAL } from '../services/scope.js';
import { createTestDb, mintTestToken, type TestDb } from '../test/index.js';

import { buildMemoryHandlers, RELEVANCE_LIMIT } from './memory-tools.js';

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

interface ContextPayload {
  relevantMemories: { id: string; via: string }[];
  rankedPass?: { abstained: boolean; reason?: string; gateShortened?: boolean };
}

function payload(resp: unknown): ContextPayload {
  return JSON.parse((resp as { content: { text: string }[] }).content[0]!.text) as ContextPayload;
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
    const body = payload(resp);
    expect(body.relevantMemories).toEqual([]);
    expect(body.rankedPass?.abstained).toBe(true);
    expect(body.rankedPass?.reason).toBe(EMPTY_POOL_REASON);
    expect(body.rankedPass?.gateShortened).toBeUndefined();
  });

  it('reports the ranked pass as shortened when the shipped ratio cuts its page', async () => {
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
    const focus = 'how do we restart the nimbus scheduler';

    // Control at the service layer, since the gates are deliberately unreachable
    // from the tool: without the filter the same pass fills the page, so the
    // short page below is the gate's doing and not a small corpus.
    const ungated = await memory.searchWithAbstention({ query: focus, limit: 5 }, SCOPE_GLOBAL, {
      relativeLevelRatio: null,
    });
    expect(ungated.memories).toHaveLength(5);
    expect(ungated.gateShortened).toBeUndefined();

    const body = payload(await runWithContext(ctx(), () => handlers.context({ focus })));
    expect(body.relevantMemories.map((r) => r.id)).toContain(answer.id);
    expect(body.relevantMemories.length).toBeLessThan(5);
    expect(body.rankedPass).toEqual({ abstained: false, gateShortened: true });
  });

  it('omits the ranked pass when no seed can be derived', async () => {
    memory.save({ type: 'project', title: 'Anything', content: 'anything at all' }, SCOPE_GLOBAL);

    const body = payload(await runWithContext(ctx(), () => handlers.context({})));
    expect(body.relevantMemories).toEqual([]);
    // Absent, not `{ abstained: false }`: no search ran, so there is no verdict.
    expect(body.rankedPass).toBeUndefined();
  });

  it('omits the ranked pass when the entity pre-pass already filled the channel', async () => {
    const path = 'apps/server/src/db/migrate.ts';
    for (let i = 0; i < RELEVANCE_LIMIT; i++) {
      const row = memory.save(
        { type: 'project', title: `Linked ${i}`, content: 'billing invoice reconciliation notes' },
        SCOPE_GLOBAL,
      );
      repos.entities.linkMemory(
        row.id,
        'global',
        null,
        [{ kind: 'path', value: path }],
        new Date(),
      );
    }
    memory.save(
      {
        type: 'project',
        title: 'Scheduler restart runbook',
        content: 'restart the nimbus scheduler by draining the queue first',
      },
      SCOPE_GLOBAL,
    );

    const body = payload(
      await runWithContext(ctx(), () =>
        handlers.context({ focus: `${path} while restarting the nimbus scheduler` }),
      ),
    );
    expect(body.relevantMemories).toHaveLength(RELEVANCE_LIMIT);
    expect(body.relevantMemories.every((r) => r.via === 'entity')).toBe(true);
    expect(body.rankedPass).toBeUndefined();
  });

  it('reports a shortened ranked pass even when the channel came out full', async () => {
    const path = 'apps/server/src/db/migrate.ts';
    for (let i = 0; i < 3; i++) {
      const row = memory.save(
        { type: 'project', title: `Linked ${i}`, content: 'billing invoice reconciliation notes' },
        SCOPE_GLOBAL,
      );
      repos.entities.linkMemory(
        row.id,
        'global',
        null,
        [{ kind: 'path', value: path }],
        new Date(),
      );
    }
    const strong = [0, 1].map((i) =>
      memory.save(
        {
          type: 'project',
          title: `Scheduler restart runbook ${i}`,
          content: 'restart the nimbus scheduler by draining the queue first',
        },
        SCOPE_GLOBAL,
      ),
    );
    for (let i = 0; i < 6; i++)
      memory.save(
        { type: 'project', title: `Filler ${i}`, content: `the nimbus notes row ${i}` },
        SCOPE_GLOBAL,
      );

    const body = payload(
      await runWithContext(ctx(), () =>
        handlers.context({ focus: `${path} how do we restart the nimbus scheduler` }),
      ),
    );
    // The channel is full — 3 entity rows plus the ranked pass's 2 survivors —
    // while the ranked pass's own page of 5 came back short. Both are true at
    // once because the flag describes that pass's page against ITS limit.
    expect(body.relevantMemories).toHaveLength(RELEVANCE_LIMIT);
    expect(
      body.relevantMemories
        .filter((r) => r.via === 'ranked')
        .map((r) => r.id)
        .sort(),
    ).toEqual(strong.map((s) => s.id).sort());
    expect(body.rankedPass).toEqual({ abstained: false, gateShortened: true });
  });
});
