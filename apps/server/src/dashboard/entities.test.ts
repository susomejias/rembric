import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { projects } from '../db/schema/projects.js';
import { EntityBackfillWorker } from '../services/entity-backfill-worker.js';
import { MemoryService } from '../services/memory.js';
import { SCOPE_GLOBAL, projectScope } from '../services/scope.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/db.js';
import { extractCsrf } from '../test/forms.js';

import { createEntitiesRouter } from './entities.js';
import type { ResolvedSession } from './types.js';

describe('dashboard entities view', () => {
  let t: TestDb;
  let repos: Repositories;
  let sessions: SessionsService;
  let tokensSvc: TokensService;
  let memory: MemoryService;
  let entityBackfillWorker: EntityBackfillWorker;

  function appWithSession(session: ResolvedSession): Hono {
    const app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    app.route(
      '/',
      createEntitiesRouter({ repos, sessions, tokens: tokensSvc, entityBackfillWorker }),
    );
    return app;
  }

  function sessionFor(scope: '*' | 'read:*'): ResolvedSession {
    const token = tokensSvc.create({ name: 'test', scope });
    const created = sessions.create(token.token.id);
    return { session: created.session, sessions, tokenId: token.token.id };
  }

  beforeEach(() => {
    t = createTestDb();
    repos = createRepositories(t.handle.db);
    sessions = new SessionsService(repos, randomBytes(32));
    tokensSvc = new TokensService(repos, t.handle.db);
    memory = new MemoryService(repos, t.handle.db);
    entityBackfillWorker = new EntityBackfillWorker({ repos, tx: t.handle.db });
  });

  afterEach(() => t.cleanup());

  it('lists entities across kinds with their link counts', async () => {
    const a = memory.save(
      { type: 'project', title: 'Fix', content: 'fixed apps/server/src/db/migrate.ts' },
      SCOPE_GLOBAL,
    );
    repos.entities.linkMemory(
      a.id,
      'global',
      null,
      [{ kind: 'path', value: 'apps/server/src/db/migrate.ts' }],
      new Date(),
    );

    const app = appWithSession(sessionFor('*'));
    const html = await (await app.request('/')).text();
    expect(html).toContain('apps/server/src/db/migrate.ts');
    expect(html).toContain('PATH');
  });

  it('filters by kind', async () => {
    const a = memory.save({ type: 'project', title: 'A', content: 'a' }, SCOPE_GLOBAL);
    const b = memory.save({ type: 'project', title: 'B', content: 'b' }, SCOPE_GLOBAL);
    repos.entities.linkMemory(a.id, 'global', null, [{ kind: 'path', value: 'a.ts' }], new Date());
    repos.entities.linkMemory(
      b.id,
      'global',
      null,
      [{ kind: 'error_code', value: 'ENOENT' }],
      new Date(),
    );

    const app = appWithSession(sessionFor('*'));
    const html = await (await app.request('/?kind=error_code')).text();
    expect(html).toContain('ENOENT');
    expect(html).not.toContain('a.ts');
  });

  it('single-reference filter shows only entities mentioned by exactly one memory', async () => {
    const a = memory.save({ type: 'project', title: 'A', content: 'a' }, SCOPE_GLOBAL);
    const b = memory.save({ type: 'project', title: 'B', content: 'b' }, SCOPE_GLOBAL);
    const c = memory.save({ type: 'project', title: 'C', content: 'c' }, SCOPE_GLOBAL);
    repos.entities.linkMemory(
      a.id,
      'global',
      null,
      [{ kind: 'path', value: 'common.ts' }],
      new Date(),
    );
    repos.entities.linkMemory(
      b.id,
      'global',
      null,
      [{ kind: 'path', value: 'common.ts' }],
      new Date(),
    );
    repos.entities.linkMemory(
      c.id,
      'global',
      null,
      [{ kind: 'path', value: 'rare.ts' }],
      new Date(),
    );

    const app = appWithSession(sessionFor('*'));
    const html = await (await app.request('/?single_ref=1')).text();
    expect(html).toContain('rare.ts');
    expect(html).not.toContain('common.ts');
  });

  it('the view is scope-isolated per its own scoped rows, distinctly labeled global vs project', async () => {
    const projectId = 'p1';
    t.handle.db
      .insert(projects)
      .values({ id: projectId, slug: 'demo', createdAt: new Date() })
      .run();
    const g = memory.save({ type: 'project', title: 'G', content: 'g' }, SCOPE_GLOBAL);
    const p = memory.save({ type: 'project', title: 'P', content: 'p' }, projectScope(projectId));
    repos.entities.linkMemory(
      g.id,
      'global',
      null,
      [{ kind: 'path', value: 'global-only.ts' }],
      new Date(),
    );
    repos.entities.linkMemory(
      p.id,
      'project',
      projectId,
      [{ kind: 'path', value: 'project-only.ts' }],
      new Date(),
    );

    const app = appWithSession(sessionFor('*'));
    const html = await (await app.request('/')).text();
    expect(html).toContain('global-only.ts');
    expect(html).toContain('project-only.ts');
    expect(html).toContain('demo');
  });

  it('shows the rebuild action without a pending count once everything is scanned', async () => {
    const m = memory.save({ type: 'project', title: 'A', content: 'apps/a.ts' }, SCOPE_GLOBAL);
    repos.entities.linkMemory(
      m.id,
      'global',
      null,
      [{ kind: 'path', value: 'apps/a.ts' }],
      new Date(),
    );
    const app = appWithSession(sessionFor('*'));
    const html = await (await app.request('/')).text();
    expect(html).toContain('REBUILD ENTITY INDEX');
    expect(html).not.toContain('PENDING');
  });

  it('shows the rebuild action with a pending count while a backlog exists', async () => {
    memory.save({ type: 'project', title: 'A', content: 'apps/a.ts' }, SCOPE_GLOBAL);
    const app = appWithSession(sessionFor('*'));
    const html = await (await app.request('/')).text();
    expect(html).toContain('REBUILD ENTITY INDEX (1 PENDING)');
    expect(html).toContain('data-confirm-tone="warn"');
  });

  it('POST /rebuild truncates and re-scans, redirecting with a count', async () => {
    const m = memory.save(
      { type: 'project', title: 'Fix', content: 'fixed apps/server/src/db/migrate.ts' },
      SCOPE_GLOBAL,
    );
    // Simulate a stale/incorrect link that a rebuild should replace.
    repos.entities.linkMemory(
      m.id,
      'global',
      null,
      [{ kind: 'path', value: 'stale-wrong-value.ts' }],
      new Date(),
    );

    const app = appWithSession(sessionFor('*'));
    const before = await (await app.request('/')).text();
    const csrf = extractCsrf(before, '/dashboard/entities/rebuild');

    const res = await app.request('/rebuild', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/\/dashboard\/entities\?rebuilt=\d+/);

    const linked = repos.entities.findEntitiesForMemory(m.id);
    expect(linked.map((e) => e.value)).toEqual(['apps/server/src/db/migrate.ts']);
  });

  it('POST /rebuild drives the shared, live worker instance rather than a disposable one (regression)', async () => {
    // A throwaway worker instance wouldn't leave the LIVE singleton's
    // possiblyPending state updated, so the regular periodic tick would
    // stay silent about any backlog left over from a large rebuild until
    // the hourly forced fallback. Spying on the exact instance held by
    // this test proves the handler drives that instance, not a fresh one.
    const spy = vi.spyOn(entityBackfillWorker, 'processBatch');
    memory.save({ type: 'project', title: 'A', content: 'apps/a.ts' }, SCOPE_GLOBAL);

    const app = appWithSession(sessionFor('*'));
    const before = await (await app.request('/')).text();
    const csrf = extractCsrf(before, '/dashboard/entities/rebuild');
    await app.request('/rebuild', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString(),
    });

    expect(spy).toHaveBeenCalled();
  });

  it('POST /rebuild is forbidden for a non-admin (read:*) token', async () => {
    memory.save({ type: 'project', title: 'A', content: 'apps/a.ts' }, SCOPE_GLOBAL);
    const app = appWithSession(sessionFor('read:*'));
    const res = await app.request('/rebuild', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'irrelevant' }).toString(),
    });
    expect(res.status).toBe(403);
  });
});
