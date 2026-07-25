import { createReadStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { Hono, type Context } from 'hono';

import type { DbDiagnostics } from '../db/diagnostics.js';
import { type AgentSessionsService } from '../services/agent-sessions.js';
import { DomainError } from '../services/errors.js';
import { type MemoryService } from '../services/memory.js';
import type { PromptsService } from '../services/prompts.js';
import { BACKUP_PREFIX as PRE_UPDATE_BACKUP_PREFIX } from '../services/self-update/orchestrator.js';
import type { SessionsService } from '../services/sessions.js';
import type { TokensService } from '../services/tokens.js';

import { btn, domainErrorPage, flash, flashErrorPage, getSession, viewHead } from './components.js';
import { csrfInput, readFormAndVerifyCsrf } from './csrf.js';
import { renderPage } from './page-shell.js';
import { formatTs, html, raw } from './templates.js';
import type { ResolvedSession } from './types.js';

export interface MaintenanceDeps {
  diagnostics: DbDiagnostics;
  sessions: SessionsService;
  agentSessions: AgentSessionsService;
  memory: MemoryService;
  prompts: PromptsService;
  tokens: TokensService;
  /** Resolved data directory — on-demand backups land in `<dataDir>/backups`. */
  dataDir: string;
}

const ON_DEMAND_BACKUP_PREFIX = 'on-demand-';
const ON_DEMAND_BACKUP_KEEP = 3;
/** Exact shape a downloadable backup filename must have — no path traversal. */
const BACKUP_FILENAME_RE = new RegExp(
  `^(?:${ON_DEMAND_BACKUP_PREFIX}|${PRE_UPDATE_BACKUP_PREFIX})[A-Za-z0-9._-]+\\.sqlite$`,
);

function backupsDir(dataDir: string): string {
  return join(dataDir, 'backups');
}

interface OnDemandBackup {
  file: string;
  path: string;
  createdAt: Date;
  sizeBytes: number;
}

interface AnyBackup extends OnDemandBackup {
  kind: 'on-demand' | 'pre-update';
}

/** Backup filenames newest-first (the `on-demand-<ms>` name sorts chronologically). */
function listOnDemandBackupsDesc(dir: string): string[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.startsWith(ON_DEMAND_BACKUP_PREFIX) && f.endsWith('.sqlite'))
    .sort()
    .reverse();
}

function latestOnDemandBackup(dataDir: string): OnDemandBackup | null {
  return listAllBackupsDesc(dataDir).find((b) => b.kind === 'on-demand') ?? null;
}

/**
 * Every downloadable snapshot in `backups/` — on-demand AND pre-update —
 * newest first. The mandatory pre-update snapshot the self-update flow
 * takes before every upgrade was previously undownloadable (only the latest
 * on-demand file had a download link).
 */
function listAllBackupsDesc(dataDir: string): AnyBackup[] {
  const dir = backupsDir(dataDir);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const rows = files
    .filter((f) => BACKUP_FILENAME_RE.test(f))
    .map((f): AnyBackup => {
      const path = join(dir, f);
      const stat = statSync(path);
      return {
        file: f,
        path,
        createdAt: stat.mtime,
        sizeBytes: stat.size,
        kind: f.startsWith(PRE_UPDATE_BACKUP_PREFIX) ? 'pre-update' : 'on-demand',
      };
    });
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Snapshot the live DB via `VACUUM INTO` and prune older on-demand backups. */
function createOnDemandBackup(deps: MaintenanceDeps): OnDemandBackup {
  const dir = backupsDir(deps.dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = `${ON_DEMAND_BACKUP_PREFIX}${Date.now()}.sqlite`;
  const path = join(dir, file);
  deps.diagnostics.vacuumInto(path);

  for (const f of listOnDemandBackupsDesc(dir).slice(ON_DEMAND_BACKUP_KEEP)) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      /* retention is best-effort; never fail the backup over it */
    }
  }

  const stat = statSync(path);
  return { file, path, createdAt: stat.mtime, sizeBytes: stat.size };
}

/**
 * Verify the caller has scope='*' on the bearer token backing the
 * dashboard session. The login flow already enforces this, but the
 * maintenance page is destructive enough to warrant defense-in-depth in
 * case the auth contract is ever relaxed.
 */
