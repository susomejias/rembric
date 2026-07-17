import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { MemoryService } from '../services/memory.js';
import { PromptsService } from '../services/prompts.js';
import { SCOPE_GLOBAL } from '../services/scope.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/db.js';

import { createMemoriesRouter } from './memories.js';
import { createPromptsRouter } from './prompts.js';
import type { ResolvedSession } from './types.js';

/**
 * 0258 — the dashboard SEARCH box passed the operator's raw text straight
 * to `... MATCH ?`; ordinary punctuation ("what's the plan?",
 * "docker-compose") raised an FTS5 syntax error and 500'd the page.
 */
describe('dashboard FTS search robustness (#258)', () => {
  let t: TestDb;
  let session: ResolvedSession;

  beforeEach(() => {
    t = createTestDb();
    const repos = createRepositories(t.handle.db);
    const sessions = new SessionsService(repos, randomBytes(32));
    const tokensSvc = new TokensService(repos);
    const admin = tokensSvc.create({ name: 'admin', scope: '*', projectId: null });
    const created = sessions.create(admin.token.id);
    session = { session: created.session, sessions, tokenId: admin.token.id };

    new MemoryService(repos, t.handle.db).save(
      { type: 'project', title: 'deploy plan', content: 'deploy via docker-compose' },
      SCOPE_GLOBAL,
    );
    new PromptsService(repos, t.handle.db).save({
      content: "what's the deploy plan?",
      title: 'plan',
    });
  });

  afterEach(() => t.cleanup());

  function wrap(app: Hono): Hono {
    const wrapped = new Hono();
    wrapped.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    wrapped.route('/', app);
    return wrapped;
  }

  it('memories search box does not 500 on punctuation and redisplays the raw query', async () => {
    const repos = createRepositories(t.handle.db);
    const memory = new MemoryService(repos, t.handle.db);
    const sessionsSvc = new SessionsService(repos, randomBytes(32));
    const app = wrap(createMemoriesRouter({ repos, memory, sessions: sessionsSvc }));

    const res = await app.request('/?q=' + encodeURIComponent('docker-compose?'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('docker-compose?'); // redisplayed as typed, not the sanitized MATCH form
  });

  it('memories search box finds a match despite the punctuation', async () => {
    const repos = createRepositories(t.handle.db);
    const memory = new MemoryService(repos, t.handle.db);
    const sessionsSvc = new SessionsService(repos, randomBytes(32));
    const app = wrap(createMemoriesRouter({ repos, memory, sessions: sessionsSvc }));

    const res = await app.request('/?q=' + encodeURIComponent('deploy plan'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('deploy plan');
  });

  it('prompts search box does not 500 on an apostrophe/question mark and redisplays the raw query', async () => {
    const repos = createRepositories(t.handle.db);
    const promptsSvc = new PromptsService(repos, t.handle.db);
    const sessionsSvc = new SessionsService(repos, randomBytes(32));
    const app = wrap(createPromptsRouter({ repos, prompts: promptsSvc, sessions: sessionsSvc }));

    const res = await app.request('/?q=' + encodeURIComponent("what's the plan?"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('what&#39;s the plan?');
  });
});
