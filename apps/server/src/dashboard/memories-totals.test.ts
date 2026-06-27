import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { memory, type NewMemory } from '../db/schema/memory.js';
import { deriveTitle, MemoryService } from '../services/memory.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/db.js';

import { createMemoriesRouter } from './memories.js';
import type { ResolvedSession } from './types.js';

function widget(id: string): NewMemory {
  return {
    id,
    title: deriveTitle(`widget number ${id}`),
    content: `widget number ${id}`,
    scope: 'global',
    projectId: null,
    type: 'project',
    tags: [],
    status: 'active',
    replaces: [],
    // Ancient so every row is past its review TTL (type 'project' has one).
    createdAt: new Date(1_000),
    lastSeenAt: new Date(1_000),
  };
}

describe('memories dashboard TOTAL meta', () => {
  let t: TestDb;
  let app: Hono;

  beforeEach(() => {
    t = createTestDb();
    const repos = createRepositories(t.handle.db);
    const memorySvc = new MemoryService(repos, t.handle.db);
    const sessions = new SessionsService(repos, randomBytes(32));
    const tokens = new TokensService(repos);
    const admin = tokens.create({ name: 'admin', scope: '*', projectId: null });
    const created = sessions.create(admin.token.id);
    const session: ResolvedSession = {
      session: created.session,
      sessions,
      tokenId: admin.token.id,
    };

    // 12 active rows — more than PAGE_SIZE (10).
    t.handle.db
      .insert(memory)
      .values(Array.from({ length: 12 }, (_, i) => widget(`G${i}`)))
      .run();

    app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    app.route('/', createMemoriesRouter({ repos, memory: memorySvc, sessions }));
  });

  afterEach(() => t.cleanup());

  it('plain list shows the true total (12), not the page slice (10)', async () => {
    const html = await (await app.request('/')).text();
    expect(html).toContain('<b>TOTAL</b> 12');
    expect(html).toContain('<b>SHOWING</b> 10 ROWS');
  });

  it('needs_review + query renders a +-suffixed lower-bound total', async () => {
    const html = await (await app.request('/?review=needs_review&q=widget')).text();
    expect(html).toContain('<b>TOTAL</b> 10+');
  });
});