/** Shared by other admin-gated dashboard actions (e.g. the entities rebuild). */
export function requireAdmin(
  c: Context,
  deps: { tokens: TokensService; sessions: SessionsService },
  page: { title: string; activeNav: 'maintenance' | 'entities' } = {
    title: 'Maintenance',
    activeNav: 'maintenance',
  },
): { session: ResolvedSession; forbidden: null } | { session: null; forbidden: Response } {
  const session = getSession(c);
  if (!session) {
    return { session: null, forbidden: c.redirect('/dashboard/login') };
  }
  const token = deps.tokens.findById(session.tokenId);
  if (!token || token.scope !== '*') {
    return {
      session: null,
      forbidden: flashErrorPage(
        c,
        deps.sessions,
        html`This action requires an admin-scoped (<code>*</code>) token. Your session token is
          scoped to <code>${token?.scope ?? '(unknown)'}</code>.`,
        page,
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
    const backedUp = url.searchParams.get('backed-up');

    const emptyCount = deps.agentSessions.countPurgeableEmpty();
    const archivedCount = deps.memory.countPurgeableDisconnectedArchived();
    const deletedPromptsCount = deps.prompts.countPurgeableDeleted();
    const breakdown = readBreakdown(deps.diagnostics);
    const latestBackup = latestOnDemandBackup(deps.dataDir);
    const allBackups = listAllBackupsDesc(deps.dataDir);

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
            : backedUp !== null
              ? flash({
                  tone: 'success',
                  label: 'BACKED UP',
                  body: html`Snapshot written (${backedUp} bytes).`,
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

        <div class="maint-card">
          <div class="head">
            <h3>Backup Database</h3>
          </div>
          <div class="body">
            <p>
              Writes a consistent, WAL-safe snapshot of the live database via
              <code>VACUUM INTO</code> (the same mechanism the self-update flow uses before every
              upgrade), keeping the ${ON_DEMAND_BACKUP_KEEP} most recent on-demand snapshots.
            </p>
            ${latestBackup
              ? html`<p class="small muted">
                  Last backup: ${formatTs(latestBackup.createdAt)} ·
                  ${formatBytes(latestBackup.sizeBytes)} ·
                  <a href="/dashboard/maintenance/backup/download">Download latest</a>
                </p>`
              : html`<p class="small muted">No on-demand backup yet.</p>`}
            ${allBackups.length > 0
              ? html`
                  <p class="small muted">
                    Every snapshot in <code>backups/</code> is individually downloadable, including
                    the pre-update snapshot the self-update flow takes before every upgrade:
                  </p>
                  <ul class="small">
                    ${allBackups.map(
                      (b) => html`
                        <li>
                          <a href="/dashboard/maintenance/backup/download/${b.file}">${b.kind}</a>
                          · ${formatTs(b.createdAt)} · ${formatBytes(b.sizeBytes)}
                        </li>
                      `,
                    )}
                  </ul>
                `
              : raw('')}
          </div>
          <div class="actions">
            <form
              action="/dashboard/maintenance/backup"
              method="post"
              data-confirm="Write a fresh database snapshot now? This is reversible — it only reads the live database and writes a new file; nothing existing is modified."
              data-confirm-label="BACKUP NOW"
              data-confirm-tone="warn"
            >
              ${csrfInput(session.session, deps.sessions, 'maintenance.backup')}
              <button class="btn" type="submit">BACKUP NOW</button>
            </form>
          </div>
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
        return domainErrorPage(
          c,
          deps.sessions,
          err,
          { title: 'Maintenance', activeNav: 'maintenance' },
          (code) => (code === 'forbidden' ? 403 : 400),
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
        return domainErrorPage(
          c,
          deps.sessions,
          err,
          { title: 'Maintenance', activeNav: 'maintenance' },
          (code) => (code === 'forbidden' ? 403 : 400),
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
        return domainErrorPage(
          c,
          deps.sessions,
          err,
          { title: 'Maintenance', activeNav: 'maintenance' },
          (code) => (code === 'forbidden' ? 403 : 400),
        );
      }
      throw err;
    }
  });

  app.post('/backup', async (c) => {
    const guard = requireAdmin(c, deps);
    if (guard.forbidden) return guard.forbidden;
    const session = guard.session;
    const form = await readFormAndVerifyCsrf(
      c,
      session.session,
      deps.sessions,
      'maintenance.backup',
    );
    if (form instanceof Response) return form;

    const backup = createOnDemandBackup(deps);
    return c.redirect(`/dashboard/maintenance?backed-up=${backup.sizeBytes}`);
  });

  app.get('/backup/download', (c) => {
    const guard = requireAdmin(c, deps);
    if (guard.forbidden) return guard.forbidden;

    const backup = latestOnDemandBackup(deps.dataDir);
    if (!backup) {
      return flashErrorPage(c, deps.sessions, 'No on-demand backup exists yet.', {
        title: 'Maintenance',
        activeNav: 'maintenance',
      });
    }
    return streamBackup(c, backup);
  });

  // Download any snapshot in backups/ by filename — including pre-update
  // snapshots, previously undownloadable. `BACKUP_FILENAME_RE` is the only
  // gate: it pins the exact producer-generated shape (no `/`, no `..`), so
  // there is no path-traversal surface even though the filename comes from
  // the URL.
  app.get('/backup/download/:file', (c) => {
    const guard = requireAdmin(c, deps);
    if (guard.forbidden) return guard.forbidden;

    const file = c.req.param('file');
    if (!BACKUP_FILENAME_RE.test(file)) {
      return flashErrorPage(c, deps.sessions, 'Not a valid backup filename.', {
        title: 'Maintenance',
        activeNav: 'maintenance',
      });
    }
    const path = join(backupsDir(deps.dataDir), file);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      return flashErrorPage(c, deps.sessions, 'That backup no longer exists.', {
        title: 'Maintenance',
        activeNav: 'maintenance',
      });
    }
    return streamBackup(c, { file, path, createdAt: stat.mtime, sizeBytes: stat.size });
  });

  return app;
}

function streamBackup(c: Context, backup: OnDemandBackup): Response {
  // Stream rather than readFileSync — the snapshot scales with the whole
  // memory corpus, so a full read would spike memory on large installs.
  const body = Readable.toWeb(createReadStream(backup.path)) as ReadableStream;
  return c.body(body, 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(backup.sizeBytes),
    'Content-Disposition': `attachment; filename="${backup.file}"`,
  });
}
