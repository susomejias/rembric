import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { projects } from '../db/schema/projects.js';
import { prompts, type NewPrompt } from '../db/schema/prompts.js';
import { PromptsService } from '../services/prompts.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/db.js';

import { createPromptsRouter } from './prompts.js';
import type { ResolvedSession } from './types.js';

function prompt(overrides: Partial<NewPrompt> & { id: string; content: string }): NewPrompt {
  return {
    title: `prompt ${overrides.id}`,
    createdAt: new Date(1_000),
    ...overrides,
  };
}

describe('prompts dashboard TOTAL meta', () => {
  let t: TestDb;
  let app: Hono;

  beforeEach(() => {
    t = createTestDb();
    const repos = createRepositories(t.handle.db);
    const promptsSvc = new PromptsService(repos, t.handle.db);
    const sessions = new SessionsService(repos, randomBytes(32));
    const tokens = new TokensService(repos);
    const admin = tokens.create({ name: 'admin', scope: '*', projectId: null });
    const created = sessions.create(admin.token.id);
    const session: ResolvedSession = {
      session: created.session,
      sessions,
      tokenId: admin.token.id,
    };

    t.handle.db
      .insert(projects)
      .values({ id: 'p1', slug: 'proj-one', createdAt: new Date(500) })
      .run();

    // 12 non-deleted rows in global scope, 3 project-scoped, 2 soft-deleted —
    // more than PAGE_SIZE (10) so a regression to the slice count would fail.
    const rows: NewPrompt[] = [];
    for (let i = 0; i < 12; i++) rows.push(prompt({ id: `G${i}`, content: `widget ${i}` }));
    for (let i = 0; i < 3; i++)
      rows.push(prompt({ id: `PR${i}`, content: `scoped ${i}`, projectId: 'p1' }));
    for (let i = 0; i < 2; i++)
      rows.push(prompt({ id: `D${i}`, content: `deleted ${i}`, deletedAt: new Date(9_000) }));
    t.handle.db.insert(prompts).values(rows).run();

    app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    app.route('/', createPromptsRouter({ repos, prompts: promptsSvc, sessions }));
  });

  afterEach(() => t.cleanup());

  it('plain list shows the true total (15 non-deleted), not the page slice (10)', async () => {
    const html = await (await app.request('/')).text();
    expect(html).toContain('<b>TOTAL</b> 15');
    expect(html).toContain('<b>SHOWING</b> 10 ROWS');
  });

  it('the total honors the project filter', async () => {
    const html = await (await app.request('/?project=proj-one')).text();
    expect(html).toContain('<b>TOTAL</b> 3');
  });

  it('include_deleted flips the total to the full row count', async () => {
    const html = await (await app.request('/?include_deleted=1')).text();
    expect(html).toContain('<b>TOTAL</b> 17');
  });

  it('a text query renders a lower-bound "+"-suffixed total', async () => {
    const html = await (await app.request('/?q=widget')).text();
    expect(html).toMatch(/<b>TOTAL<\/b> \d+\+/);
  });
});
