import { Hono, type Context } from 'hono';

import type { AdminRelationFilters, Repositories } from '../db/repositories/index.js';
import type { RelationKind, RelationStatus } from '../db/schema/memory-relations.js';
import type { RelationsService } from '../services/relations.js';
import type { SessionsService } from '../services/sessions.js';

import { backLink, PAGE_SIZE, pager, mdBody, urlWithPage, viewHead } from './components.js';
import { readFormAndVerifyCsrf, csrfInput } from './csrf.js';
import { renderPage } from './page-shell.js';
import { escape, formatTs, html, raw, shortId, statusPill, verdictPill } from './templates.js';
import type { ResolvedSession } from './types.js';

function truncate(s: string | null, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export interface JudgmentsDeps {
  repos: Repositories;
  relations: RelationsService;
  sessions: SessionsService;
}

function getSession(c: Context): ResolvedSession | null {
  return (c.get('session') as ResolvedSession | undefined) ?? null;
}

const VALID_STATUSES = new Set(['pending', 'judged', 'orphaned']);

export function createJudgmentsRouter(deps: JudgmentsDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const url = new URL(c.req.url);
    const statusFilter = url.searchParams.get('status') ?? '';
    const kindFilter = url.searchParams.get('kind') ?? '';
    const page = Math.max(0, parseInt(url.searchParams.get('page') ?? '0', 10) || 0);
    const offset = page * PAGE_SIZE;

    const filters: AdminRelationFilters = {};
    if (VALID_STATUSES.has(statusFilter)) {
      filters.status = statusFilter as RelationStatus;
    }
    const KIND_VALUES = new Set([
      'supersedes',
      'conflicts_with',
      'related',
      'compatible',
      'scoped',
      'not_conflict',
    ]);
    if (kindFilter && KIND_VALUES.has(kindFilter)) {
      filters.kind = kindFilter as RelationKind;
    } else if (kindFilter === 'pending') {
      filters.kind = 'pending';
    }

    const rows = deps.repos.relations.adminListWithContent(filters, PAGE_SIZE + 1, offset);

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
          <a class="clear" href="/dashboard/judgments">CLEAR</a>
        </span>
      </form>
    `;

    const tableBody =
      visible.length === 0
        ? html`<tr>
            <td colspan="6" class="muted">No judgments match this filter.</td>
          </tr>`
        : visible.map((r) => {
            const orphanForm =
              r.status === 'pending'
                ? html`
                    <form
                      action="/dashboard/judgments/${r.judgmentId}/orphan"
                      method="post"
                      class="inline"
                      data-confirm="Mark this judgment as orphaned? It will be removed from the pending queue and won't be re-judged automatically."
                      data-confirm-label="MARK ORPHANED"
                      data-confirm-tone="danger"
                    >
                      ${csrfInput(session.session, deps.sessions, 'judgment.orphan')}
                      <button class="warn" type="submit">Mark orphaned</button>
                    </form>
                  `
                : raw('<span class="muted small">—</span>');
            return html`
              <tr data-href="/dashboard/judgments/${r.id}">
                <td>${statusPill(r.status)}</td>
                <td>${verdictPill(r.relation)}</td>
                <td class="small">
                  <a href="/dashboard/memories/${r.sourceId}">${truncate(r.sourceTitle, 60)}</a>
                  →
                  <a href="/dashboard/memories/${r.targetId}">${truncate(r.targetTitle, 60)}</a>
                </td>
                <td class="small">${r.markedByActor ?? raw('<span class="muted">—</span>')}</td>
                <td class="muted">
                  <a href="/dashboard/judgments/${r.id}">${formatTs(r.createdAt)}</a>
                </td>
                <td>${orphanForm}</td>
              </tr>
            `;
          });

    const body = html`
      ${viewHead({
        num: '04',
        title: 'Rembric Judgments.',
        hl: 'Rembric',
        meta: [{ k: 'SHOWING', v: `${rows.length} ROWS` }],
      })}
      ${filtersBar}
      <div class="tbl-host">
        <table>
          <thead>
            <tr>
              <th>status</th>
              <th>verdict</th>
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
      renderPage(c, deps.sessions, body, { title: 'Judgments', activeNav: 'judgments' }),
    );
  });

  app.get('/:id', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const id = c.req.param('id');
    const row = deps.repos.relations.adminGetWithContent(id);

    if (!row) {
      return c.html(
        renderPage(c, deps.sessions, html`<p class="flash error">Judgment not found.</p>`, {
          title: 'Judgment',
          activeNav: 'judgments',
        }),
        404,
      );
    }

    let evidencePretty: string | null = null;
    if (row.evidence !== null && row.evidence !== undefined) {
      if (typeof row.evidence === 'string') {
        try {
          const parsed: unknown = JSON.parse(row.evidence);
          evidencePretty = JSON.stringify(parsed, null, 2);
        } catch {
          evidencePretty = row.evidence;
        }
      } else {
        evidencePretty = JSON.stringify(row.evidence, null, 2);
      }
    }

    const orphanForm =
      row.status === 'pending'
        ? html`
            <form
              action="/dashboard/judgments/${row.judgmentId}/orphan"
              method="post"
              class="inline"
              data-confirm="Mark this judgment as orphaned? It will be removed from the pending queue and won't be re-judged automatically."
              data-confirm-label="MARK ORPHANED"
              data-confirm-tone="danger"
            >
              ${csrfInput(session.session, deps.sessions, 'judgment.orphan')}
              <button class="warn" type="submit">Mark orphaned</button>
            </form>
          `
        : raw('<span class="muted">No actions available — this judgment is closed.</span>');

    const body = html`
      ${viewHead({
        num: '04',
        title: `Rembric Judgment ${shortId(row.id)}.`,
        hl: 'Rembric',
        meta: [
          { k: 'STATUS', v: row.status.toUpperCase() },
          { k: 'VERDICT', v: row.relation ? row.relation.toUpperCase() : '—' },
        ],
      })}
      ${backLink({ href: '/dashboard/judgments', label: 'BACK TO JUDGMENTS' })}
      <div class="stat-grid">
        <div class="stat-card">
          <div class="label">Status</div>
          <div class="value">${statusPill(row.status)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Verdict</div>
          <div class="value">${verdictPill(row.relation)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Confidence</div>
          <div class="value">${row.confidence !== null ? row.confidence.toFixed(2) : '—'}</div>
        </div>
        <div class="stat-card">
          <div class="label">Marked by</div>
          <div class="value">
            ${row.markedByKind ?? '—'}
            ${row.markedByActor
              ? html`<span class="muted small"> · ${row.markedByActor}</span>`
              : raw('')}
          </div>
        </div>
        <div class="stat-card">
          <div class="label">Created</div>
          <div class="value" style="font-size:.9rem">${formatTs(row.createdAt)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Judged</div>
          <div class="value" style="font-size:.9rem">
            ${row.judgedAt !== null ? formatTs(row.judgedAt) : '—'}
          </div>
        </div>
      </div>

      <h2>Source</h2>
      <p class="small">
        <a href="/dashboard/memories/${row.sourceId}">${row.sourceTitle}</a>
        <span class="mono muted">${shortId(row.sourceId)}</span>
      </p>
      ${mdBody(row.sourceContent)}

      <h2>Target</h2>
      <p class="small">
        <a href="/dashboard/memories/${row.targetId}">${row.targetTitle}</a>
        <span class="mono muted">${shortId(row.targetId)}</span>
      </p>
      ${mdBody(row.targetContent)}

      <h2>Reason</h2>
      <p>${row.reason ?? raw('<span class="muted">—</span>')}</p>

      <h2>Evidence</h2>
      ${evidencePretty ? html`<pre>${evidencePretty}</pre>` : html`<p class="muted">—</p>`}

      <h2>Judgment id</h2>
      <p class="mono small">${escape(row.judgmentId)}</p>

      <h2>Actions</h2>
      <p>${orphanForm}</p>
    `;
    return c.html(
      renderPage(c, deps.sessions, body, {
        title: `Judgment ${shortId(row.id)}`,
        activeNav: 'judgments',
      }),
    );
  });

  app.post('/:judgmentId/orphan', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'judgment.orphan');
    if (form instanceof Response) return form;

    const judgmentId = c.req.param('judgmentId');
    const orphaned = deps.relations.orphanByOperator(judgmentId);
    if (!orphaned) {
      return c.html(
        renderPage(
          c,
          deps.sessions,
          html`<p class="flash error">Judgment not found or already closed.</p>`,
          {
            title: 'Judgments',
            activeNav: 'judgments',
          },
        ),
        404,
      );
    }
    return c.redirect('/dashboard/judgments');
  });

  return app;
}
