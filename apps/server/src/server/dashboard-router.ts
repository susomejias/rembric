import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context, type Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import {
  DEFAULT_MIN_INTERVAL_MS,
  type ConsolidationRunSummary,
  type SkippedRow,
} from '../consolidation/index.js';
import { createAssetsMiddleware } from '../dashboard/assets.js';
import {
  btn,
  flash,
  NAV,
  renderSidebar,
  sectionBar,
  sparkline,
  statCard,
  tblEmpty,
  truncate,
  viewHead,
} from '../dashboard/components.js';
import { createConsolidationRouter, scopeLabel } from '../dashboard/consolidation.js';
import { csrfInput, readFormAndVerifyCsrf } from '../dashboard/csrf.js';
import { createEntitiesRouter } from '../dashboard/entities.js';
import { createJudgmentsRouter } from '../dashboard/judgments.js';
import { createMaintenanceRouter } from '../dashboard/maintenance.js';
import { createMemoriesRouter } from '../dashboard/memories.js';
import { createOAuthConsentRouter } from '../dashboard/oauth-consent.js';
import { createProjectsRouter } from '../dashboard/projects.js';
import { createPromptsRouter } from '../dashboard/prompts.js';
import { createSessionsRouter } from '../dashboard/sessions.js';
import {
  escape,
  html,
  raw,
  rawPill,
  shell,
  statusPill,
  verdictPill,
  type SafeHtml,
} from '../dashboard/templates.js';
import { createTokensRouter } from '../dashboard/tokens.js';
import type { ResolvedSession } from '../dashboard/types.js';
import { updateShellExtras, type UpdateViewState } from '../dashboard/update-modal.js';
import { createUpdateRouter } from '../dashboard/update.js';
import type { DbDiagnostics } from '../db/diagnostics.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import type { EntityBackfillWorker } from '../services/entity-backfill-worker.js';
import { DomainError } from '../services/errors.js';
import type { MemoryService } from '../services/memory.js';
import type { OAuthService } from '../services/oauth.js';
import type { ProjectsService } from '../services/projects.js';
import type { PromptsService } from '../services/prompts.js';
import type { RelationsService } from '../services/relations.js';
import type { SelfUpdateOrchestrator } from '../services/self-update/orchestrator.js';
import type { SessionsService } from '../services/sessions.js';
import type { TokensService } from '../services/tokens.js';
import type { UpdateCheckService } from '../services/update-check.js';
import { REMBRIC_VERSION } from '../version.js';

import type { AuthLockout } from './rate-limit.js';

const COOKIE_NAME = 'rembric_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SIDEBAR_COOKIE = 'rbr-sb-collapsed';

export interface DashboardDeps {
  repos: Repositories;
  diagnostics: DbDiagnostics;
  tokens: TokensService;
  sessions: SessionsService;
  agentSessions: AgentSessionsService;
  projects: ProjectsService;
  prompts: PromptsService;
  memory: MemoryService;
  relations: RelationsService;
  getStats: () => DashboardStats;
  /** Resolved data directory (from `config.dataDir`). */
  dataDir: string;
  updates: UpdateCheckService;
  selfUpdate: SelfUpdateOrchestrator;
  /** Forced sweep across all scopes (same lambda as the admin endpoint). */
  triggerSweep: () => ConsolidationRunSummary;
  /**
   * The live, boot-time singleton — NOT a fresh instance — so a manual
   * rebuild's leftover backlog (beyond `REBUILD_MAX_BATCHES`) stays visible
   * to this same worker's own `possiblyPending` state, and the regular
   * periodic tick picks it back up within seconds instead of waiting for
   * the hourly forced fallback.
   */
  entityBackfillWorker: EntityBackfillWorker;
  /** Bound consolidation undo lambdas (wired in bootstrap). */
  undoRun: (runId: string) => { reverted: string[]; skipped: SkippedRow[] };
  undoOp: (opId: string) => { reverted: string; skipped: SkippedRow[] };
  /** Resolved judgment aging thresholds (from `config.judgments`). */
  orphanAfterMs: number;
  orphanDeadlineMs: number;
  /** OAuth service + consent signing key; present only when OAuth is enabled. */
  oauth?: OAuthService | null;
  oauthAreqKey?: Buffer | null;
  /** Set the `Secure` cookie attribute (true on HTTPS deployments). */
  secureCookies?: boolean;
  /** Pre-auth failed-attempt lockout for the login form, keyed on network identity. */
  authLockout?: AuthLockout | null;
}

