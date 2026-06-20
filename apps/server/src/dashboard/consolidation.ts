import { Hono, type Context } from 'hono';

import type { ConsolidationRunSummary } from '../consolidation/index.js';
import { NotUndoableError, PurgedRowMissingError } from '../consolidation/operations.js';
import type { Repositories } from '../db/repositories/index.js';
import type { SessionsService } from '../services/sessions.js';

import { backLink, PAGE_SIZE, pager, urlWithPage, viewHead } from './components.js';
import { readFormAndVerifyCsrf, csrfInput } from './csrf.js';
import { renderPage } from './page-shell.js';
import { formatTs, html, raw, shortId } from './templates.js';
import type { ResolvedSession } from './types.js';

export interface ConsolidationDeps {
  repos: Repositories;
  sessions: SessionsService;
  /** Forced sweep across all scopes (same lambda as the admin endpoint). */
  triggerSweep: () => ConsolidationRunSummary;
  /** Bound consolidation undo lambdas (wired in bootstrap). */
  undoRun: (runId: string) => void;
  undoOp: (opId: string) => void;
}

function getSession(c: Context): ResolvedSession | null {
  return (c.get('session') as ResolvedSession | undefined) ?? null;
}

/** `project:<id>` → project slug when the project still exists; raw value otherwise. */
function scopeLabel(repos: Repositories, scope: string | null): string {
  if (scope === null) return '—';
  if (!scope.startsWith('project:')) return scope;
  const row = repos.projects.adminFindById(scope.slice('project:'.length));
  return row?.slug ?? scope;
}

/** Sweep runs store `{"archives":N,"orphaned":M}`; legacy LLM runs store prose. */
function formatRunSummary(summary: string | null): string {
  if (summary === null) return '—';
  try {
    const parsed: unknown = JSON.parse(summary);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>)['archives'] === 'number' &&
      typeof (parsed as Record<string, unknown>)['orphaned'] === 'number'
    ) {
      const ops = parsed as { archives: number; orphaned: number };
      return `${ops.archives} archived · ${ops.orphaned} orphaned`;
    }
  } catch {
    // Legacy prose summary — fall through to the raw text.
  }
  return summary;
}

