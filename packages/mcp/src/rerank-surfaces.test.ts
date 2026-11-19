import {
  AgentSessionsService,
  MemoryService,
  ProjectsService,
  PromptsService,
  RelationsService,
  runWithContext,
  type RequestContext,
  type RerankFn,
} from '@rembric/core';
import { createRepositories, type Repositories, type Scope, type Token } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildMemoryHandlers } from '@rembric/mcp';

import {
  createTestDb,
  defaultProjectScope,
  mintTestToken,
  type TestDb,
} from './test-support/index.js';
import { logInternalError } from './test-support/test-logger.js';

let db: TestDb;
let scope: Scope;
let repos: Repositories;
let memory: MemoryService;
let rerank: ReturnType<typeof vi.fn<RerankFn>>;
let handlers: ReturnType<typeof buildMemoryHandlers>;
let token: Token;

const ctx = (): RequestContext => ({
  token,
  scope: '*',
  memberProjectIds: [],
  project: null,
  requestedSlug: null,
});

beforeEach(() => {
  db = createTestDb();
  scope = defaultProjectScope(db.handle);
  repos = createRepositories(db.handle.db);
  rerank = vi.fn<RerankFn>((_q, docs) => Promise.resolve(docs.map(() => 0.5)));
  memory = new MemoryService(repos, db.handle.db, undefined, undefined, rerank);
  token = mintTestToken(db.handle, { scope: '*' }).token;
  handlers = buildMemoryHandlers({
    logInternalError,
    repos,
    memory,
    projects: new ProjectsService(repos),
    agentSessions: new AgentSessionsService(repos, db.handle.db),
    prompts: new PromptsService(repos, db.handle.db),
    relations: new RelationsService(repos, db.handle.db),
    orphanAfterMs: 86_400_000,
  });
  memory.save(
    { type: 'project', title: 'Scheduler port', content: 'the scheduler listens on port 8781' },
    scope,
  );
});

afterEach(() => db.cleanup());

describe('which surfaces request reranking', () => {
  it('memory.search requests it', async () => {
    await runWithContext(ctx(), () => handlers.search({ query: 'scheduler port' }));
    expect(rerank).toHaveBeenCalledTimes(1);
  });

  it('the ranked pass of memory.context requests it', async () => {
    await runWithContext(ctx(), () => handlers.context({ focus: 'scheduler port' }));
    expect(rerank).toHaveBeenCalledTimes(1);
  });

  it('a plain service search, the path the per-turn recall endpoint takes, does not', async () => {
    await memory.search({ query: 'scheduler port', limit: 5 }, scope);
    expect(rerank).not.toHaveBeenCalled();
  });
});
