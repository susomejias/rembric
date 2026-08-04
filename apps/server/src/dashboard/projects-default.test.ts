import { randomBytes } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { ProjectsService } from '../services/projects.js';
import { SessionsService } from '../services/sessions.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, defaultProject, type TestDb } from '../test/index.js';

import { createProjectsRouter } from './projects.js';
import type { ResolvedSession } from './types.js';

/**
 * The `default` marker is the only operator-facing signal distinguishing the
 * system default from a same-named project, so it is asserted rather than
 * merely rendered — and asserted against the boolean, since the slug is not
 * the identity.
 */
describe('the projects list marks the system default', () => {
  let t: TestDb;
  let app: Hono;
  let projects: ProjectsService;

  beforeEach(() => {
    t = createTestDb();
    const repos = createRepositories(t.handle.db);
    projects = new ProjectsService(repos);
    const sessions = new SessionsService(repos, randomBytes(32));
    const admin = new TokensService(repos).create({ name: 'admin', scope: '*' });
    const created = sessions.create(admin.token.id);
    const session: ResolvedSession = {
      session: created.session,
      sessions,
      tokenId: admin.token.id,
    };
    app = new Hono();
    app.use('*', (c: Context, next: Next) => {
      c.set('session' as never, session as never);
      return next();
    });
    app.route('/', createProjectsRouter({ projects, sessions }));
  });

  afterEach(() => t.cleanup());

  /** One row's markup, keyed on the project id its own forms carry. */
  function row(html: string, projectId: string): string {
    const found = html
      .split('<tr>')
      .find((chunk) => chunk.includes(`/dashboard/projects/${projectId}/rename`));
    expect(found).toBeDefined();
    return found!;
  }

  function markerRows(html: string): number {
    return html.split('pill default">default</span>').length - 1;
  }

  it('renders the marker on the is_default row and on no other', async () => {
    const own = projects.create({ slug: 'default-2', displayName: 'default' });
    const system = defaultProject(t.handle);

    const html = await (await app.request('/')).text();

    expect(markerRows(html)).toBe(1);
    expect(row(html, system.id)).toContain('pill default');
    expect(row(html, own.id)).not.toContain('pill default');
  });

  it('follows the column, not the spelling, when the marker moves', async () => {
    const own = projects.create({ slug: 'default-2', displayName: 'operator project' });
    const system = defaultProject(t.handle);
    // The partial UNIQUE index admits one flagged row, so clear before setting.
    t.handle.raw.prepare('UPDATE projects SET is_default = 0 WHERE id = ?').run(system.id);
    t.handle.raw.prepare('UPDATE projects SET is_default = 1 WHERE id = ?').run(own.id);

    const html = await (await app.request('/')).text();

    expect(markerRows(html)).toBe(1);
    expect(row(html, own.id)).toContain('pill default');
    // Still spelled `default`, no longer the default: a slug-keyed template fails here.
    expect(system.slug).toBe('default');
    expect(row(html, system.id)).not.toContain('pill default');
  });

  it('renames the default project and keeps both its slug and its marker', async () => {
    const system = defaultProject(t.handle);
    const renamed = projects.rename(system.id, 'billing invoice reconciliation');

    expect(renamed.slug).toBe(system.slug);
    expect(renamed.isDefault).toBe(true);
    expect(renamed.displayName).toBe('billing invoice reconciliation');

    const html = await (await app.request('/')).text();
    expect(markerRows(html)).toBe(1);
    expect(row(html, system.id)).toContain('billing invoice reconciliation');
    expect(row(html, system.id)).toContain('pill default');
  });

  it('offers no archive control for the default project, and still offers one for every other', async () => {
    const own = projects.create({ slug: 'alpha' });
    const system = defaultProject(t.handle);

    const html = await (await app.request('/')).text();

    expect(html).toContain(`/dashboard/projects/${own.id}/archive`);
    expect(html).not.toContain(`/dashboard/projects/${system.id}/archive`);
  });
});
