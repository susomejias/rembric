import { Hono, type Context, type Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import { createAssetsMiddleware } from '../dashboard/assets.js';
import { createConsolidationRouter } from '../dashboard/consolidation.js';
import { createMemoriesRouter } from '../dashboard/memories.js';
import { createProjectsRouter } from '../dashboard/projects.js';
import { createSessionsRouter } from '../dashboard/sessions.js';
import { html, shell } from '../dashboard/templates.js';
import { createTokensRouter } from '../dashboard/tokens.js';
import type { ResolvedSession } from '../dashboard/types.js';
import type { Db } from '../db/client.js';
import { DomainError } from '../services/errors.js';
import type { MemoryService } from '../services/memory.js';
import type { ProjectsService } from '../services/projects.js';
import type { SessionsService } from '../services/sessions.js';
import type { TokensService } from '../services/tokens.js';

/**
 * Dashboard router. Composes the per-resource sub-routers under a single
 * cookie-authenticated mount at `/dashboard/*`.
 *
 *   - /dashboard/login  /logout         (anonymous, by design)
 *   - /dashboard                        (home, stats summary)
 *   - /dashboard/memories               (list + detail + archive)
 *   - /dashboard/consolidation          (runs + run detail + undo)
 *   - /dashboard/projects               (list + rename + archive)
 *   - /dashboard/tokens                 (list + create + revoke)
 */

const COOKIE_NAME = 'rembric_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface DashboardDeps {
  db: Db;
  tokens: TokensService;
  sessions: SessionsService;
  projects: ProjectsService;
  memory: MemoryService;
  getStats: () => DashboardStats;
}

export interface DashboardStats {
  totalMemories: number;
  activeMemories: number;
  archivedMemories: number;
  projects: number;
  lastConsolidationAt: Date | null;
  activeSessions: number;
}

export function createDashboardRouter(deps: DashboardDeps): Hono {
  const app = new Hono();

  // ── static assets (anonymous, no CSRF; safe-by-design read-only) ──
  app.get('/assets/:path{.+}', createAssetsMiddleware());

  // ── public routes ──────────────────────────────────────────────────
  app.get('/login', (c) => c.html(renderLogin(null)));

  app.post('/login', async (c) => {
    const form = await c.req.formData();
    const raw = form.get('token');
    const tokenPlain = typeof raw === 'string' ? raw : '';
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
        maxAge: SESSION_TTL_SECONDS,
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

  // ── auth middleware for everything else ────────────────────────────
  app.use('*', async (c: Context, next: Next) => {
    // Skip auth for login/logout/static assets. The route handlers for
    // those paths are registered above this middleware, so a normal
    // request never reaches here. This is defensive belt-and-braces.
    const p = c.req.path;
    if (
      p === '/login' ||
      p === '/logout' ||
      p === '/dashboard/login' ||
      p === '/dashboard/logout' ||
      p.startsWith('/dashboard/assets/') ||
      p.startsWith('/assets/')
    ) {
      return next();
    }
    const cookie = getCookie(c, COOKIE_NAME);
    if (!cookie) return c.redirect('/dashboard/login');
    const ctx = deps.sessions.resolve(cookie);
    if (!ctx) return c.redirect('/dashboard/login');

    const resolved: ResolvedSession = {
      session: ctx.session,
      sessions: deps.sessions,
      tokenId: ctx.tokenId,
    };
    c.set('session', resolved);
    return next();
  });

  // ── home ───────────────────────────────────────────────────────────
  app.get('/', (c) => {
    const stats = deps.getStats();
    const body = html`
      <h1>Overview</h1>
      <div class="stat-grid">
        <div class="stat-card">
          <div class="label">Total memories</div>
          <div class="value">${stats.totalMemories}</div>
        </div>
        <div class="stat-card">
          <div class="label">Active</div>
          <div class="value">${stats.activeMemories}</div>
        </div>
        <div class="stat-card">
          <div class="label">Archived</div>
          <div class="value">${stats.archivedMemories}</div>
        </div>
        <div class="stat-card">
          <div class="label">Projects</div>
          <div class="value">${stats.projects}</div>
        </div>
        <div class="stat-card">
          <div class="label">Sessions (active)</div>
          <div class="value">${stats.activeSessions}</div>
        </div>
        <div class="stat-card">
          <div class="label">Last consolidation</div>
          <div class="value" style="font-size:.9rem">
            ${stats.lastConsolidationAt
              ? stats.lastConsolidationAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
              : '—'}
          </div>
        </div>
      </div>
      <p class="small muted">
        Navigate the tabs above to manage memories, browse sessions, consolidation runs, projects,
        and tokens.
      </p>
    `;
    return c.html(shell(body, { title: 'Dashboard', activeNav: 'home' }));
  });

  // ── resource routers ───────────────────────────────────────────────
  app.route(
    '/memories',
    createMemoriesRouter({ db: deps.db, memory: deps.memory, sessions: deps.sessions }),
  );
  app.route('/sessions', createSessionsRouter({ db: deps.db, sessions: deps.sessions }));
  app.route('/consolidation', createConsolidationRouter({ db: deps.db, sessions: deps.sessions }));
  app.route(
    '/projects',
    createProjectsRouter({ projects: deps.projects, sessions: deps.sessions }),
  );
  app.route(
    '/tokens',
    createTokensRouter({ tokens: deps.tokens, projects: deps.projects, sessions: deps.sessions }),
  );

  return app;
}

function renderLogin(error: string | null): string {
  const body = html`
    <h1>Rembric · Login</h1>
    ${error ? html`<p class="flash error">${error}</p>` : ''}
    <form action="/dashboard/login" method="post" class="stack">
      <label
        >Admin token
        <input name="token" type="password" autocomplete="off" required autofocus />
      </label>
      <button class="primary" type="submit">Sign in</button>
    </form>
  `;
  return shell(body, { title: 'Login' });
}
