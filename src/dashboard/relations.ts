import { desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import type { Db } from '../db/client.js';
import { memoryRelations } from '../db/schema/memory-relations.js';
import type { SessionsService } from '../services/sessions.js';

import { readFormAndVerifyCsrf, csrfInput } from './csrf.js';
import { formatTs, html, raw, shell, shortId, statusPill } from './templates.js';
import type { ResolvedSession } from './types.js';

export interface RelationsDeps {
  db: Db;
  sessions: SessionsService;
}

function getSession(c: Context): ResolvedSession | null {
  return (c.get('session') as ResolvedSession | undefined) ?? null;
}

const PAGE_SIZE = 50;
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
        <select name="status">
          <option value="" ${statusFilter === '' ? 'selected' : ''}>all statuses</option>
          <option value="pending" ${statusFilter === 'pending' ? 'selected' : ''}>pending</option>
          <option value="judged" ${statusFilter === 'judged' ? 'selected' : ''}>judged</option>
          <option value="orphaned" ${statusFilter === 'orphaned' ? 'selected' : ''}>
            orphaned
          </option>
        </select>
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
        <button type="submit">Filter</button>
        <a class="small" href="/dashboard/relations">clear</a>
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
      <h1>Relations</h1>
      ${filtersBar}
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
      <div class="pager">
        <span class="small">page ${page + 1}</span>
        <span>
          ${page > 0 ? html`<a href="?page=${page - 1}">← prev</a>` : raw('')}
          ${hasMore ? html` <a href="?page=${page + 1}">next →</a>` : raw('')}
        </span>
      </div>
    `;
    return c.html(shell(body, { title: 'Relations', activeNav: 'relations' }));
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
        shell(html`<p class="flash error">Relation not found or already closed.</p>`, {
          title: 'Relations',
          activeNav: 'relations',
        }),
        404,
      );
    }
    return c.redirect('/dashboard/relations');
  });

  return app;
}
