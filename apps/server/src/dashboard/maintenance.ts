import { Hono, type Context } from 'hono';

import type { DbDiagnostics } from '../db/diagnostics.js';
import { type AgentSessionsService } from '../services/agent-sessions.js';
import { DomainError } from '../services/errors.js';
import { type MemoryService } from '../services/memory.js';
import type { PromptsService } from '../services/prompts.js';
import type { SessionsService } from '../services/sessions.js';
import type { TokensService } from '../services/tokens.js';

import { btn, flash, viewHead } from './components.js';
import { csrfInput, readFormAndVerifyCsrf } from './csrf.js';
import { renderPage } from './page-shell.js';
import { html, raw } from './templates.js';
import type { ResolvedSession } from './types.js';

export interface MaintenanceDeps {
  diagnostics: DbDiagnostics;
  sessions: SessionsService;
  agentSessions: AgentSessionsService;
  memory: MemoryService;
  prompts: PromptsService;
  tokens: TokensService;
}

function getSession(c: Context): ResolvedSession | null {
  return (c.get('session') as ResolvedSession | undefined) ?? null;
}

/**
 * Verify the caller has scope='*' on the bearer token backing the
 * dashboard session. The login flow already enforces this, but the
 * maintenance page is destructive enough to warrant defense-in-depth in
 * case the auth contract is ever relaxed.
 */
function requireAdmin(
  c: Context,
  deps: MaintenanceDeps,
): { session: ResolvedSession; forbidden: null } | { session: null; forbidden: Response } {
  const session = getSession(c);
  if (!session) {
    return { session: null, forbidden: c.redirect('/dashboard/login') };
  }
  const token = deps.tokens.findById(session.tokenId);
  if (!token || token.scope !== '*') {
    return {
      session: null,
      forbidden: c.html(
        renderPage(
          c,
          deps.sessions,
          html`<p class="flash error">
            Maintenance requires an admin-scoped (<code>*</code>) token. Your session token is
            scoped to <code>${token?.scope ?? '(unknown)'}</code>.
          </p>`,
          { title: 'Maintenance', activeNav: 'maintenance' },
        ),
        403,
      ),
    };
  }
  return { session, forbidden: null };
}

interface DbBreakdown {
  totalBytes: number;
  freelistBytes: number;
  perTable: { name: string; bytes: number; rowCount: number | null }[];
  source: 'dbstat' | 'row-counts';
}

const BREAKDOWN_TABLES = [
  'memory',
  'memory_vec',
  'memory_fts',
  'memory_relations',
  'sessions',
  'prompts',
  'confirmations',
  'consolidation_ops',
  'consolidation_runs',
  'tokens',
  'projects',
];