export interface DashboardStats {
  totalMemories: number;
  activeMemories: number;
  archivedMemories: number;
  projects: number;
  lastConsolidationAt: Date | null;
  activeSessions: number;
  pendingJudgments: number;
}

function sidebarCollapsed(c: Context): boolean {
  return getCookie(c, SIDEBAR_COOKIE) === '1';
}

export function createDashboardRouter(deps: DashboardDeps): Hono {
  const app = new Hono();

  // ── static assets ────────────────────────────────────────────────
  app.get('/assets/:path{.+}', createAssetsMiddleware());

  // ── login / logout (anonymous) ───────────────────────────────────
  app.get('/login', (c) => c.html(renderLogin(null, safeNext(c.req.query('next')))));

  app.post('/login', async (c) => {
    const identity = loginIdentity(c);
    const locked = deps.authLockout?.check(identity);
    if (locked?.locked) {
      c.header('Retry-After', String(locked.retryAfterSeconds));
      return c.html(renderLogin('Too many attempts. Try again shortly.', null), 429);
    }
    const form = await c.req.formData();
    const r = form.get('token');
    const tokenPlain = typeof r === 'string' ? r : '';
    const next = safeNext(
      typeof form.get('next') === 'string' ? (form.get('next') as string) : null,
    );
    if (tokenPlain.length === 0) {
      return c.html(renderLogin('Token is required.', next), 400);
    }
    try {
      const resolved = await deps.tokens.authenticate(tokenPlain);
      // A valid-but-non-admin token gets the SAME response as an invalid one,
      // so the endpoint is not a token-validity oracle.
      if (resolved.scope !== '*') {
        deps.authLockout?.recordFailure(identity);
        return c.html(renderLogin('Invalid token.', next), 401);
      }
      deps.authLockout?.recordSuccess(identity);
      const { cookie } = deps.sessions.create(resolved.token.id);
      setCookie(c, COOKIE_NAME, cookie, {
        httpOnly: true,
        secure: deps.secureCookies ?? false,
        sameSite: 'Lax',
        path: '/dashboard',
        maxAge: SESSION_TTL_SECONDS,
      });
      return c.redirect(next ?? '/dashboard');
    } catch (err) {
      if (err instanceof DomainError) {
        deps.authLockout?.recordFailure(identity);
        return c.html(renderLogin('Invalid token.', next), 401);
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
      secure: deps.secureCookies ?? false,
      sameSite: 'Lax',
      path: '/dashboard',
      maxAge: 0,
    });
    return c.redirect('/dashboard/login');
  });

  // ── auth middleware ─────────────────────────────────────────────
  app.use('*', async (c: Context, next: Next) => {
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
    if (!cookie) return c.redirect(loginWithNext(c));
    const ctx = deps.sessions.resolve(cookie);
    if (!ctx) return c.redirect(loginWithNext(c));

    const resolved: ResolvedSession = {
      session: ctx.session,
      sessions: deps.sessions,
      tokenId: ctx.tokenId,
    };
    c.set('session', resolved);

    // Update-availability state for the shell (badge + modal). With no
    // newer release known, this is a sync cache read and the capability
    // probe (which may touch the Docker socket) is never reached.
    let update: UpdateViewState | null = null;
    const info = deps.updates.peek();
    if (info) {
      const phase = deps.selfUpdate.status().phase;
      update = {
        info,
        capability: await deps.selfUpdate.capability(),
        running: phase !== 'idle' && phase !== 'failed',
      };
    }
    c.set('update', update);
    c.set('updateCheckEnabled', deps.updates.enabled);
    return next();
  });

  // ── sidebar collapse toggle ─────────────────────────────────────
  app.post('/_sidebar/toggle', async (c) => {
    const session = (c.get('session' as never) as ResolvedSession | undefined) ?? undefined;
    if (!session) return c.redirect('/dashboard/login');
    const result = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'sidebar.toggle');
    if (result instanceof Response) return result;
    const next = sidebarCollapsed(c) ? '0' : '1';
    setCookie(c, SIDEBAR_COOKIE, next, {
      sameSite: 'Lax',
      path: '/dashboard',
      maxAge: 365 * 24 * 60 * 60,
    });
    const back = c.req.header('referer') ?? '/dashboard';
    return c.redirect(back);
  });

  // ── home ────────────────────────────────────────────────────────
  app.get('/', (c) => {
    const session = c.get('session' as never) as ResolvedSession;
    const stats = deps.getStats();
    const collapsed = sidebarCollapsed(c);
    const counters = { pendingJudgments: stats.pendingJudgments };
    const csrf = csrfInput(session.session, deps.sessions, 'sidebar.toggle');
    const updateState = (c.get('update' as never) as UpdateViewState | undefined | null) ?? null;
    const updateExtras = updateShellExtras(
      updateState,
      session.session,
      deps.sessions,
      deps.updates.enabled,
    );
    const sidebar = renderSidebar({
      active: 'home',
      counters,
      collapsed,
      csrf,
      update: updateExtras.badge,
    });

    const supersededMemories = Math.max(
      0,
      stats.totalMemories - stats.activeMemories - stats.archivedMemories,
    );

    const supersededColor = supersededMemories > 0 ? 'warn' : 'lime';

    const archivedProjects = deps.repos.projects.adminCountArchived();
    const orphanedJ = deps.repos.relations.adminCountByStatus('orphaned');
    const activity = sevenDayActivity(deps.repos);
    const recentJudgedRows = deps.repos.relations.adminRecentJudged(4);
    const recentSessions = deps.repos.agentSessions.adminRecent(5);

    const lastRunRow = deps.repos.consolidation.adminListRuns(1, 0).at(0) ?? null;
    const lastRunCounts = lastRunRow
      ? deps.repos.consolidation.adminOpCounts(lastRunRow.id)
      : { total: 0, reverted: 0 };
    const lastRun = lastRunRow
      ? {
          ...lastRunRow,
          scopeLabel: scopeLabel(deps.repos, lastRunRow.scope),
          totalOps: lastRunCounts.total,
          revertedOps: lastRunCounts.reverted,
        }
      : null;

    const dbPath = join(deps.dataDir, 'data.db');
    const dbPathDisplay = displayPath(dbPath);
    let dbSize = '—';
    try {
      const stat = statSync(dbPath);
      const walStat = safeStat(`${dbPath}-wal`);
      const totalBytes = Number(stat.size) + Number(walStat?.size ?? 0);
      dbSize = `${(totalBytes / (1024 * 1024)).toFixed(2)} MB`;
    } catch {
      /* ignore — file not yet created, show '—' */
    }

    const host = `${process.env.REMBRIC_HOST ?? '127.0.0.1'}:${process.env.REMBRIC_PORT ?? '8787'}`;

    const body = html`
      ${viewHead({
        num: '01',
        title: 'Rembric Overview.',
        hl: 'Rembric',
      })}

      <div class="grid-6" style="margin-bottom:var(--s-6)">
        ${statCard({
          k: 'TOTAL MEMORIES',
          v: stats.totalMemories,
          tone: 'fg',
          sub: html`${sparkline(activity)}<span>LAST 7 DAYS</span>`,
          href: '/dashboard/memories',
        })}
        ${statCard({
          k: 'ACTIVE MEMORIES',
          v: stats.activeMemories,
          tone: 'lime',
          sub: pctOfTotal(stats.activeMemories, stats.totalMemories),
          href: '/dashboard/memories?status=active',
        })}
        ${statCard({
          k: 'SUPERSEDED MEMORIES',
          v: supersededMemories,
          tone: supersededColor,
          sub: html`<span>SAFE TO ARCHIVE</span><span>›</span>`,
          href: '/dashboard/memories?status=superseded',
        })}
        ${statCard({
          k: 'ARCHIVED MEMORIES',
          v: stats.archivedMemories,
          tone: 'dim',
          sub: html`<span>DECAYED</span><span>›</span>`,
          href: '/dashboard/memories?status=archived',
        })}
        ${statCard({
          k: 'PROJECTS',
          v: stats.projects,
          tone: 'lime',
          sub: html`<span>${archivedProjects}</span><span>ARCHIVED</span>`,
          href: '/dashboard/projects',
        })}
        ${statCard({
          k: 'ACTIVE SESSIONS',
          v: stats.activeSessions,
          tone: stats.activeSessions > 0 ? 'lime' : 'fg',
          sub: html`<span>CONNECTED NOW</span><span>›</span>`,
          href: '/dashboard/sessions',
        })}
      </div>

      <div class="row-2" style="margin-bottom:var(--s-6)">
        <div>
          ${sectionBar({
            name: 'RECENT JUDGMENTS',
            meta: 'NEWEST FIRST',
            more: raw('<a href="/dashboard/judgments" style="color:var(--lime)">OPEN ALL ›</a>'),
          })}
          ${recentJudgedRows.length === 0
            ? tblEmpty('NO JUDGMENTS YET')
            : html`
                <div class="jq">
                  ${recentJudgedRows.map(
                    (r) => html`
                      <div class="jq-item">
                        <div class="pair">
                          <div class="met">
                            ${verdictPill(r.relation)}
                            <span>${r.judgedAt ? relTime(r.judgedAt) : '—'}</span>
                            ${r.markedByKind
                              ? html`<span>·</span><span class="fg-dim">${r.markedByKind}</span>`
                              : raw('')}
                          </div>
                          <div class="mem">
                            <a href="/dashboard/memories/${r.sourceId}" class="txt"
                              >${truncate(r.sourceTitle, 70)}</a
                            >
                          </div>
                          <div class="mem">
                            <span class="arrow">↳</span>
                            <a href="/dashboard/memories/${r.targetId}" class="txt"
                              >${truncate(r.targetTitle, 70)}</a
                            >
                          </div>
                        </div>
                        <div class="acts">
                          ${btn({
                            variant: 'primary',
                            size: 'sm',
                            label: 'VIEW →',
                            href: `/dashboard/judgments/${r.id}`,
                          })}
                        </div>
                      </div>
                    `,
                  )}
                </div>
              `}
        </div>

        <div>
          ${sectionBar({
            name: 'RECENT SESSIONS',
            meta: 'NEWEST FIRST',
            more: raw('<a href="/dashboard/sessions" style="color:var(--lime)">OPEN ALL ›</a>'),
          })}
          ${recentSessions.length === 0
            ? tblEmpty('NO SESSIONS YET')
            : html`
                <div class="tl" style="border:1px solid var(--fg-faint)">
                  ${recentSessions.map(
                    (s) => html`
                      <a
                        href="/dashboard/sessions/${s.id}"
                        class="tl-item"
                        style="text-decoration:none;color:inherit"
                      >
                        <div class="when">${relTime(s.startedAt)}</div>
                        <div class="who">
                          <span class="agent">▸ ${s.agent}</span>
                          ${s.projectSlug
                            ? html`<span class="proj">/ ${s.projectSlug}</span>`
                            : raw('<span class="proj muted">/ —</span>')}
                          <span class="desc"
                            >${truncate(s.summary ?? '—', 60)}${s.summary && !s.summaryFinal
                              ? html` ${rawPill()}`
                              : raw('')}</span
                          >
                        </div>
                        <div class="right">
                          <span><b>${s.memCount}</b> MEM</span>
                          ${statusPill(s.status === 'active' ? 'active' : 'judged')}
                        </div>
                      </a>
                    `,
                  )}
                </div>
              `}
        </div>
      </div>

      ${sectionBar({
        name: 'CONSOLIDATION HEALTH',
        meta: lastRun ? `LAST RUN · ${shortDisplayId(lastRun.id)}` : 'NO RUN YET',
        more: lastRun
          ? raw(
              `<a href="/dashboard/consolidation/${escape(lastRun.id)}" style="color:var(--lime)">OPEN RUN ›</a>`,
            )
          : raw(''),
      })}
      <div class="health" style="margin-bottom:var(--s-6)">
        <div class="cell">
          <span class="lab"><span class="bn"></span> LAST RUN</span>
          <span class="val ${lastRun ? 'lime' : 'dim'}">${lastRun ? 'OK' : '—'}</span>
          <span class="sub"
            >${lastRun
              ? html`${relTime(lastRun.finishedAt ?? lastRun.startedAt)} · ${lastRun.scopeLabel}`
              : 'NEVER'}</span
          >
        </div>
        <div class="cell">
          <span class="lab"><span class="bn"></span> OPS APPLIED</span>
          <span class="val">${lastRun?.totalOps ?? 0}</span>
          <span class="sub">${lastRun?.revertedOps ?? 0} REVERTED</span>
        </div>
        <div class="cell">
          <span class="lab"><span class="bn warn"></span> ORPHANED PENDINGS</span>
          <span class="val ${orphanedJ > 0 ? 'warn' : 'lime'}">${orphanedJ}</span>
          <span class="sub"
            >RE-EXPOSED &gt; ${fmtWindow(deps.orphanAfterMs)} · ORPHANED &gt;
            ${fmtWindow(deps.orphanDeadlineMs)}</span
          >
        </div>
        <div class="cell">
          <span class="lab"><span class="bn"></span> TRIGGER</span>
          <span class="val" style="font-family:var(--f-mono);font-size:0.9rem"
            >ON SESSION START</span
          >
          <span class="sub"
            >THROTTLED ${fmtWindow(DEFAULT_MIN_INTERVAL_MS)} / SCOPE · MANUAL FROM
            CONSOLIDATION</span
          >
        </div>
      </div>

      <div class="row-2">
        <div class="card act-card">
          <div class="card-head">
            <span><span class="bn"></span> <b>ACTIVITY · 7 DAYS</b></span>
            <span>MEMORIES CREATED · PER DAY</span>
          </div>
          <div class="card-body">
            <pre class="act-bars">${ascBars(activity)}</pre>
          </div>
        </div>
        <div class="card">
          <div class="card-head">
            <span><span class="bn"></span> <b>SYSTEM</b></span>
            <span>SQLITE · NODE · MCP</span>
          </div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:var(--s-3)">
            ${systemRow('DB FILE', dbPathDisplay, 'lime')} ${systemRow('DB SIZE', dbSize, 'fg')}
            ${systemRow('FTS INDEX', 'memory_fts · contentless', 'fg')}
            ${systemRow('MCP SERVER', host, 'lime')}
            ${systemRow('NODE', `${process.versions.node}`, 'fg')}
          </div>
        </div>
      </div>
    `;
    return c.html(
      shell(body, {
        title: 'Overview',
        activeNav: 'home',
        view: 'home',
        sidebar,
        collapsed,
        counters,
        updateBadge: updateExtras.badge,
        updateModal: updateExtras.modal,
      }),
    );
  });

  // ── resource routers ────────────────────────────────────────────
  app.route(
    '/memories',
    createMemoriesRouter({ repos: deps.repos, memory: deps.memory, sessions: deps.sessions }),
  );
  app.route(
    '/sessions',
    createSessionsRouter({
      repos: deps.repos,
      sessions: deps.sessions,
      agentSessions: deps.agentSessions,
    }),
  );
  app.route(
    '/prompts',
    createPromptsRouter({ repos: deps.repos, prompts: deps.prompts, sessions: deps.sessions }),
  );
  app.route(
    '/judgments',
    createJudgmentsRouter({
      repos: deps.repos,
      relations: deps.relations,
      sessions: deps.sessions,
    }),
  );
  app.route(
    '/consolidation',
    createConsolidationRouter({
      repos: deps.repos,
      sessions: deps.sessions,
      triggerSweep: deps.triggerSweep,
      undoRun: deps.undoRun,
      undoOp: deps.undoOp,
    }),
  );
  app.route(
    '/entities',
    createEntitiesRouter({
      repos: deps.repos,
      sessions: deps.sessions,
      tokens: deps.tokens,
      entityBackfillWorker: deps.entityBackfillWorker,
    }),
  );
  app.route(
    '/projects',
    createProjectsRouter({ projects: deps.projects, sessions: deps.sessions }),
  );
  app.route(
    '/tokens',
    createTokensRouter({ tokens: deps.tokens, projects: deps.projects, sessions: deps.sessions }),
  );
  app.route(
    '/update',
    createUpdateRouter({
      updates: deps.updates,
      selfUpdate: deps.selfUpdate,
      sessions: deps.sessions,
    }),
  );
  app.route(
    '/maintenance',
    createMaintenanceRouter({
      diagnostics: deps.diagnostics,
      sessions: deps.sessions,
      agentSessions: deps.agentSessions,
      memory: deps.memory,
      prompts: deps.prompts,
      tokens: deps.tokens,
      dataDir: deps.dataDir,
    }),
  );

  if (deps.oauth && deps.oauthAreqKey) {
    app.route(
      '/oauth',
      createOAuthConsentRouter({
        oauth: deps.oauth,
        areqKey: deps.oauthAreqKey,
        sessions: deps.sessions,
      }),
    );
  }

  return app;
}

