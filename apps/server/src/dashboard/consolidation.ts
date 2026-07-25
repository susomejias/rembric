import { Hono, type Context } from 'hono';

import type { ConsolidationRunSummary, SkippedRow } from '../consolidation/index.js';
import {
  NotUndoableError,
  PurgedRowMissingError,
  TERMINAL_OP_TYPES,
  type ConsolidationOpType,
} from '../consolidation/operations.js';
import type { Repositories } from '../db/repositories/index.js';
import type { SessionsService } from '../services/sessions.js';

import {
  backLink,
  flash,
  flashErrorPage,
  getSession,
  kv,
  kvGrid,
  PAGE_SIZE,
  pageParam,
  pager,
  tblEmpty,
  urlWithPage,
  viewHead,
} from './components.js';
import { readFormAndVerifyCsrf, csrfInput } from './csrf.js';
import { renderPage } from './page-shell.js';
import { formatTs, html, raw, shortId } from './templates.js';

export interface ConsolidationDeps {
  repos: Repositories;
  sessions: SessionsService;
  /** Forced sweep across all scopes (same lambda as the admin endpoint). */
  triggerSweep: () => ConsolidationRunSummary;
  /** Bound consolidation undo lambdas (wired in bootstrap). */
  undoRun: (runId: string) => { reverted: string[]; skipped: SkippedRow[] };
  undoOp: (opId: string) => { reverted: string; skipped: SkippedRow[] };
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
    const page = pageParam(url);
    const offset = page * PAGE_SIZE;
    const purgedSessions = url.searchParams.get('purged-sessions');

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
        data-confirm="Force a consolidation sweep across all scopes now? Decay/orphan ops are journaled and reversible, but this also purges empty sessions — that purge is irreversible."
        data-confirm-label="RUN SWEEP"
        data-confirm-tone="danger"
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
        meta: [{ k: 'TOTAL', v: String(deps.repos.consolidation.adminCountRuns()) }],
      })}
      ${purgedSessions !== null
        ? flash({
            tone: 'success',
            label: 'PURGED',
            body: html`Removed ${purgedSessions} empty session row(s) as part of this sweep.`,
          })
        : raw('')}
      <p>${sweepForm}</p>
      ${runs.length === 0
        ? tblEmpty(
            'No runs yet. The deterministic sweep runs on session start (throttled per scope); force one with “Run sweep now”.',
          )
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
    const summary = deps.triggerSweep();
    const purgedCount = summary.purgedSessionIds?.length ?? 0;
    return c.redirect(
      purgedCount > 0
        ? `/dashboard/consolidation?purged-sessions=${purgedCount}`
        : '/dashboard/consolidation',
    );
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

    const isPurgeOp = (t: ConsolidationOpType) => TERMINAL_OP_TYPES.has(t);

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
      ${kvGrid([
        kv({ k: 'Started', v: formatTs(run.startedAt) }),
        kv({ k: 'Finished', v: formatTs(run.finishedAt) }),
        kv({ k: 'Scope', v: scopeLabel(deps.repos, run.scope) }),
        kv({ k: 'Ops', v: ops.length }),
      ])}

      <h2>Summary</h2>
      <pre>${formatRunSummary(run.summary)}</pre>

      <h2>Ops</h2>
      ${ops.length === 0
        ? tblEmpty('No operations were recorded for this run.')
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
    const view = { title: 'Consolidation', activeNav: 'consolidation' } as const;
    if (err instanceof PurgedRowMissingError) {
      return flashErrorPage(
        c,
        deps.sessions,
        html`<b>Undo blocked.</b> ${err.missing.length} memory row(s) referenced by this op have
          been purged after the op ran; their state cannot be reconstructed. Missing ids:
          <code>${err.missing.join(', ')}</code>.`,
        view,
        409,
      );
    }
    if (err instanceof NotUndoableError) {
      // Not a "flash error" tone — purge is terminal-by-design, not a failure.
      return c.html(
        renderPage(
          c,
          deps.sessions,
          html`<p class="flash">
            <b>Not undoable.</b> Purge operations are terminal — the rows they removed cannot be
            reconstructed.
          </p>`,
          view,
        ),
        409,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return flashErrorPage(c, deps.sessions, message, view, 400);
  }

  function renderPartialUndo(c: Context, runId: string, skipped: SkippedRow[]): Response {
    const view = { title: 'Consolidation', activeNav: 'consolidation' } as const;
    const rows = skipped.map(
      (s) =>
        html`<li>
          <code>${shortId(s.id)}</code> — topic <code>${s.topicKey}</code> is now held by
          <code>${shortId(s.occupiedBy)}</code>
        </li>`,
    );
    return c.html(
      renderPage(
        c,
        deps.sessions,
        html`${flash({
            tone: 'warn',
            label: 'PARTIAL UNDO',
            body: html`${skipped.length} row(s) were not reactivated — a newer memory now owns their
            topic slot. The rest of the undo was applied.`,
          })}
          <ul>
            ${rows}
          </ul>
          <p>${backLink({ href: `/dashboard/consolidation/${runId}`, label: 'Back to run' })}</p>`,
        view,
      ),
      200,
    );
  }

  app.post('/:id/undo', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'run.undo');
    if (form instanceof Response) return form;
    const id = c.req.param('id');
    let result: { reverted: string[]; skipped: SkippedRow[] };
    try {
      result = deps.undoRun(id);
    } catch (err) {
      return renderUndoError(c, err);
    }
    if (result.skipped.length > 0) return renderPartialUndo(c, id, result.skipped);
    return c.redirect(`/dashboard/consolidation/${id}`);
  });

  app.post('/op/:opId/undo', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'op.undo');
    if (form instanceof Response) return form;
    const opId = c.req.param('opId');
    const op = deps.repos.consolidation.adminGetOp(opId);
    const runId = op?.runId ?? '';
    let result: { reverted: string; skipped: SkippedRow[] };
    try {
      result = deps.undoOp(opId);
    } catch (err) {
      return renderUndoError(c, err);
    }
    if (result.skipped.length > 0) return renderPartialUndo(c, runId, result.skipped);
    return c.redirect(`/dashboard/consolidation/${runId}`);
  });

  return app;
}
