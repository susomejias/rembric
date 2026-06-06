import { Hono, type Context } from 'hono';

import { DomainError } from '../services/errors.js';
import { SLUG_REGEX, type ProjectsService } from '../services/projects.js';
import type { SessionsService } from '../services/sessions.js';

import { viewHead } from './components.js';
import { readFormAndVerifyCsrf, csrfInput } from './csrf.js';
import { renderPage } from './page-shell.js';
import { formatTs, html, raw } from './templates.js';
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

    const url = new URL(c.req.url);
    const justCreated = url.searchParams.get('created');
    const errorMessage = url.searchParams.get('error');

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
          <td class="muted">${formatTs(p.createdAt)}</td>
          <td class="project-actions">
            <form action="/dashboard/projects/${p.id}/rename" method="post" class="rename-form">
              ${csrfInput(session.session, deps.sessions, 'project.rename')}
              <input
                type="text"
                name="displayName"
                placeholder="display name"
                value="${p.displayName ?? ''}"
              />
              <button type="submit">RENAME</button>
            </form>
            ${p.archivedAt
              ? html`
                  <form action="/dashboard/projects/${p.id}/unarchive" method="post" class="inline">
                    ${csrfInput(session.session, deps.sessions, 'project.unarchive')}
                    <button type="submit">UNARCHIVE</button>
                  </form>
                `
              : html`
                  <form
                    action="/dashboard/projects/${p.id}/archive"
                    method="post"
                    class="inline"
                    data-confirm='Archive project "${p.displayName ??
                    p.slug}"? New writes will be rejected; existing memories stay queryable. You can unarchive later.'
                    data-confirm-label="ARCHIVE PROJECT"
                    data-confirm-tone="warn"
                  >
                    ${csrfInput(session.session, deps.sessions, 'project.archive')}
                    <button class="warn" type="submit">ARCHIVE</button>
                  </form>
                `}
          </td>
        </tr>
      `;
    };

    const body = html`
      ${viewHead({
        num: '06',
        title: 'Rembric Projects.',
        hl: 'Rembric',
        meta: [
          { k: 'ACTIVE', v: String(active.length) },
          { k: 'ARCHIVED', v: String(archived.length) },
        ],
      })}
      <p class="small muted">
        A project is identified by its slug (the value passed via
        <code>/mcp/&lt;slug&gt;</code> or <code>project.use({slug})</code>).
      </p>

      ${justCreated
        ? html`<p class="flash success">Created project <code>${justCreated}</code>.</p>`
        : raw('')}
      ${errorMessage ? html`<p class="flash error">${errorMessage}</p>` : raw('')}

      <form action="/dashboard/projects/create" method="post" class="create-project">
        ${csrfInput(session.session, deps.sessions, 'project.create')}
        <input
          type="text"
          name="slug"
          placeholder="my-project"
          pattern="[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?"
          required
        />
        <input type="text" name="displayName" placeholder="display name (optional)" />
        <button class="primary" type="submit">Create project</button>
      </form>

      <h2>Active (${active.length})</h2>
      ${active.length === 0
        ? html`<p class="muted">No active projects.</p>`
        : html`
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>name</th>
                    <th>slug</th>
                    <th>created</th>
                    <th>actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${active.map(renderRow)}
                </tbody>
              </table>
            </div>
          `}
      ${archived.length === 0
        ? raw('')
        : html`
            <h2>Archived (${archived.length})</h2>
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>name</th>
                    <th>slug</th>
                    <th>created</th>
                    <th>actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${archived.map(renderRow)}
                </tbody>
              </table>
            </div>
          `}
    `;
    return c.html(renderPage(c, deps.sessions, body, { title: 'Projects', activeNav: 'projects' }));
  });

  app.post('/create', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'project.create');
    if (form instanceof Response) return form;
    const rawSlug = form.get('slug');
    const rawDisplay = form.get('displayName');
    const slug = (typeof rawSlug === 'string' ? rawSlug : '').trim();
    const displayNameInput = (typeof rawDisplay === 'string' ? rawDisplay : '').trim();
    const displayName = displayNameInput.length > 0 ? displayNameInput : null;
    if (!slug) {
      return c.redirect(`/dashboard/projects?error=${encodeURIComponent('Slug is required.')}`);
    }
    try {
      const project = deps.projects.create({ slug, displayName });
      return c.redirect(`/dashboard/projects?created=${encodeURIComponent(project.slug)}`);
    } catch (err) {
      if (err instanceof DomainError) {
        return c.redirect(`/dashboard/projects?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
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
        return errorResponse(c, deps.sessions, err.message);
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
        return errorResponse(c, deps.sessions, err.message);
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
      return errorResponse(c, deps.sessions, 'Display name is required.');
    }
    try {
      deps.projects.rename(c.req.param('id'), displayName);
    } catch (err) {
      if (err instanceof DomainError) {
        return errorResponse(c, deps.sessions, err.message);
      }
      throw err;
    }
    return c.redirect('/dashboard/projects');
  });

  return app;
}

function errorResponse(c: Context, sessions: SessionsService, message: string): Response {
  return c.html(
    renderPage(c, sessions, html`<p class="flash error">${message}</p>`, {
      title: 'Projects',
      activeNav: 'projects',
    }),
    400,
  );
}
