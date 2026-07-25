import { Hono } from 'hono';

import type { AdminRelationFilters, Repositories } from '../db/repositories/index.js';
import type { RelationKind, RelationStatus } from '../db/schema/memory-relations.js';
import type { RelationsService } from '../services/relations.js';
import type { SessionsService } from '../services/sessions.js';

import {
  backLink,
  filterGroup,
  filtersBar,
  getSession,
  kv,
  kvGrid,
  PAGE_SIZE,
  pageParam,
  pager,
  mdBody,
  sel,
  tblEmpty,
  truncate,
  urlWithPage,
  viewHead,
} from './components.js';
import { readFormAndVerifyCsrf, csrfInput } from './csrf.js';
import { renderPage } from './page-shell.js';
import { escape, formatTs, html, raw, shortId, statusPill, verdictPill } from './templates.js';

export interface JudgmentsDeps {
  repos: Repositories;
  relations: RelationsService;
  sessions: SessionsService;
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
    const page = pageParam(url);
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
    const total = deps.repos.relations.adminCountWithFilters(filters);

    const statusOptions = [
      { value: '', label: 'all statuses', selected: statusFilter === '' },
      { value: 'pending', label: 'pending', selected: statusFilter === 'pending' },
      { value: 'judged', label: 'judged', selected: statusFilter === 'judged' },
      { value: 'orphaned', label: 'orphaned', selected: statusFilter === 'orphaned' },
    ];
    const kindOptions = [
      { value: '', label: 'all kinds', selected: kindFilter === '' },
      ...(
        [
          'supersedes',
          'conflicts_with',
          'related',
          'compatible',
          'scoped',
          'not_conflict',
          'pending',
        ] as const
      ).map((k) => ({ value: k, label: k, selected: kindFilter === k })),
    ];

    const filterBar = filtersBar([
      filterGroup('STATUS', 'f-status', sel('status', statusOptions, { id: 'f-status' })),
      filterGroup('KIND', 'f-kind', sel('kind', kindOptions, { id: 'f-kind' })),
      html`<span class="acts">
        <button class="btn primary" type="submit">FILTER</button>
        <a class="clear" href="/dashboard/judgments">CLEAR</a>
      </span>`,
    ]);

    const rowsHtml = visible.map((r) => {
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
        meta: [
          { k: 'TOTAL', v: String(total) },
          { k: 'SHOWING', v: `${visible.length} ROWS` },
        ],
      })}
      ${filterBar}
      ${visible.length === 0
        ? tblEmpty('No judgments match this filter.')
        : html`
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
                  ${rowsHtml}
                </tbody>
              </table>
            </div>
          `}
      ${pager({
        page,
        hasMore,
        pageHrefBuilder: (p) => urlWithPage(c.req.url, p),
        totalLabel: `${visible.length} ROWS`,
        total,
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
      ${kvGrid([
        kv({ k: 'Status', v: statusPill(row.status) }),
        kv({ k: 'Verdict', v: verdictPill(row.relation) }),
        kv({ k: 'Confidence', v: row.confidence !== null ? row.confidence.toFixed(2) : '—' }),
        kv({
          k: 'Marked by',
          v: html`${row.markedByKind ?? '—'}${row.markedByActor
            ? html`<span class="muted small"> · ${row.markedByActor}</span>`
            : raw('')}`,
        }),
        kv({ k: 'Created', v: formatTs(row.createdAt) }),
        kv({ k: 'Judged', v: row.judgedAt !== null ? formatTs(row.judgedAt) : '—' }),
      ])}

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
