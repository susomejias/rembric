import { Hono, type Context } from 'hono';

import { DomainError } from '../services/errors.js';
import type { ProjectsService } from '../services/projects.js';
import type { SessionsService } from '../services/sessions.js';
import { type TokensService, type TokenScope } from '../services/tokens.js';

import { readFormAndVerifyCsrf, csrfInput } from './csrf.js';
import { escape, formatTs, html, raw, type SafeHtml, shell } from './templates.js';
import type { ResolvedSession } from './types.js';

export interface TokensDeps {
  tokens: TokensService;
  projects: ProjectsService;
  sessions: SessionsService;
}

function getSession(c: Context): ResolvedSession | null {
  return (c.get('session') as ResolvedSession | undefined) ?? null;
}

export function createTokensRouter(deps: TokensDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const justCreated = new URL(c.req.url).searchParams.get('created');
    const tokens = deps.tokens.list();
    const now = Date.now();

    const stateOf = (t: (typeof tokens)[number]): { label: string; cls: string } => {
      if (t.revokedAt) return { label: 'revoked', cls: 'archived' };
      if (t.expiresAt && t.expiresAt.getTime() <= now) return { label: 'expired', cls: 'archived' };
      return { label: 'active', cls: 'active' };
    };

    const rows = tokens.map((t) => {
      const s = stateOf(t);
      return html`
        <tr>
          <td>${t.name}</td>
          <td class="mono small">${scopeBadge(t.scope as TokenScope)}</td>
          <td class="muted">${formatTs(t.createdAt)}</td>
          <td class="muted">${formatTs(t.expiresAt)}</td>
          <td><span class="pill ${s.cls}">${s.label}</span></td>
          <td>
            ${t.revokedAt
              ? raw('<span class="muted small">—</span>')
              : html`
                  <form action="/dashboard/tokens/${t.name}/revoke" method="post" class="inline">
                    ${csrfInput(session.session, deps.sessions, 'token.revoke')}
                    <button class="warn" type="submit">Revoke</button>
                  </form>
                `}
          </td>
        </tr>
      `;
    });

    const projects = deps.projects.list();

    const oneShot = justCreated
      ? html`
          <div class="one-shot">
            <strong>New token created.</strong>
            This is the only time the plaintext is shown — copy it now:
            <pre>${justCreated}</pre>
            <p class="small">
              Paste into your agent's MCP config under
              <code>headers.Authorization: "Bearer ${justCreated.slice(0, 6)}…"</code>.
            </p>
          </div>
        `
      : raw('');

    const body = html`
      <h1>Tokens</h1>
      ${oneShot}

      <h2>Existing</h2>
      ${tokens.length === 0
        ? html`<p class="muted">No tokens yet.</p>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>name</th>
                  <th>scope</th>
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
            <option value="">— none (admin / global) —</option>
            ${projects.map((p) =>
              raw(`<option value="${escape(p.slug)}">${escape(p.slug)}</option>`),
            )}
          </select>
        </label>
        <label
          >Scope override (advanced)
          <select name="scope">
            <option value="">— derive from project —</option>
            <option value="*">* (admin, full access)</option>
            <option value="read:*">read:* (read-only across all)</option>
          </select>
        </label>
        <label
          >Expires (optional, ISO 8601)
          <input name="expires" type="text" placeholder="2027-01-01T00:00:00Z" />
        </label>
        <button class="primary" type="submit">Create</button>
      </form>
    `;
    return c.html(shell(body, { title: 'Tokens', activeNav: 'tokens' }));
  });

  app.post('/', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'token.create');
    if (form instanceof Response) return form;

    const name = readStringField(form, 'name').trim();
    const projectInput = readStringField(form, 'project').trim();
    const scopeOverride = readStringField(form, 'scope').trim();
    const expiresInput = readStringField(form, 'expires').trim();

    if (!name) return errorResponse(c, 'Name is required.');

    let projectSlug: string | null = null;
    if (projectInput) {
      // Operator-initiated token creation: autocreate the project row if
      // the slug is new. The slug must still satisfy the strict regex,
      // which `ProjectsService.create` enforces.
      try {
        let p = deps.projects.findBySlug(projectInput);
        p ??= deps.projects.create({ slug: projectInput });
        projectSlug = p.slug;
      } catch (err) {
        if (err instanceof DomainError) {
          return errorResponse(c, err.message);
        }
        throw err;
      }
    }

    let scope: TokenScope;
    if (scopeOverride) {
      if (scopeOverride !== '*' && scopeOverride !== 'read:*') {
        return errorResponse(c, "Override scope must be '*' or 'read:*'.");
      }
      scope = scopeOverride;
    } else {
      scope = projectSlug ? `project:${projectSlug}` : '*';
    }

    let expiresAt: Date | null = null;
    if (expiresInput) {
      const parsed = new Date(expiresInput);
      if (Number.isNaN(parsed.getTime())) {
        return errorResponse(c, `Invalid expires timestamp '${expiresInput}'.`);
      }
      expiresAt = parsed;
    }

    try {
      const { plaintext } = deps.tokens.create({
        name,
        scope,
        projectId: null,
        expiresAt,
      });
      const url = new URL('/dashboard/tokens', c.req.url);
      url.searchParams.set('created', plaintext);
      return c.redirect(url.pathname + url.search);
    } catch (err) {
      if (err instanceof DomainError) {
        return errorResponse(c, err.message);
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
        return errorResponse(c, err.message);
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

function errorResponse(c: Context, message: string): Response {
  return c.html(
    shell(html`<p class="flash error">${message}</p>`, {
      title: 'Tokens',
      activeNav: 'tokens',
    }),
    400,
  );
}
