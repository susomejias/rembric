import { desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import type { Db } from '../db/client.js';
import { memoryRelations } from '../db/schema/memory-relations.js';
import type { SessionsService } from '../services/sessions.js';

import { PAGE_SIZE, pager, urlWithPage, viewHead } from './components.js';
import { readFormAndVerifyCsrf, csrfInput } from './csrf.js';
import { renderPage } from './page-shell.js';
import { formatTs, html, raw, shortId, statusPill } from './templates.js';
import type { ResolvedSession } from './types.js';

export interface RelationsDeps {
  db: Db;
  sessions: SessionsService;
}

function getSession(c: Context): ResolvedSession | null {
  return (c.get('session') as ResolvedSession | undefined) ?? null;
}

const VALID_STATUSES = new Set(['pending', 'judged', 'orphaned']);

export function createRelationsRouter(deps: RelationsDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const url = new URL(c.req.url);
    const statusFilter = url.searchParams.get('status') ?? '';
    const kindFilter = url.searchParams.get('kind') ?? '';
    const page = Math.max(0, parseInt(url.searchParams.get('page') ?? '0', 10) || 0);
    const offset = page * PAGE_SIZE;

    const conditions = [] as ReturnType<typeof eq>[];
    if (VALID_STATUSES.has(statusFilter)) {
      conditions.push(
        eq(memoryRelations.status, statusFilter as 'pending' | 'judged' | 'orphaned'),
      );
    }
    if (kindFilter && kindFilter !== 'pending') {
      conditions.push(
        eq(
          memoryRelations.relation,
          kindFilter as
            | 'supersedes'
            | 'conflicts_with'
            | 'related'
            | 'compatible'
            | 'scoped'
            | 'not_conflict',
        ),
      );
    } else if (kindFilter === 'pending') {
      conditions.push(isNull(memoryRelations.relation));
    }

    const rows =
      conditions.length === 0
        ? deps.db
            .select()
            .from(memoryRelations)
            .orderBy(desc(memoryRelations.createdAt))
            .limit(PAGE_SIZE + 1)
            .offset(offset)
            .all()
        : deps.db
            .select()
            .from(memoryRelations)
            .where(sql.join(conditions, sql` AND `))
            .orderBy(desc(memoryRelations.createdAt))
            .limit(PAGE_SIZE + 1)
            .offset(offset)
            .all();

    const hasMore = rows.length > PAGE_SIZE;
    const visible = rows.slice(0, PAGE_SIZE);

    const filtersBar = html`
      <form class="filters" method="get">
        <span class="group">
          <span class="k">STATUS</span>
          <select name="status">
            <option value="" ${statusFilter === '' ? 'selected' : ''}>all statuses</option>
            <option value="pending" ${statusFilter === 'pending' ? 'selected' : ''}>pending</option>
            <option value="judged" ${statusFilter === 'judged' ? 'selected' : ''}>judged</option>
            <option value="orphaned" ${statusFilter === 'orphaned' ? 'selected' : ''}>
              orphaned
            </option>
          </select>
        </span>
        <span class="group">
          <span class="k">KIND</span>
          <select name="kind">
            <option value="" ${kindFilter === '' ? 'selected' : ''}>all kinds</option>
            ${[
              'supersedes',
              'conflicts_with',
              'related',
              'compatible',
              'scoped',
              'not_conflict',
              'pending',
            ].map((k) =>
              raw(`<option value="${k}"${kindFilter === k ? ' selected' : ''}>${k}</option>`),
            )}
          </select>
        </span>
        <span class="acts">
          <button class="btn primary" type="submit">FILTER</button>
          <a class="clear" href="/dashboard/relations">CLEAR</a>
        </span>
      </form>
    `;

    const tableBody =
      visible.length === 0
        ? html`<tr>
            <td colspan="7" class="muted">No relations match this filter.</td>
          </tr>`
        : visible.map((r) => {
            const orphanForm =
              r.status === 'pending'
                ? html`
                    <form
                      action="/dashboard/relations/${r.judgmentId}/orphan"
                      method="post"
                      class="inline"
                      data-confirm="Mark this judgment as orphaned? It will be removed from the pending queue and won't be re-judged automatically."
                      data-confirm-label="MARK ORPHANED"
                      data-confirm-tone="danger"
                    >
                      ${csrfInput(session.session, deps.sessions, 'relation.orphan')}
                      <button class="warn" type="submit">Mark orphaned</button>
                    </form>
                  `
                : raw('<span class="muted small">—</span>');
            return html`
              <tr>
                <td class="mono small">${shortId(r.id)}</td>
                <td>${statusPill(r.status)}</td>
                <td>${r.relation ?? raw('<span class="muted">—</span>')}</td>
                <td class="mono small">
                  <a href="/dashboard/memories/${r.sourceId}">${shortId(r.sourceId)}</a>
                  → <a href="/dashboard/memories/${r.targetId}">${shortId(r.targetId)}</a>
                </td>
                <td class="small">${r.markedByActor ?? raw('<span class="muted">—</span>')}</td>
                <td class="muted">${formatTs(r.createdAt)}</td>
                <td>${orphanForm}</td>
              </tr>
            `;
          });

    const body = html`
      ${viewHead({
        num: '04',
        title: 'Rembric Relations.',
        hl: 'Rembric',
        meta: [{ k: 'SHOWING', v: `${rows.length} ROWS` }],
      })}
      ${filtersBar}
      <div class="tbl-host">
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>status</th>
              <th>relation</th>
              <th>source → target</th>
              <th>actor</th>
              <th>created</th>
              <th>actions</th>
            </tr>
          </thead>
          <tbody>
            ${tableBody}
          </tbody>
        </table>
      </div>
      ${pager({
        page,
        hasMore,
        pageHrefBuilder: (p) => urlWithPage(c.req.url, p),
        totalLabel: `${visible.length} ROWS`,
      })}
    `;
    return c.html(
      renderPage(c, deps.sessions, body, { title: 'Relations', activeNav: 'relations' }),
    );
  });

  app.post('/:judgmentId/orphan', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'relation.orphan');
    if (form instanceof Response) return form;

    const judgmentId = c.req.param('judgmentId');
    const result = deps.db
      .update(memoryRelations)
      .set({ status: 'orphaned' as const, markedByKind: 'system' as const, judgedAt: new Date() })
      .where(sql`judgment_id = ${judgmentId} AND status = 'pending'`)
      .run();
    if (result.changes === 0) {
      return c.html(
        renderPage(
          c,
          deps.sessions,
          html`<p class="flash error">Relation not found or already closed.</p>`,
          {
            title: 'Relations',
            activeNav: 'relations',
          },
        ),
        404,
      );
    }
    return c.redirect('/dashboard/relations');
  });

  return app;
}