function readBreakdown(diagnostics: DbDiagnostics): DbBreakdown {
  const size = diagnostics.readDbSize();
  const totalBytes = size.totalBytes;
  const freelistBytes = size.freelistBytes;

  const perTable: DbBreakdown['perTable'] = [];
  let source: DbBreakdown['source'] = 'row-counts';
  const byName = diagnostics.readDbstatBytes();
  if (byName && byName.size > 0) {
    source = 'dbstat';
    for (const t of BREAKDOWN_TABLES) {
      const b = byName.get(t);
      if (b == null) continue;
      perTable.push({ name: t, bytes: b, rowCount: diagnostics.countTableRows(t) });
    }
    perTable.sort((a, b) => b.bytes - a.bytes);
  }

  if (perTable.length === 0) {
    for (const t of BREAKDOWN_TABLES) {
      const rc = diagnostics.countTableRows(t);
      if (rc == null) continue;
      perTable.push({ name: t, bytes: 0, rowCount: rc });
    }
    perTable.sort((a, b) => (b.rowCount ?? 0) - (a.rowCount ?? 0));
  }

  return { totalBytes, freelistBytes, perTable, source };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function createMaintenanceRouter(deps: MaintenanceDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const guard = requireAdmin(c, deps);
    if (guard.forbidden) return guard.forbidden;
    const session = guard.session;

    const url = new URL(c.req.url);
    const purgedSessions = url.searchParams.get('purged-sessions');
    const purgedMemories = url.searchParams.get('purged-memories');
    const purgedPrompts = url.searchParams.get('purged-prompts');

    const emptyCount = deps.agentSessions.countPurgeableEmpty();
    const archivedCount = deps.memory.countPurgeableDisconnectedArchived();
    const deletedPromptsCount = deps.prompts.countPurgeableDeleted();
    const breakdown = readBreakdown(deps.diagnostics);

    const flashBanner =
      purgedSessions !== null
        ? flash({
            tone: 'success',
            label: 'PURGED',
            body: html`Removed ${purgedSessions} empty session row(s).`,
          })
        : purgedMemories !== null
          ? flash({
              tone: 'success',
              label: 'PURGED',
              body: html`Removed ${purgedMemories} disconnected archived memory row(s).`,
            })
          : purgedPrompts !== null
            ? flash({
                tone: 'success',
                label: 'PURGED',
                body: html`Removed ${purgedPrompts} deleted prompt row(s).`,
              })
            : raw('');

    const breakdownRows = breakdown.perTable.map(
      (r) => html`
        <tr>
          <td>${r.name}</td>
          <td>${r.rowCount ?? '—'}</td>
          <td>${breakdown.source === 'dbstat' ? formatBytes(r.bytes) : '—'}</td>
        </tr>
      `,
    );

    const sessionBtn =
      emptyCount > 0
        ? html`
            <form
              action="/dashboard/maintenance/purge-sessions"
              method="post"
              data-confirm="Purge ${emptyCount} empty session row(s)? This is irreversible. The deletion is journaled in consolidation_ops for audit."
              data-confirm-label="PURGE ${emptyCount} SESSIONS"
              data-confirm-tone="danger"
            >
              ${csrfInput(session.session, deps.sessions, 'maintenance.purge-sessions')}
              <button class="btn danger" type="submit">PURGE EMPTY SESSIONS (${emptyCount})</button>
            </form>
          `
        : btn({ variant: 'secondary', label: 'NO EMPTY SESSIONS TO PURGE', disabled: true });

    const memoryBtn =
      archivedCount > 0
        ? html`
            <form
              action="/dashboard/maintenance/purge-archived-memories"
              method="post"
              data-confirm="Purge ${archivedCount} disconnected archived memory row(s)? This is irreversible. memory_vec and memory_fts shadow rows are also removed. The deletion is journaled in consolidation_ops for audit."
              data-confirm-label="PURGE ${archivedCount} MEMORIES"
              data-confirm-tone="danger"
            >
              ${csrfInput(session.session, deps.sessions, 'maintenance.purge-archived-memories')}
              <button class="btn danger" type="submit">
                PURGE DISCONNECTED ARCHIVED (${archivedCount})
              </button>
            </form>
          `
        : btn({
            variant: 'secondary',
            label: 'NO DISCONNECTED ARCHIVED TO PURGE',
            disabled: true,
          });

    const promptBtn =
      deletedPromptsCount > 0
        ? html`
            <form
              action="/dashboard/maintenance/purge-prompts"
              method="post"
              data-confirm="Purge ${deletedPromptsCount} soft-deleted prompt row(s)? This is irreversible. prompts_fts shadow rows are also removed. The deletion is journaled in consolidation_ops for audit."
              data-confirm-label="PURGE ${deletedPromptsCount} PROMPTS"
              data-confirm-tone="danger"
            >
              ${csrfInput(session.session, deps.sessions, 'maintenance.purge-prompts')}
              <button class="btn danger" type="submit">
                PURGE DELETED PROMPTS (${deletedPromptsCount})
              </button>
            </form>
          `
        : btn({
            variant: 'secondary',
            label: 'NO DELETED PROMPTS TO PURGE',
            disabled: true,
          });

    const body = html`
      ${viewHead({
        num: '08',
        title: 'Rembric Maintenance.',
        hl: 'Rembric',
        meta: [{ k: 'ADMIN ONLY', v: '*' }],
      })}
      ${flashBanner}

      <section class="maint-breakdown">
        <h3>DB BREAKDOWN</h3>
        <p class="small muted">
          Total: <b>${formatBytes(breakdown.totalBytes)}</b> · Freelist:
          <b>${formatBytes(breakdown.freelistBytes)}</b>
          ${breakdown.freelistBytes > 0 ? html` · Run <code>VACUUM</code> to reclaim` : raw('')} ·
          Source: <code>${breakdown.source}</code>
        </p>
        <table>
          <thead>
            <tr>
              <th style="text-align:left">TABLE</th>
              <th style="text-align:left">ROWS</th>
              <th style="text-align:right">BYTES</th>
            </tr>
          </thead>
          <tbody>
            ${breakdownRows}
            <tr class="total">
              <td>TOTAL FILE</td>
              <td>—</td>
              <td>${formatBytes(breakdown.totalBytes)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="maint-grid">
        <div class="maint-card">
          <div class="head">
            <h3>Empty Sessions</h3>
            <span class="count ${emptyCount === 0 ? 'zero' : ''}">${emptyCount}</span>
          </div>
          <div class="body">
            <p>Eligible rows match ALL of:</p>
            <ul>
              <li>status = ended or abandoned</li>
              <li>zero memories, prompts, confirmations referencing</li>
              <li>no summary written, no manual title</li>
              <li>not operator-soft-deleted</li>
              <li>ended over 1 hour ago (late summary grace)</li>
            </ul>
          </div>
          <div class="actions">${sessionBtn}</div>
        </div>

        <div class="maint-card">
          <div class="head">
            <h3>Disconnected Archived Memories</h3>
            <span class="count ${archivedCount === 0 ? 'zero' : ''}">${archivedCount}</span>
          </div>
          <div class="body">
            <p>Eligible rows match ALL of:</p>
            <ul>
              <li>status = archived</li>
              <li>no other memory's <code>replaces</code> points here</li>
              <li>no consolidation_ops affects this id</li>
              <li>no memory_relations references this id</li>
              <li>no confirmations target this id</li>
            </ul>
            <p>memory_vec + memory_fts shadow rows are dropped in the same transaction.</p>
          </div>
          <div class="actions">${memoryBtn}</div>
        </div>

        <div class="maint-card">
          <div class="head">
            <h3>Deleted Prompts</h3>
            <span class="count ${deletedPromptsCount === 0 ? 'zero' : ''}"
              >${deletedPromptsCount}</span
            >
          </div>
          <div class="body">
            <p>Eligible rows match:</p>
            <ul>
              <li><code>deleted_at IS NOT NULL</code></li>
            </ul>
            <p>
              Covers both operator soft-deletes (from <code>/dashboard/prompts</code>) and refine
              supersedes (from <code>memory.save_prompt({ replaces })</code>). The
              <code>prompts_fts</code> shadow row is dropped in the same transaction.
            </p>
          </div>
          <div class="actions">${promptBtn}</div>
        </div>
      </section>
    `;

    return c.html(
      renderPage(c, deps.sessions, body, {
        title: 'Maintenance',
        activeNav: 'maintenance',
        view: 'maintenance',
      }),
    );
  });

  app.post('/purge-sessions', async (c) => {
    const guard = requireAdmin(c, deps);
    if (guard.forbidden) return guard.forbidden;
    const session = guard.session;
    const form = await readFormAndVerifyCsrf(
      c,
      session.session,
      deps.sessions,
      'maintenance.purge-sessions',
    );
    if (form instanceof Response) return form;

    try {
      const { deletedIds } = deps.agentSessions.purgeEmpty({ adminBypass: true });
      return c.redirect(`/dashboard/maintenance?purged-sessions=${deletedIds.length}`);
    } catch (err) {
      if (err instanceof DomainError) {
        return c.html(
          renderPage(c, deps.sessions, html`<p class="flash error">${err.message}</p>`, {
            title: 'Maintenance',
            activeNav: 'maintenance',
          }),
          err.code === 'forbidden' ? 403 : 400,
        );
      }
      throw err;
    }
  });

  app.post('/purge-archived-memories', async (c) => {
    const guard = requireAdmin(c, deps);
    if (guard.forbidden) return guard.forbidden;
    const session = guard.session;
    const form = await readFormAndVerifyCsrf(
      c,
      session.session,
      deps.sessions,
      'maintenance.purge-archived-memories',
    );
    if (form instanceof Response) return form;

    try {
      const { deletedIds } = deps.memory.purgeDisconnectedArchived({ adminBypass: true });
      return c.redirect(`/dashboard/maintenance?purged-memories=${deletedIds.length}`);
    } catch (err) {
      if (err instanceof DomainError) {
        return c.html(
          renderPage(c, deps.sessions, html`<p class="flash error">${err.message}</p>`, {
            title: 'Maintenance',
            activeNav: 'maintenance',
          }),
          err.code === 'forbidden' ? 403 : 400,
        );
      }
      throw err;
    }
  });

  app.post('/purge-prompts', async (c) => {
    const guard = requireAdmin(c, deps);
    if (guard.forbidden) return guard.forbidden;
    const session = guard.session;
    const form = await readFormAndVerifyCsrf(
      c,
      session.session,
      deps.sessions,
      'maintenance.purge-prompts',
    );
    if (form instanceof Response) return form;

    try {
      const { deletedIds } = deps.prompts.purgeDeleted({ adminBypass: true });
      return c.redirect(`/dashboard/maintenance?purged-prompts=${deletedIds.length}`);
    } catch (err) {
      if (err instanceof DomainError) {
        return c.html(
          renderPage(c, deps.sessions, html`<p class="flash error">${err.message}</p>`, {
            title: 'Maintenance',
            activeNav: 'maintenance',
          }),
          err.code === 'forbidden' ? 403 : 400,
        );
      }
      throw err;
    }
  });

  return app;
}
