import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { memoryRelations } from '../db/schema/memory-relations.js';
import { memory, type NewMemory } from '../db/schema/memory.js';
import { prompts, type NewPrompt } from '../db/schema/prompts.js';
import { tokens } from '../db/schema/tokens.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { deriveTitle, MemoryService } from '../services/memory.js';
import { PromptsService } from '../services/prompts.js';
import { RelationsService } from '../services/relations.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/db.js';

import { PAGE_SIZE } from './components.js';
import { createConsolidationRouter } from './consolidation.js';
import { createJudgmentsRouter } from './judgments.js';
import { createMemoriesRouter } from './memories.js';
import { createPromptsRouter } from './prompts.js';
import { createSessionsRouter } from './sessions.js';
import type { ResolvedSession } from './types.js';

/**
 * Locks the `SHOWING N ROWS` chip to the page-slice size (`PAGE_SIZE`)
 * across every paginated list view, never the `PAGE_SIZE + 1` lookahead row
 * the queries fetch to detect a next page. Regression coverage for the
 * judgments bug where `SHOWING` read `rows.length` (the lookahead-inclusive
 * count) instead of `visible.length`.
 */
const SEEDED = PAGE_SIZE + 2;
describe('SHOWING never exceeds PAGE_SIZE across list views', () => {
  let t: TestDb;
  let repos: Repositories;
  let sessions: SessionsService;
  let session: ResolvedSession;

  beforeEach(() => {
    t = createTestDb();
    repos = createRepositories(t.handle.db);
    sessions = new SessionsService(repos, randomBytes(32));
    const tokensSvc = new TokensService(repos);
    const admin = tokensSvc.create({ name: 'admin', scope: '*' });
    const created = sessions.create(admin.token.id);
    session = { session: created.session, sessions, tokenId: admin.token.id };
  });

  afterEach(() => t.cleanup());

  function appWith(router: Hono): Hono {
    const app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    app.route('/', router);
    return app;
  }

  it(`memories list caps SHOWING at PAGE_SIZE for ${SEEDED} seeded rows`, async () => {
    const memorySvc = new MemoryService(repos, t.handle.db);
    t.handle.db
      .insert(memory)
      .values(
        Array.from({ length: SEEDED }, (_, i) => {
          const content = `widget number ${i}`;
          const row: NewMemory = {
            id: `G${i}`,
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
          return row;
        }),
      )
      .run();
    const app = appWith(createMemoriesRouter({ repos, memory: memorySvc, sessions }));
    const html = await (await app.request('/')).text();
    expect(html).toContain(`<b>SHOWING</b> ${PAGE_SIZE} ROWS`);
    expect(html).not.toContain(`<b>SHOWING</b> ${PAGE_SIZE + 1} ROWS`);
    expect(html).not.toContain(`<b>SHOWING</b> ${SEEDED} ROWS`);
  });

  it(`judgments list caps SHOWING at PAGE_SIZE for ${SEEDED} seeded relations`, async () => {
    t.handle.db
      .insert(tokens)
      .values({ id: 'tk1', name: 'tok', hash: 'h', scope: '*', createdAt: new Date(500) })
      .run();
    t.handle.db
      .insert(memory)
      .values([
        {
          id: 'RS',
          title: deriveTitle('relation source'),
          content: 'relation source',
          scope: 'global',
          projectId: null,
          type: 'project',
          tags: [],
          status: 'active',
          replaces: [],
          createdAt: new Date(1_000),
          lastSeenAt: new Date(1_000),
        },
        {
          id: 'RT',
          title: deriveTitle('relation target'),
          content: 'relation target',
          scope: 'global',
          projectId: null,
          type: 'project',
          tags: [],
          status: 'active',
          replaces: [],
          createdAt: new Date(1_000),
          lastSeenAt: new Date(1_000),
        },
      ])
      .run();
    t.handle.db
      .insert(memoryRelations)
      .values(
        Array.from({ length: SEEDED }, (_, i) => ({
          id: `R${i}`,
          judgmentId: `J${i}`,
          sourceId: 'RS',
          targetId: 'RT',
          relation: null,
          status: 'pending' as const,
          createdAt: new Date(1_000),
        })),
      )
      .run();
    const relationsSvc = new RelationsService(repos, t.handle.db);
    const app = appWith(createJudgmentsRouter({ repos, relations: relationsSvc, sessions }));
    const html = await (await app.request('/')).text();
    expect(html).toContain(`<b>SHOWING</b> ${PAGE_SIZE} ROWS`);
    expect(html).not.toContain(`<b>SHOWING</b> ${PAGE_SIZE + 1} ROWS`);
    expect(html).not.toContain(`<b>SHOWING</b> ${SEEDED} ROWS`);
  });

  it(`prompts list caps SHOWING at PAGE_SIZE for ${SEEDED} seeded rows`, async () => {
    t.handle.db
      .insert(prompts)
      .values(
        Array.from({ length: SEEDED }, (_, i) => {
          const row: NewPrompt = {
            id: `P${i}`,
            title: `prompt ${i}`,
            content: `prompt content ${i}`,
            createdAt: new Date(1_000),
          };
          return row;
        }),
      )
      .run();
    const promptsSvc = new PromptsService(repos, t.handle.db);
    const app = appWith(createPromptsRouter({ repos, prompts: promptsSvc, sessions }));
    const html = await (await app.request('/')).text();
    expect(html).toContain(`<b>SHOWING</b> ${PAGE_SIZE} ROWS`);
    expect(html).not.toContain(`<b>SHOWING</b> ${PAGE_SIZE + 1} ROWS`);
    expect(html).not.toContain(`<b>SHOWING</b> ${SEEDED} ROWS`);
  });

  it(`sessions list caps SHOWING at PAGE_SIZE for ${SEEDED} seeded rows`, async () => {
    t.handle.db
      .insert(tokens)
      .values({ id: 'tk1', name: 'tok', hash: 'h', scope: '*', createdAt: new Date(500) })
      .run();
    t.handle.db
      .insert(agentSessions)
      .values(
        Array.from({ length: SEEDED }, (_, i) => ({
          id: `S${i}`,
          tokenId: 'tk1',
          agent: 'test',
          startedAt: new Date(1_000 + i),
        })),
      )
      .run();
    const agentSessionsSvc = new AgentSessionsService(repos, t.handle.db);
    const app = appWith(createSessionsRouter({ repos, sessions, agentSessions: agentSessionsSvc }));
    const html = await (await app.request('/')).text();
    expect(html).toContain(`${PAGE_SIZE} ROWS`);
    expect(html).not.toContain(`${PAGE_SIZE + 1} ROWS`);
    expect(html).not.toContain(`${SEEDED} ROWS`);
  });

  it(`consolidation runs list caps SHOWING at PAGE_SIZE for ${SEEDED} seeded runs`, async () => {
    for (let i = 0; i < SEEDED; i++) {
      repos.consolidation.insertRun({
        id: `RUN${i}`,
        startedAt: new Date(1_000 + i),
        scope: 'global',
      });
    }
    const app = appWith(
      createConsolidationRouter({
        repos,
        sessions,
        triggerSweep: () => {
          throw new Error('not exercised');
        },
        undoRun: () => {
          throw new Error('not exercised');
        },
        undoOp: () => {
          throw new Error('not exercised');
        },
      }),
    );
    const html = await (await app.request('/')).text();
    expect(html).toContain(`${PAGE_SIZE} ROWS`);
    expect(html).not.toContain(`${PAGE_SIZE + 1} ROWS`);
    expect(html).not.toContain(`${SEEDED} ROWS`);
  });
});
