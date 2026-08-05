import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { memory, type NewMemory } from '../db/schema/memory.js';
import { deriveTitle, MemoryService } from '../services/memory.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/db.js';

import { PAGE_SIZE } from './components.js';
import { createMemoriesRouter } from './memories.js';
import type { ResolvedSession } from './types.js';

const SEEDED = PAGE_SIZE + 2;

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
    const tokens = new TokensService(repos, t.handle.db);
    const admin = tokens.create({ name: 'admin', scope: '*' });
    const created = sessions.create(admin.token.id);
    const session: ResolvedSession = {
      session: created.session,
      sessions,
      tokenId: admin.token.id,
    };

    // More active rows than PAGE_SIZE.
    t.handle.db
      .insert(memory)
      .values(Array.from({ length: SEEDED }, (_, i) => widget(`G${i}`)))
      .run();

    app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    app.route('/', createMemoriesRouter({ repos, memory: memorySvc, sessions }));
  });

  afterEach(() => t.cleanup());

  it(`plain list shows the true total (${SEEDED}), not the page slice (${PAGE_SIZE})`, async () => {
    const html = await (await app.request('/')).text();
    expect(html).toContain(`<b>TOTAL</b> ${SEEDED}`);
    expect(html).toContain(`<b>SHOWING</b> ${PAGE_SIZE} ROWS`);
  });

  it('the MEMORIES sidebar entry carries a needs-review badge reflecting the seeded rows', async () => {
    // Every seeded row is ancient, typed 'project', never confirmed → all need review.
    const html = await (await app.request('/')).text();
    expect(html).toMatch(
      new RegExp(`href="/dashboard/memories"[\\s\\S]*?<span class="badge">${SEEDED}</span>`),
    );
  });

  it('needs_review + query renders a +-suffixed lower-bound total', async () => {
    const html = await (await app.request('/?review=needs_review&q=widget')).text();
    expect(html).toContain(`<b>TOTAL</b> ${PAGE_SIZE}+`);
  });

  it(`FTS search total honours the (default active) status filter, not the raw match count`, async () => {
    // Two non-active 'widget' matches: filtered in SQL, so TOTAL stays SEEDED.
    t.handle.db
      .insert(memory)
      .values([
        { ...widget('WSUP'), status: 'superseded' },
        { ...widget('WARC'), status: 'archived' },
      ])
      .run();
    const html = await (await app.request('/?q=widget')).text();
    expect(html).toContain(`<b>TOTAL</b> ${SEEDED}`);
    expect(html).not.toContain(`<b>TOTAL</b> ${SEEDED + 2}`);
  });

  it('the filter form is HTMX-enhanced to swap #memories-list without a full page reload', async () => {
    const html = await (await app.request('/')).text();
    expect(html).toContain('hx-get="/dashboard/memories"');
    expect(html).toContain('hx-target="#memories-list"');
    expect(html).toContain('hx-select="#memories-list"');
    expect(html).toContain('hx-push-url="true"');
    expect(html).toContain('id="memories-list"');
    expect(html).toContain('id="memories-meta" hx-swap-oob="true"');
  });

  it('an unresolvable project slug yields an empty list, not every scope', async () => {
    const html = await (await app.request('/?project=no-such-slug')).text();
    expect(html).toContain('<b>TOTAL</b> 0');
    expect(html).toContain('No memories match this filter.');
    expect(html).not.toContain('widget number');
  });
});