/**
 * Same-origin dashboard path to return to after login, or null. Restricted to
 * the OAuth consent route — the only flow that needs return-to — so every
 * other dashboard redirect stays the bare `/dashboard/login`.
 */
function safeNext(next: string | null | undefined): string | null {
  if (!next) return null;
  return next.startsWith('/dashboard/oauth/') ? next : null;
}

/** Best-effort client network identity for the login failed-attempt lockout. */
function loginIdentity(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function loginWithNext(c: Context): string {
  let target = '/dashboard/login';
  try {
    const u = new URL(c.req.url);
    const next = safeNext(u.pathname + u.search);
    if (next) target += `?next=${encodeURIComponent(next)}`;
  } catch {
    /* fall through to bare login */
  }
  return target;
}

/* ── helpers used by the Overview body ─────────────────────────── */

function sevenDayActivity(repos: Repositories): number[] {
  // Bucket the last 7 days into integer-day keys; SQLite stores ms.
  const todayMs = startOfUtcDay(Date.now());
  const sevenAgo = todayMs - 6 * 24 * 60 * 60 * 1000;
  const rows = repos.memory.adminCountCreatedByDay(new Date(sevenAgo));
  const map = new Map<number, number>();
  for (const r of rows) map.set(r.day, r.n);
  const out: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = Math.floor((todayMs - i * 24 * 60 * 60 * 1000) / 86400000);
    out.push(map.get(day) ?? 0);
  }
  return out;
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function ascBars(data: number[]): string {
  const max = Math.max(...data, 1);
  const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const widthMax = 54;
  // Map weekday (Mon..Sun) by reading the day-of-week of each entry.
  // `data` is in chronological order (oldest first → today last). We label
  // each bar with the weekday it represents.
  const today = new Date();
  const labels: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    labels.push(days[(d.getUTCDay() + 6) % 7] ?? '');
  }
  const lines = data.map((v, i) => {
    const w = Math.round((v / max) * widthMax);
    // Pad the bar region to widthMax so every count lands in the same
    // right-hand column — otherwise zero-days (no bar) print their value
    // flush against the label, misaligned with barred days.
    return `${labels[i]}  ${'█'.repeat(w).padEnd(widthMax)} ${String(v).padStart(3)}`;
  });
  return lines.join('\n');
}