export function createConsolidationRouter(deps: ConsolidationDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const url = new URL(c.req.url);
    const page = Math.max(0, parseInt(url.searchParams.get('page') ?? '0', 10) || 0);
    const offset = page * PAGE_SIZE;

    const runsRaw = deps.repos.consolidation.adminListRuns(PAGE_SIZE + 1, offset);
    const hasMore = runsRaw.length > PAGE_SIZE;
    const runs = runsRaw.slice(0, PAGE_SIZE);

    const opCountByRun = new Map<string, { total: number; reverted: number }>();
    for (const run of runs) {
      opCountByRun.set(run.id, deps.repos.consolidation.adminOpCounts(run.id));
    }

    const rows = runs.map((r) => {
      const counts = opCountByRun.get(r.id) ?? { total: 0, reverted: 0 };
      const status =
        counts.total === 0
          ? raw('<span class="pill muted">no-op</span>')
          : counts.reverted === counts.total
            ? raw('<span class="pill archived">fully reverted</span>')
            : counts.reverted > 0
              ? raw(
                  `<span class="pill superseded">${counts.reverted}/${counts.total} reverted</span>`,
                )
              : raw(`<span class="pill active">${counts.total} ops</span>`);

      return html`
        <tr data-href="/dashboard/consolidation/${r.id}">
          <td class="muted">
            <a href="/dashboard/consolidation/${r.id}">${formatTs(r.startedAt)}</a>
          </td>
          <td class="muted">${formatTs(r.finishedAt)}</td>
          <td>${scopeLabel(deps.repos, r.scope)}</td>
          <td>${status}</td>
        </tr>
      `;
    });

    const sweepForm = html`
      <form
        action="/dashboard/consolidation/run"
        method="post"
        class="inline"
        data-confirm="Force a consolidation sweep across all scopes now? Ops are journaled and reversible."
        data-confirm-label="RUN SWEEP"
        data-confirm-tone="warn"
      >
        ${csrfInput(session.session, deps.sessions, 'sweep.run')}
        <button class="warn" type="submit">Run sweep now</button>
      </form>
    `;

    const body = html`
      ${viewHead({
        num: '05',
        title: 'Rembric Consolidation.',
        hl: 'Rembric',
        meta: [{ k: 'RUNS', v: String(runs.length) }],
      })}
      <p>${sweepForm}</p>
      ${runs.length === 0
        ? html`<p class="muted">
            No runs yet. The deterministic sweep runs on session start (throttled per scope); force
            one with “Run sweep now”.
          </p>`
        : html`
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>started</th>
                    <th>finished</th>
                    <th>scope</th>
                    <th>status</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows}
                </tbody>
              </table>
            </div>
          `}
      ${runs.length > 0 || page > 0
        ? pager({
            page,
            hasMore,
            pageHrefBuilder: (p) => urlWithPage(c.req.url, p),
            totalLabel: `${runs.length} ROWS`,
          })
        : raw('')}
    `;
    return c.html(
      renderPage(c, deps.sessions, body, { title: 'Consolidation', activeNav: 'consolidation' }),
    );
  });

  app.post('/run', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'sweep.run');
    if (form instanceof Response) return form;
    deps.triggerSweep();
    return c.redirect('/dashboard/consolidation');
  });

  app.get('/:id', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const id = c.req.param('id');
    const run = deps.repos.consolidation.adminGetRun(id);
    if (!run) {
      return c.html(
        renderPage(c, deps.sessions, html`<p class="flash error">Run not found.</p>`, {
          title: 'Consolidation',
          activeNav: 'consolidation',
        }),
        404,
      );
    }

    const ops = deps.repos.consolidation.adminListOps(id);

    const isPurgeOp = (t: string) => t === 'session_purge' || t === 'archived_memory_purge';

    const opsHtml = ops.map((op) => {
      const isReverted = op.revertedAt !== null;
      const pillTone = isPurgeOp(op.opType) ? 'archived' : '';
      const undoForm = isReverted
        ? raw('<span class="muted small">reverted</span>')
        : isPurgeOp(op.opType)
          ? raw('<span class="muted small">terminal (not undoable)</span>')
          : html`
              <form
                action="/dashboard/consolidation/op/${op.id}/undo"
                method="post"
                class="inline"
                data-confirm="Revert this consolidation op? Affected memories will return to their pre-op status. This is journaled and itself reversible."
                data-confirm-label="UNDO OP"
                data-confirm-tone="warn"
              >
                ${csrfInput(session.session, deps.sessions, 'op.undo')}
                <button class="warn" type="submit">Undo this op</button>
              </form>
            `;
      return html`
        <tr>
          <td><span class="pill ${pillTone}">${op.opType}</span></td>
          <td class="mono small">
            ${op.affectedIds.map((m) =>
              raw(`<a href="/dashboard/memories/${m}">${shortId(m)}</a>`),
            )}
          </td>
          <td class="mono">
            ${op.createdId
              ? raw(`<a href="/dashboard/memories/${op.createdId}">${shortId(op.createdId)}</a>`)
              : '—'}
          </td>
          <td class="small">${op.reasoning ?? '—'}</td>
          <td class="muted">${formatTs(op.appliedAt)}</td>
          <td>${undoForm}</td>
        </tr>
      `;
    });

    const hasAnyActiveOps = ops.some((o) => o.revertedAt === null);
    const undoRunForm = hasAnyActiveOps
      ? html`
          <form
            action="/dashboard/consolidation/${run.id}/undo"
            method="post"
            class="inline"
            data-confirm="Revert every op in this run? All affected memories will return to their pre-run status."
            data-confirm-label="UNDO ENTIRE RUN"
            data-confirm-tone="danger"
          >
            ${csrfInput(session.session, deps.sessions, 'run.undo')}
            <button class="danger" type="submit">Undo entire run</button>
          </form>
        `
      : raw('<span class="muted small">all ops reverted</span>');

    const body = html`
      ${viewHead({
        num: '05',
        title: `Rembric Run ${shortId(run.id)}.`,
        hl: 'Rembric',
        meta: [{ k: 'OPS', v: String(ops.length) }],
      })}
      ${backLink({ href: '/dashboard/consolidation', label: 'BACK TO CONSOLIDATION' })}
      <div class="stat-grid">
        <div class="stat-card">
          <div class="label">Started</div>
          <div class="value" style="font-size:.9rem">${formatTs(run.startedAt)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Finished</div>
          <div class="value" style="font-size:.9rem">${formatTs(run.finishedAt)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Scope</div>
          <div class="value">${scopeLabel(deps.repos, run.scope)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Ops</div>
          <div class="value">${ops.length}</div>
        </div>
      </div>

      <h2>Summary</h2>
      <pre>${formatRunSummary(run.summary)}</pre>

      <h2>Ops</h2>
      ${ops.length === 0
        ? html`<p class="muted">No operations were recorded for this run.</p>`
        : html`
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>type</th>
                    <th>affected</th>
                    <th>created</th>
                    <th>reasoning</th>
                    <th>applied</th>
                    <th>action</th>
                  </tr>
                </thead>
                <tbody>
                  ${opsHtml}
                </tbody>
              </table>
            </div>
          `}

      <h2>Run actions</h2>
      <p>${undoRunForm}</p>
    `;
    return c.html(
      renderPage(c, deps.sessions, body, {
        title: `Run ${shortId(run.id)}`,
        activeNav: 'consolidation',
      }),
    );
  });

  function renderUndoError(c: Context, err: unknown): Response {
    if (err instanceof PurgedRowMissingError) {
      return c.html(
        renderPage(
          c,
          deps.sessions,
          html`<p class="flash error">
            <b>Undo blocked.</b> ${err.missing.length} memory row(s) referenced by this op have been
            purged after the op ran; their state cannot be reconstructed. Missing ids:
            <code>${err.missing.join(', ')}</code>.
          </p>`,
          { title: 'Consolidation', activeNav: 'consolidation' },
        ),
        409,
      );
    }
    if (err instanceof NotUndoableError) {
      return c.html(
        renderPage(
          c,
          deps.sessions,
          html`<p class="flash">
            <b>Not undoable.</b> Purge operations are terminal — the rows they removed cannot be
            reconstructed.
          </p>`,
          { title: 'Consolidation', activeNav: 'consolidation' },
        ),
        409,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.html(
      renderPage(c, deps.sessions, html`<p class="flash error">${message}</p>`, {
        title: 'Consolidation',
        activeNav: 'consolidation',
      }),
      400,
    );
  }

  app.post('/:id/undo', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'run.undo');
    if (form instanceof Response) return form;
    const id = c.req.param('id');
    try {
      deps.undoRun(id);
    } catch (err) {
      return renderUndoError(c, err);
    }
    return c.redirect(`/dashboard/consolidation/${id}`);
  });

  app.post('/op/:opId/undo', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'op.undo');
    if (form instanceof Response) return form;
    const opId = c.req.param('opId');
    const op = deps.repos.consolidation.adminGetOp(opId);
    try {
      deps.undoOp(opId);
    } catch (err) {
      return renderUndoError(c, err);
    }
    return c.redirect(`/dashboard/consolidation/${op?.runId ?? ''}`);
  });

  return app;
}
