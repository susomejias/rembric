import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { undoOp as runUndoOp, undoRun as runUndoRun } from '../consolidation/operations.js';
import type { Db } from '../db/client.js';
import { consolidationOps, consolidationRuns } from '../db/schema/consolidation.js';
import type { SessionsService } from '../services/sessions.js';

import { readFormAndVerifyCsrf, csrfInput } from './csrf.js';
import { formatTs, html, raw, shell, shortId } from './templates.js';
import type { ResolvedSession } from './types.js';

export interface ConsolidationDeps {
  db: Db;
  sessions: SessionsService;
}

function getSession(c: Context): ResolvedSession | null {
  return (c.get('session') as ResolvedSession | undefined) ?? null;
}

export function createConsolidationRouter(deps: ConsolidationDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const runs = deps.db
      .select()
      .from(consolidationRuns)
      .orderBy(desc(consolidationRuns.startedAt))
      .limit(50)
      .all();

    const opCountByRun = new Map<string, { total: number; reverted: number }>();
    for (const run of runs) {
      const total = deps.db
        .select({ v: sql<number>`count(*)` })
        .from(consolidationOps)
        .where(eq(consolidationOps.consolidationId, run.id))
        .get();
      const reverted = deps.db
        .select({ v: sql<number>`count(*)` })
        .from(consolidationOps)
        .where(and(eq(consolidationOps.consolidationId, run.id), sql`reverted_at IS NOT NULL`))
        .get();
      opCountByRun.set(run.id, { total: total?.v ?? 0, reverted: reverted?.v ?? 0 });
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
        <tr>
          <td class="mono"><a href="/dashboard/consolidation/${r.id}">${shortId(r.id)}</a></td>
          <td class="muted">${formatTs(r.startedAt)}</td>
          <td class="muted">${formatTs(r.finishedAt)}</td>
          <td>${r.scope ?? '—'}</td>
          <td>${r.llmModel ?? '—'}</td>
          <td>${status}</td>
        </tr>
      `;
    });

    const body = html`
      <h1>Consolidation runs</h1>
      ${runs.length === 0
        ? html`<p class="muted">
            No runs yet. The cron will fire at <code>CONSOLIDATION_CRON</code>; trigger one manually
            with <code>rembric consolidation run-now</code> once that command lands.
          </p>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>id</th>
                  <th>started</th>
                  <th>finished</th>
                  <th>scope</th>
                  <th>model</th>
                  <th>status</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          `}
    `;
    return c.html(shell(body, { title: 'Consolidation', activeNav: 'consolidation' }));
  });

  app.get('/:id', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const id = c.req.param('id');
    const run = deps.db.select().from(consolidationRuns).where(eq(consolidationRuns.id, id)).get();
    if (!run) {
      return c.html(
        shell(html`<p class="flash error">Run not found.</p>`, {
          title: 'Consolidation',
          activeNav: 'consolidation',
        }),
        404,
      );
    }

    const ops = deps.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.consolidationId, id))
      .orderBy(consolidationOps.appliedAt)
      .all();

    const opsHtml = ops.map((op) => {
      const isReverted = op.revertedAt !== null;
      const undoForm = isReverted
        ? raw('<span class="muted small">reverted</span>')
        : html`
            <form action="/dashboard/consolidation/op/${op.id}/undo" method="post" class="inline">
              ${csrfInput(session.session, deps.sessions, 'op.undo')}
              <button class="warn" type="submit">Undo this op</button>
            </form>
          `;
      return html`
        <tr>
          <td class="mono">${shortId(op.id)}</td>
          <td><span class="pill">${op.opType}</span></td>
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
          <form action="/dashboard/consolidation/${run.id}/undo" method="post" class="inline">
            ${csrfInput(session.session, deps.sessions, 'run.undo')}
            <button class="danger" type="submit">Undo entire run</button>
          </form>
        `
      : raw('<span class="muted small">all ops reverted</span>');

    const body = html`
      <h1>Run <code>${shortId(run.id)}</code></h1>
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
          <div class="value">${run.scope ?? '—'}</div>
        </div>
        <div class="stat-card">
          <div class="label">Model</div>
          <div class="value" style="font-size:.9rem">${run.llmModel ?? '—'}</div>
        </div>
        <div class="stat-card">
          <div class="label">Ops</div>
          <div class="value">${ops.length}</div>
        </div>
      </div>

      <h2>Summary</h2>
      <pre>${run.summary ?? '—'}</pre>

      <h2>Ops</h2>
      ${ops.length === 0
        ? html`<p class="muted">No operations were recorded for this run.</p>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>id</th>
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
          `}

      <h2>Run actions</h2>
      <p>${undoRunForm}</p>
    `;
    return c.html(shell(body, { title: `Run ${shortId(run.id)}`, activeNav: 'consolidation' }));
  });

  app.post('/:id/undo', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'run.undo');
    if (form instanceof Response) return form;
    const id = c.req.param('id');
    try {
      runUndoRun(deps.db, id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.html(
        shell(html`<p class="flash error">${message}</p>`, {
          title: 'Consolidation',
          activeNav: 'consolidation',
        }),
        400,
      );
    }
    return c.redirect(`/dashboard/consolidation/${id}`);
  });

  app.post('/op/:opId/undo', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'op.undo');
    if (form instanceof Response) return form;
    const opId = c.req.param('opId');
    const op = deps.db.select().from(consolidationOps).where(eq(consolidationOps.id, opId)).get();
    try {
      runUndoOp(deps.db, opId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.html(
        shell(html`<p class="flash error">${message}</p>`, {
          title: 'Consolidation',
          activeNav: 'consolidation',
        }),
        400,
      );
    }
    return c.redirect(`/dashboard/consolidation/${op?.consolidationId ?? ''}`);
  });

  return app;
}

// Suppress unused-import warning when the file is not exercising isNull.
void isNull;
