import { Hono } from 'hono';

import type { Project } from '../db/schema/projects.js';
import { DomainError } from '../services/errors.js';
import type { ProjectsService } from '../services/projects.js';
import type { SessionsService } from '../services/sessions.js';
import { pinnedProjectId, type TokensService, type TokenScope } from '../services/tokens.js';

import { flashErrorPage, getSession, tblEmpty, viewHead } from './components.js';
import { readFormAndVerifyCsrf, csrfInput } from './csrf.js';
import { renderPage } from './page-shell.js';
import { escape, formatTs, html, raw, type SafeHtml } from './templates.js';

export interface TokensDeps {
  tokens: TokensService;
  projects: ProjectsService;
  sessions: SessionsService;
}

export function createTokensRouter(deps: TokensDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const params = new URL(c.req.url).searchParams;
    const justCreated = params.get('created');
    const tokens = deps.tokens.list();
    const now = Date.now();

    // Archived included: a token pinned to an archived project keeps
    // authorizing, so hiding the slug would misreport what it reaches.
    const projects = deps.projects.list(true);
    const slugById = new Map(projects.map((p) => [p.id, p.slug]));

    const unresolvable = (scope: TokenScope): boolean => {
      const pinned = pinnedProjectId(scope);
      return pinned !== null && !slugById.has(pinned);
    };

    const stateOf = (t: (typeof tokens)[number]): { label: string; cls: string } => {
      if (t.revokedAt) return { label: 'revoked', cls: 'archived' };
      if (t.expiresAt && t.expiresAt.getTime() <= now) return { label: 'expired', cls: 'archived' };
      if (unresolvable(t.scope as TokenScope)) return { label: 'inert', cls: 'legacy' };
      return { label: 'active', cls: 'active' };
    };

    const rows = tokens.map((t) => {
      const s = stateOf(t);
      const slug = t.projectId === null ? null : (slugById.get(t.projectId) ?? null);
      return html`
        <tr>
          <td>${t.name}</td>
          <td class="mono small">${scopeBadge(t.scope as TokenScope)}</td>
          <td>${slug ?? raw('<span class="muted">—</span>')}</td>
          <td class="muted">${formatTs(t.createdAt)}</td>
          <td class="muted">${formatTs(t.expiresAt)}</td>
          <td><span class="pill ${s.cls}">${s.label}</span></td>
          <td>
            ${t.revokedAt
              ? raw('<span class="muted small">—</span>')
              : html`
                  <form
                    action="/dashboard/tokens/${t.name}/revoke"
                    method="post"
                    class="inline"
                    data-confirm='Revoke token "${t.name}"? This is IRREVERSIBLE. Any agent using this token will lose access immediately.'
                    data-confirm-label="REVOKE TOKEN"
                    data-confirm-tone="danger"
                  >
                    ${csrfInput(session.session, deps.sessions, 'token.revoke')}
                    <button class="danger" type="submit">Revoke</button>
                  </form>
                `}
          </td>
        </tr>
      `;
    });

    const selectable = projects.filter((p) => !p.archivedAt);

    // Read back off the persisted row, not off the query string: the panel
    // states what was minted, not what the caller asked for.
    const mintedName = params.get('name');
    const minted = mintedName === null ? undefined : tokens.find((t) => t.name === mintedName);
    const mintedSlug = minted?.projectId == null ? null : (slugById.get(minted.projectId) ?? null);

    const oneShot = justCreated
      ? html`
          <div class="one-shot">
            <strong>New token created.</strong>
            This is the only time the plaintext is shown — copy it now:
            <pre>${justCreated}</pre>
            ${minted
              ? html`
                  <p class="small">
                    Scope <code>${minted.scope}</code> —
                    ${mintedSlug
                      ? html`bound to project <strong>${mintedSlug}</strong>.`
                      : raw('bound to no project.')}
                  </p>
                `
              : raw('')}
            <p class="small">
              Paste into your agent's MCP config under
              <code>headers.Authorization: "Bearer ${justCreated.slice(0, 6)}…"</code>.
            </p>
          </div>
        `
      : raw('');

    const body = html`
      ${viewHead({
        num: '07',
        title: 'Rembric Tokens.',
        hl: 'Rembric',
        meta: [{ k: 'TOTAL', v: String(tokens.length) }],
      })}
      ${oneShot}

      <h2>Existing</h2>
      ${tokens.length === 0
        ? tblEmpty('No tokens yet.')
        : html`
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>name</th>
                    <th>scope</th>
                    <th>project</th>
                    <th>created</th>
                    <th>expires</th>
                    <th>state</th>
                    <th>actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows}
                </tbody>
              </table>
            </div>
          `}

      <h2>Create a new token</h2>
      <form action="/dashboard/tokens" method="post" class="stack">
        ${csrfInput(session.session, deps.sessions, 'token.create')}
        <label
          >Name
          <input name="name" type="text" required placeholder="claude-laptop" />
        </label>
        <label
          >Project (optional)
          <select name="project">
            <option value="">— none: ADMIN, every project + dashboard login —</option>
            ${selectable.map((p) =>
              raw(`<option value="${escape(p.slug)}">${escape(p.slug)}</option>`),
            )}
          </select>
        </label>
        <label
          >Access
          <select name="access">
            <option value="write" selected>write (read and write)</option>
            <option value="read">read (read only)</option>
          </select>
        </label>
        <label
          >Expires (optional, ISO 8601)
          <input name="expires" type="text" placeholder="2027-01-01T00:00:00Z" />
        </label>
        <button class="primary" type="submit">Create</button>
      </form>
    `;
    return c.html(renderPage(c, deps.sessions, body, { title: 'Tokens', activeNav: 'tokens' }));
  });

  app.post('/', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'token.create');
    if (form instanceof Response) return form;

    const name = readStringField(form, 'name').trim();
    const projectInput = readStringField(form, 'project').trim();
    const accessInput = readStringField(form, 'access').trim();
    const expiresInput = readStringField(form, 'expires').trim();

    const view = { title: 'Tokens', activeNav: 'tokens' } as const;

    if (form.has('scope')) {
      return flashErrorPage(
        c,
        deps.sessions,
        "The 'scope' field was retired. Reach comes from 'project' (empty = every project) " +
          "and the verb from 'access' ('write' or 'read'): scope=* is access=write, " +
          'scope=read:* is access=read.',
        view,
      );
    }

    if (!name) return flashErrorPage(c, deps.sessions, 'Name is required.', view);

    // Refused rather than defaulted: an omitted `access` resolving to `write`
    // silently picks the more privileged verb, and with no project that is `*`,
    // the only scope the dashboard login accepts.
    if (accessInput !== 'read' && accessInput !== 'write') {
      return flashErrorPage(c, deps.sessions, "Access must be 'write' or 'read'.", view);
    }
    const access = accessInput;

    let project: Project | null = null;
    if (projectInput) {
      // Operator-initiated token creation: autocreate the project row if
      // the slug is new. The slug must still satisfy the strict regex,
      // which `ProjectsService.create` enforces.
      try {
        project =
          deps.projects.findBySlug(projectInput) ?? deps.projects.create({ slug: projectInput });
      } catch (err) {
        if (err instanceof DomainError) {
          return flashErrorPage(c, deps.sessions, err.message, view);
        }
        throw err;
      }
    }

    let expiresAt: Date | null = null;
    if (expiresInput) {
      const parsed = new Date(expiresInput);
      if (Number.isNaN(parsed.getTime())) {
        return flashErrorPage(
          c,
          deps.sessions,
          `Invalid expires timestamp '${expiresInput}'.`,
          view,
        );
      }
      expiresAt = parsed;
    }

    try {
      const { plaintext } = project
        ? deps.tokens.create({ name, project, access, expiresAt })
        : deps.tokens.create({ name, scope: access === 'read' ? 'read:*' : '*', expiresAt });
      const url = new URL('/dashboard/tokens', c.req.url);
      url.searchParams.set('created', plaintext);
      url.searchParams.set('name', name);
      return c.redirect(url.pathname + url.search);
    } catch (err) {
      if (err instanceof DomainError) {
        return flashErrorPage(c, deps.sessions, err.message, view);
      }
      throw err;
    }
  });

  app.post('/:name/revoke', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'token.revoke');
    if (form instanceof Response) return form;
    try {
      deps.tokens.revoke(c.req.param('name'));
    } catch (err) {
      if (err instanceof DomainError) {
        return flashErrorPage(c, deps.sessions, err.message, {
          title: 'Tokens',
          activeNav: 'tokens',
        });
      }
      throw err;
    }
    return c.redirect('/dashboard/tokens');
  });

  return app;
}

function readStringField(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

function scopeBadge(scope: TokenScope): SafeHtml {
  if (scope === '*') return raw('<span class="pill scope-star">*</span>');
  if (scope === 'read:*') return raw('<span class="pill">read:*</span>');
  return raw(`<code>${escape(scope)}</code>`);
}
