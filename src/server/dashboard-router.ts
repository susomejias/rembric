import { type Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import { DomainError } from '../services/errors.js';
import type { ProjectsService } from '../services/projects.js';
import type { SessionsService } from '../services/sessions.js';
import type { TokensService } from '../services/tokens.js';

/**
 * Minimal dashboard router. v0 scope here: cookie session lifecycle
 * (`/dashboard/login` and `/dashboard/logout`) plus a placeholder home
 * page showing high-level stats. Per-resource pages (memories, consolidation,
 * tokens, projects) land in section 9 of tasks.md.
 */

const COOKIE_NAME = 'rembric_session';

export interface DashboardDeps {
  tokens: TokensService;
  sessions: SessionsService;
  projects: ProjectsService;
  /** Provider of summary stats. Kept abstract so the router doesn't pull in services. */
  getStats: () => DashboardStats;
}

export interface DashboardStats {
  totalMemories: number;
  activeMemories: number;
  archivedMemories: number;
  projects: number;
  lastConsolidationAt: Date | null;
}

export function createDashboardRouter(deps: DashboardDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = resolveSession(c, deps);
    if (!session) return c.redirect('/dashboard/login');
    const stats = deps.getStats();
    return c.html(renderHome(stats));
  });

  app.get('/login', (c) => {
    return c.html(renderLogin(null));
  });

  app.post('/login', async (c) => {
    const form = await c.req.formData();
    const rawToken = form.get('token');
    const tokenPlain = typeof rawToken === 'string' ? rawToken : '';
    if (tokenPlain.length === 0) {
      return c.html(renderLogin('Token is required.'), 400);
    }
    try {
      const resolved = deps.tokens.authenticate(tokenPlain);
      if (resolved.scope !== '*') {
        return c.html(renderLogin('Only admin-scoped tokens can access the dashboard.'), 403);
      }
      const { cookie } = deps.sessions.create(resolved.token.id);
      setCookie(c, COOKIE_NAME, cookie, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/dashboard',
        maxAge: 7 * 24 * 60 * 60,
      });
      return c.redirect('/dashboard');
    } catch (err) {
      if (err instanceof DomainError) {
        return c.html(renderLogin('Invalid token.'), 401);
      }
      throw err;
    }
  });

  app.post('/logout', (c) => {
    const cookie = getCookie(c, COOKIE_NAME);
    if (cookie) {
      const sessionId = cookie.split('.')[0];
      if (sessionId) deps.sessions.destroy(sessionId);
    }
    setCookie(c, COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/dashboard',
      maxAge: 0,
    });
    return c.redirect('/dashboard/login');
  });

  // Placeholder routes for sections 9.6+. They return a "coming soon"
  // panel so links from the home page don't 404 in v0.0.x.
  for (const path of ['/memories', '/consolidation', '/projects', '/tokens']) {
    app.get(path, (c) => {
      const session = resolveSession(c, deps);
      if (!session) return c.redirect('/dashboard/login');
      return c.html(renderComingSoon(path));
    });
  }

  return app;
}

interface ResolvedSession {
  tokenId: string;
}

function resolveSession(c: Context, deps: DashboardDeps): ResolvedSession | null {
  const cookie = getCookie(c, COOKIE_NAME);
  if (!cookie) return null;
  const ctx = deps.sessions.resolve(cookie);
  return ctx ? { tokenId: ctx.tokenId } : null;
}

/* --- Minimal HTML rendering. Full HTMX+Pico templates land in section 9. --- */

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} · Rembric</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; }
    h1 { margin-top: 0; }
    form { display: grid; gap: .75rem; }
    input, button { padding: .5rem .75rem; font: inherit; }
    .err { color: #c00; }
    nav a { margin-right: 1rem; }
    table { width: 100%; border-collapse: collapse; }
    td, th { text-align: left; padding: .5rem; border-bottom: 1px solid #ddd; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderHome(stats: DashboardStats): string {
  return shell(
    'Dashboard',
    `<h1>Rembric</h1>
<nav>
  <a href="/dashboard/memories">Memories</a>
  <a href="/dashboard/consolidation">Consolidation</a>
  <a href="/dashboard/projects">Projects</a>
  <a href="/dashboard/tokens">Tokens</a>
  <form action="/dashboard/logout" method="post" style="display:inline">
    <button type="submit">Logout</button>
  </form>
</nav>
<table>
  <tr><th>Total memories</th><td>${stats.totalMemories}</td></tr>
  <tr><th>Active</th><td>${stats.activeMemories}</td></tr>
  <tr><th>Archived</th><td>${stats.archivedMemories}</td></tr>
  <tr><th>Projects</th><td>${stats.projects}</td></tr>
  <tr><th>Last consolidation</th><td>${stats.lastConsolidationAt ? escape(stats.lastConsolidationAt.toISOString()) : '—'}</td></tr>
</table>`,
  );
}

function renderLogin(error: string | null): string {
  return shell(
    'Login',
    `<h1>Rembric · Login</h1>
${error ? `<p class="err">${escape(error)}</p>` : ''}
<form action="/dashboard/login" method="post">
  <label>Admin token
    <input name="token" type="password" autocomplete="off" required autofocus>
  </label>
  <button type="submit">Sign in</button>
</form>`,
  );
}

function renderComingSoon(path: string): string {
  return shell(
    `Coming soon: ${path}`,
    `<h1>Coming soon</h1>
<p>The <code>${escape(path)}</code> view is part of the v0.1 dashboard milestone.</p>
<p><a href="/dashboard">Back to home</a></p>`,
  );
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
