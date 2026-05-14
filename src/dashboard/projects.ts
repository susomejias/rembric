import { Hono, type Context } from 'hono';

import { DomainError } from '../services/errors.js';
import { SLUG_REGEX, type ProjectsService } from '../services/projects.js';
import type { SessionsService } from '../services/sessions.js';

import { readFormAndVerifyCsrf, csrfInput } from './csrf.js';
import { formatTs, html, raw, shell, shortId } from './templates.js';
import type { ResolvedSession } from './types.js';

export interface ProjectsDeps {
  projects: ProjectsService;
  sessions: SessionsService;
}

function getSession(c: Context): ResolvedSession | null {
  return (c.get('session') as ResolvedSession | undefined) ?? null;
}

export function createProjectsRouter(deps: ProjectsDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const active = deps.projects.list();
    const archived = deps.projects.listArchived();

    const renderRow = (p: {
      id: string;
      slug: string;
      displayName: string | null;
      archivedAt: Date | null;
      createdAt: Date;
    }) => {
      const isLegacy = !SLUG_REGEX.test(p.slug);
      return html`
        <tr>
          <td>${p.displayName ?? p.slug}</td>
          <td class="mono">
            ${p.slug} ${isLegacy ? raw(' <span class="pill superseded">legacy</span>') : raw('')}
          </td>
          <td class="muted small">${shortId(p.id)}</td>
          <td class="muted">${formatTs(p.createdAt)}</td>
          <td>
            <form action="/dashboard/projects/${p.id}/rename" method="post" class="inline">
              ${csrfInput(session.session, deps.sessions, 'project.rename')}
              <input
                type="text"
                name="displayName"
                placeholder="display name"
                value="${p.displayName ?? ''}"
                style="max-width:14ch"
              />
              <button type="submit">Rename</button>
            </form>
            ${p.archivedAt
              ? html`
                  <form action="/dashboard/projects/${p.id}/unarchive" method="post" class="inline">
                    ${csrfInput(session.session, deps.sessions, 'project.unarchive')}
                    <button type="submit">Unarchive</button>
                  </form>
                `
              : html`
                  <form action="/dashboard/projects/${p.id}/archive" method="post" class="inline">
                    ${csrfInput(session.session, deps.sessions, 'project.archive')}
                    <button class="warn" type="submit">Archive</button>
                  </form>
                `}
          </td>
        </tr>
      `;
    };

    const body = html`
      <h1>Projects</h1>
      <p class="small muted">
        A project is identified by its slug (the value passed via
        <code>/mcp/&lt;slug&gt;</code> or <code>project.use({slug})</code>). New slugs must match
        <code>[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?</code>. Legacy slugs (from v0.1) keep working but
        are flagged. The display name is cosmetic.
      </p>

      <h2>Active (${active.length})</h2>
      ${active.length === 0
        ? html`<p class="muted">No active projects.</p>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>name</th>
                  <th>slug</th>
                  <th>id</th>
                  <th>created</th>
                  <th>actions</th>
                </tr>
              </thead>
              <tbody>
                ${active.map(renderRow)}
              </tbody>
            </table>
          `}
      ${archived.length === 0
        ? raw('')
        : html`
            <h2>Archived (${archived.length})</h2>
            <table>
              <thead>
                <tr>
                  <th>name</th>
                  <th>slug</th>
                  <th>id</th>
                  <th>created</th>
                  <th>actions</th>
                </tr>
              </thead>
              <tbody>
                ${archived.map(renderRow)}
              </tbody>
            </table>
          `}
    `;
    return c.html(shell(body, { title: 'Projects', activeNav: 'projects' }));
  });

  app.post('/:id/archive', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'project.archive');
    if (form instanceof Response) return form;
    try {
      deps.projects.archive(c.req.param('id'));
    } catch (err) {
      if (err instanceof DomainError) {
        return errorResponse(c, err.message);
      }
      throw err;
    }
    return c.redirect('/dashboard/projects');
  });

  app.post('/:id/unarchive', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(
      c,
      session.session,
      deps.sessions,
      'project.unarchive',
    );
    if (form instanceof Response) return form;
    try {
      deps.projects.unarchive(c.req.param('id'));
    } catch (err) {
      if (err instanceof DomainError) {
        return errorResponse(c, err.message);
      }
      throw err;
    }
    return c.redirect('/dashboard/projects');
  });

  app.post('/:id/rename', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'project.rename');
    if (form instanceof Response) return form;
    const raw = form.get('displayName');
    const displayName = (typeof raw === 'string' ? raw : '').trim();
    if (!displayName) {
      return errorResponse(c, 'Display name is required.');
    }
    try {
      deps.projects.rename(c.req.param('id'), displayName);
    } catch (err) {
      if (err instanceof DomainError) {
        return errorResponse(c, err.message);
      }
      throw err;
    }
    return c.redirect('/dashboard/projects');
  });

  return app;
}

function errorResponse(c: Context, message: string): Response {
  return c.html(
    shell(html`<p class="flash error">${message}</p>`, {
      title: 'Projects',
      activeNav: 'projects',
    }),
    400,
  );
}