function relTime(input: number | Date): string {
  const ms = typeof input === 'number' ? input : input.getTime();
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'NOW';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}M AGO`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}H AGO`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}D AGO`;
  const mo = Math.floor(d / 30);
  return `${mo}MO AGO`;
}

function fmtWindow(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  return h >= 48 ? `${Math.round(h / 24)}D` : `${h}H`;
}

function shortDisplayId(id: string): string {
  if (!id) return '—';
  return id.length > 12 ? id.slice(0, 8) + '…' + id.slice(-3) : id;
}

function pctOfTotal(n: number, total: number): SafeHtml {
  const pct = total > 0 ? Math.round((n / total) * 100) : 0;
  return html`<span>${pct}%</span><span>OF TOTAL</span>`;
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function displayPath(absolute: string): string {
  const home = homedir();
  if (absolute === home || absolute.startsWith(home + '/')) {
    return '~' + absolute.slice(home.length);
  }
  return absolute;
}

function systemRow(label: string, value: string, tone: 'fg' | 'lime'): SafeHtml {
  const bulletTone = tone === 'lime' ? '' : 'dim';
  const color = tone === 'lime' ? 'var(--lime)' : 'var(--fg)';
  return html`
    <div
      style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--fg-faint);padding:6px 0;gap:var(--s-4);min-width:0"
    >
      <span class="t-mono-up fg-dim" style="flex:0 0 auto;white-space:nowrap"
        ><span class="bn ${bulletTone}"></span>${label}</span
      >
      <span
        class="t-mono"
        style="color:${color};text-align:right;word-break:break-all;overflow-wrap:anywhere;min-width:0;flex:1 1 auto"
        >${value}</span
      >
    </div>
  `;
}

function renderLogin(error: string | null, next: string | null = null): string {
  const errorHtml = error ? flash({ tone: 'danger', label: 'ERROR', body: error }) : raw('');
  const nextInput = next
    ? raw(`<input type="hidden" name="next" value="${escape(next)}">`)
    : raw('');
  const body = html`
    <div class="login-stage">
      <div class="left">
        <div class="login-brand">
          <img
            class="login-logo"
            src="/dashboard/assets/logo-transparent.png"
            alt=""
            aria-hidden="true"
          />
          <div>
            <div class="t-mono-up fg-dim">REMBRIC</div>
            <div class="t-mono-up fg-dim" style="margin-top:6px">v${REMBRIC_VERSION}</div>
          </div>
        </div>
        <div>
          <h1>
            <span class="hl-lime">REMBRIC</span><br />
            DASHBOARD<span style="color:var(--lime)">.</span>
          </h1>
          <p class="t-body" style="color:var(--fg-dim);max-width:560px;margin-top:16px">
            Persistent memory layer for your agents. Single user, single SQLite file, single control
            window. No onboarding — only the
            <span class="u-lime">admin token</span> with scope <code>*</code>.
          </p>
        </div>
        <div class="clients t-mono-up fg-dim" style="display:flex;gap:24px;flex-wrap:wrap">
          <span><span class="bn"></span> CLAUDE CODE</span>
          <span><span class="bn"></span> OPENCODE</span>
          <span><span class="bn"></span> CODEX CLI</span>
          <span><span class="bn"></span> MCP CLIENTS</span>
          <span><span class="bn"></span> HERMES</span>
        </div>
      </div>
      <div class="right">
        <form
          action="/dashboard/login"
          method="post"
          class="stack"
          style="max-width:none;width:100%"
        >
          ${errorHtml}${nextInput}
          <div class="field">
            <label>Admin token</label>
            <input
              name="token"
              type="password"
              class="inp lg"
              autocomplete="off"
              required
              autofocus
              placeholder="rbr_********************"
            />
          </div>
          <div style="display:flex;gap:12px">
            ${btn({ variant: 'primary', label: 'SIGN IN →', type: 'submit' })}
          </div>
        </form>
      </div>
    </div>
  `;
  return shell(body, { title: 'Login', view: 'login' });
}

// Re-export NAV so external code (tests) can introspect the nav order.
export { NAV };
