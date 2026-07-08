import { Hono } from 'hono';

import type { AdminListMemoriesOpts, Repositories } from '../db/repositories/index.js';
import type { Memory, MemoryType } from '../db/schema/memory.js';
import { DomainError } from '../services/errors.js';
import type { MemoryService } from '../services/memory.js';
import { deriveReviewState, REVIEW_TTL_MS, type ReviewState } from '../services/review.js';
import { projectScope, SCOPE_GLOBAL } from '../services/scope.js';
import type { SessionsService } from '../services/sessions.js';

import {
  domainErrorPage,
  filterGroup,
  filtersBar,
  flash,
  getSession,
  inp,
  kv,
  kvGrid,
  PAGE_SIZE,
  pager,
  mdBody,
  backLink,
  projectOptions,
  sel,
  tblEmpty,
  truncate,
  urlWithPage,
  viewHead,
} from './components.js';
import { readFormAndVerifyCsrf, csrfInput } from './csrf.js';
import { renderPage } from './page-shell.js';
import {
  escape,
  formatTs,
  html,
  raw,
  reviewPill,
  scopePill,
  shortId,
  statusPill,
  verdictPill,
} from './templates.js';

export interface MemoriesDeps {
  repos: Repositories;
  memory: MemoryService;
  sessions: SessionsService;
}

export function createMemoriesRouter(deps: MemoriesDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const url = new URL(c.req.url);
    const projectFilter = url.searchParams.get('project') ?? '';
    const statusFilter = url.searchParams.get('status') ?? 'active';
    const typeFilter = url.searchParams.get('type') ?? '';
    const reviewFilter = url.searchParams.get('review') ?? '';
    const wantNeedsReview = reviewFilter === 'needs_review';
    const query = url.searchParams.get('q') ?? '';
    const page = Math.max(0, parseInt(url.searchParams.get('page') ?? '0', 10) || 0);
    const offset = page * PAGE_SIZE;

    const projectRows = deps.repos.projects.adminListAll();
    const projectBySlug = new Map(projectRows.map((p) => [p.slug, p]));
    const projectById = new Map(projectRows.map((p) => [p.id, p]));

    let project: AdminListMemoriesOpts['project'];
    if (projectFilter === '__global__') {
      project = { kind: 'global' };
    } else if (projectFilter) {
      const p = projectBySlug.get(projectFilter);
      if (p) project = { kind: 'project', projectId: p.id };
    }

    const ttlByType = Object.entries(REVIEW_TTL_MS).filter(
      (e): e is [MemoryType, number] => typeof e[1] === 'number',
    );
    const nowMs = Date.now();

    let rows: Memory[];
    if (query) {
      rows = deps.repos.memory
        .adminSearchFts(query, PAGE_SIZE + 1, offset)
        .filter((m) => clientSideFilter(m, projectBySlug, projectFilter, statusFilter, typeFilter));
    } else if (wantNeedsReview) {
      // needs_review implies active; the SQL path filters + paginates correctly.
      rows = deps.repos.memory.adminFindNeedsReview({
        project,
        nowMs,
        limit: PAGE_SIZE + 1,
        offset,
        ttlByType,
      });
    } else {
      rows = deps.repos.memory.adminList({
        status: statusFilter as Memory['status'],
        type: typeFilter ? (typeFilter as Memory['type']) : undefined,
        project,
        limit: PAGE_SIZE + 1,
        offset,
      });
    }

    // Derived review state per row for the badge (and to refine the FTS path
    // when the needs_review filter is combined with a text query).
    const reviewById = new Map<string, ReviewState | null>();
    if (rows.length > 0) {
      const lastConfirmed = deps.repos.memory.latestConfirmationTsByIds(rows.map((m) => m.id));
      const at = new Date(nowMs);
      for (const m of rows) {
        reviewById.set(
          m.id,
          deriveReviewState(
            {
              type: m.type,
              createdAt: m.createdAt,
              status: m.status,
              lastConfirmedAt: lastConfirmed.get(m.id) ?? null,
            },
            at,
          ).reviewState,
        );
      }
    }
    if (wantNeedsReview && query) {
      rows = rows.filter((m) => reviewById.get(m.id) === 'needs_review');
    }

    const hasMore = rows.length > PAGE_SIZE;
    const visible = rows.slice(0, PAGE_SIZE);

    // True total for the current filter set (not the page slice). The
    // needs_review+query path is TS-derived row-by-row, so it can only
    // report a lower bound.
    let total: string;
    if (query && wantNeedsReview) {
      total = `${visible.length}+`;
    } else if (query) {
      total = String(
        deps.repos.memory.adminCountFts(query, {
          status: statusFilter as Memory['status'],
          type: typeFilter ? (typeFilter as Memory['type']) : undefined,
          project,
        }),
      );
    } else if (wantNeedsReview) {
      total = String(deps.repos.memory.adminCountNeedsReview({ project, nowMs, ttlByType }));
    } else {
      total = String(
        deps.repos.memory.adminCount({
          status: statusFilter as Memory['status'],
          type: typeFilter ? (typeFilter as Memory['type']) : undefined,
          project,
        }),
      );
    }

    const rowsHtml = visible.map((m) => {
      const projectLabel = m.projectId
        ? (projectById.get(m.projectId)?.slug ?? shortId(m.projectId))
        : '—';
      return html`
        <tr data-href="/dashboard/memories/${m.id}">
          <td>${scopePill(m.scope)}</td>
          <td>${projectLabel}</td>
          <td>${m.type}</td>
          <td><a href="/dashboard/memories/${m.id}">${truncate(m.title, 100)}</a></td>
          <td>${statusPill(m.status)}</td>
          <td>
            ${reviewById.get(m.id) === 'needs_review'
              ? reviewPill()
              : raw('<span class="muted">—</span>')}
          </td>
          <td class="muted">${formatTs(m.createdAt)}</td>
        </tr>
      `;
    });

    const statusOptions = (['active', 'superseded', 'archived'] as const).map((s) => ({
      value: s,
      label: s,
      selected: statusFilter === s,
    }));
    const typeOptions = [
      { value: '', label: 'all types', selected: typeFilter === '' },
      ...(['user', 'feedback', 'project', 'reference'] as const).map((t) => ({
        value: t,
        label: t,
        selected: typeFilter === t,
      })),
    ];
    const reviewOptions = [
      { value: '', label: 'any review', selected: !wantNeedsReview },
      { value: 'needs_review', label: 'needs_review', selected: wantNeedsReview },
    ];

    const filterBar = filtersBar([
      filterGroup(
        'SCOPE',
        'f-project',
        sel('project', projectOptions(projectRows, projectFilter), { id: 'f-project' }),
      ),
      filterGroup('STATUS', 'f-status', sel('status', statusOptions, { id: 'f-status' })),
      filterGroup('TYPE', 'f-type', sel('type', typeOptions, { id: 'f-type' })),
      filterGroup('REVIEW', 'f-review', sel('review', reviewOptions, { id: 'f-review' })),
      filterGroup(
        'SEARCH',
        'f-q',
        inp('q', query, 'FTS5 keyword, tag, topic', { type: 'search', id: 'f-q' }),
        { className: 'search' },
      ),
      html`<span class="acts">
        <button class="btn primary" type="submit">FILTER</button>
        <a class="clear" href="/dashboard/memories">CLEAR</a>
      </span>`,
    ]);

    const body = html`
      ${viewHead({
        num: '02',
        title: 'Rembric Memories.',
        hl: 'Rembric',
        meta: [
          { k: 'TOTAL', v: total },
          { k: 'SHOWING', v: `${visible.length} ROWS` },
        ],
      })}

      <div class="append-only-banner">
        <span class="lab">APPEND-ONLY</span>
        <span>
          Memories are <u><b>never deleted or edited</b></u
          >. Lifecycle is <b>active</b> · supersede via new save · <b>archive</b>.
        </span>
      </div>

      ${filterBar}
      ${visible.length === 0
        ? tblEmpty('No memories match this filter.')
        : html`
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>scope</th>
                    <th>project</th>
                    <th>type</th>
                    <th>title</th>
                    <th>status</th>
                    <th>review</th>
                    <th>created</th>
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
      })}
    `;

    return c.html(renderPage(c, deps.sessions, body, { title: 'Memories', activeNav: 'memories' }));
  });

  app.get('/:id', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const id = c.req.param('id');
    const row = deps.memory.unsafeGetById(id);
    if (!row) {
      return c.html(
        renderPage(c, deps.sessions, html`<p class="flash error">Memory not found.</p>`, {
          title: 'Memory',
          activeNav: 'memories',
        }),
        404,
      );
    }

    const project = row.projectId ? deps.repos.projects.adminFindById(row.projectId) : null;
    const predecessors = deps.repos.memory.adminGetByIds(row.replaces);
    const confirmCount = deps.repos.memory.adminCountConfirmations(row.id);
    const lastConfirmedAt =
      deps.repos.memory.latestConfirmationTsByIds([row.id]).get(row.id) ?? null;
    const { reviewState, reviewAfter } = deriveReviewState(
      { type: row.type, createdAt: row.createdAt, status: row.status, lastConfirmedAt },
      new Date(),
    );

    const confirmForm = html`
      <form action="/dashboard/memories/${row.id}/confirm" method="post" class="inline">
        ${csrfInput(session.session, deps.sessions, 'memory.confirm')}
        <button class="primary" type="submit">Confirm</button>
      </form>
    `;
    // Shown only for an active row whose type has a TTL (reviewAfter set).
    // Labels stay Title Case (matching the pre-existing stat-card copy the
    // spec's e2e assertions target) — the `.kv .k` CSS uppercases display.
    const reviewKv =
      reviewState !== null && reviewAfter !== null
        ? [
            kv({ k: 'Review', v: reviewState === 'needs_review' ? reviewPill() : raw('fresh') }),
            kv({ k: 'Review after', v: formatTs(reviewAfter), mono: true }),
          ]
        : [];

    const justConfirmed = c.req.query('confirmed') !== undefined;
    const confirmedFlash = justConfirmed
      ? flash({ tone: 'success', label: 'CONFIRMED', body: 'Review affirmed just now.' })
      : raw('');

    // The Confirm action is non-destructive — no data-confirm modal. When
    // the memory needs review, the notice and the action are grouped in
    // one banner; otherwise Confirm lives with the other Actions.
    const reviewNotice =
      reviewState === 'needs_review'
        ? flash({
            tone: 'warn',
            label: 'NEEDS REVIEW',
            body: html`This memory hasn't been re-affirmed since ${formatTs(reviewAfter)}.
            ${confirmForm}`,
          })
        : raw('');

    const archiveButton =
      row.status === 'active'
        ? html`
            <form
              action="/dashboard/memories/${row.id}/archive"
              method="post"
              class="inline"
              data-confirm="Archive this memory? It will stop appearing in active recall. You can re-save the topic later to bring it back."
              data-confirm-label="ARCHIVE"
              data-confirm-tone="warn"
            >
              ${csrfInput(session.session, deps.sessions, 'memory.archive')}
              <button class="warn" type="submit">Archive</button>
            </form>
          `
        : raw('');

    const predHtml =
      predecessors.length === 0
        ? raw('')
        : html`
            <h2>Predecessors (${predecessors.length})</h2>
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>status</th>
                    <th>title</th>
                    <th>created</th>
                  </tr>
                </thead>
                <tbody>
                  ${predecessors.map(
                    (p) => html`
                      <tr data-href="/dashboard/memories/${p.id}">
                        <td>${statusPill(p.status)}</td>
                        <td>
                          <a href="/dashboard/memories/${p.id}">${truncate(p.title, 120)}</a>
                        </td>
                        <td class="muted">${formatTs(p.createdAt)}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `;

    const tagsHtml =
      row.tags.length === 0
        ? raw('<span class="muted">—</span>')
        : row.tags.map((t) => raw(`<span class="pill">${escape(t)}</span> `));

    const sourceLabel = sourceLine(row.source);

    const touchingRelations = deps.repos.relations.adminListTouching(row.id);
    const judgmentsHtml =
      touchingRelations.length === 0
        ? tblEmpty('No judgments touch this memory.')
        : html`
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>kind</th>
                    <th>status</th>
                    <th>counterpart</th>
                    <th>timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  ${touchingRelations.map((r) => {
                    const isSource = r.sourceId === row.id;
                    const counterpartId = isSource ? r.targetId : r.sourceId;
                    const counterpartTitle = isSource ? r.targetTitle : r.sourceTitle;
                    const ts = r.judgedAt ?? r.createdAt;
                    return html`
                      <tr data-href="/dashboard/judgments/${r.id}">
                        <td>${verdictPill(r.relation)}</td>
                        <td>${statusPill(r.status)}</td>
                        <td class="small">
                          <a href="/dashboard/memories/${counterpartId}"
                            >${truncate(counterpartTitle, 80)}</a
                          >
                        </td>
                        <td class="muted">
                          <a href="/dashboard/judgments/${r.id}">${formatTs(ts)}</a>
                        </td>
                      </tr>
                    `;
                  })}
                </tbody>
              </table>
            </div>
          `;

    const replacesHtml =
      row.replaces.length === 0
        ? raw('—')
        : row.replaces.map(
            (rid) => html`<a href="/dashboard/memories/${rid}" class="mono small">${rid}</a> `,
          );

    const body = html`
      ${viewHead({
        num: '02',
        title: row.title,
        meta: [
          { k: 'ID', v: shortId(row.id) },
          { k: 'STATUS', v: row.status.toUpperCase() },
          { k: 'SCOPE', v: row.scope.toUpperCase() },
        ],
      })}
      ${backLink({ href: '/dashboard/memories', label: 'BACK TO MEMORIES' })} ${confirmedFlash}
      ${reviewNotice}
      ${kvGrid([
        kv({ k: 'Status', v: statusPill(row.status) }),
        kv({ k: 'Scope', v: scopePill(row.scope) }),
        kv({ k: 'Project', v: project?.slug ?? '—' }),
        kv({ k: 'Type', v: row.type }),
        kv({ k: 'Confirms', v: confirmCount }),
        kv({ k: 'Created', v: formatTs(row.createdAt) }),
        kv({ k: 'Source', v: sourceLabel }),
        kv({
          k: 'Session',
          v: row.sessionId
            ? html`<a href="/dashboard/sessions/${row.sessionId}">${shortId(row.sessionId)}</a>`
            : '—',
        }),
        ...reviewKv,
      ])}

      <h2>Content</h2>
      ${mdBody(row.content)}

      <h2>Tags</h2>
      <p>${tagsHtml}</p>

      <h2>Replaces</h2>
      <p class="mono small">${replacesHtml}</p>

      ${predHtml}

      <h2>Judgments</h2>
      ${judgmentsHtml}

      <h2>Actions</h2>
      <p>${archiveButton} ${reviewState !== 'needs_review' ? confirmForm : raw('')}</p>
    `;
    return c.html(
      renderPage(c, deps.sessions, body, {
        title: `Memory ${shortId(row.id)}`,
        activeNav: 'memories',
      }),
    );
  });

  app.post('/:id/archive', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'memory.archive');
    if (form instanceof Response) return form;

    const id = c.req.param('id');
    const row = deps.memory.unsafeGetById(id);
    if (!row) return c.redirect('/dashboard/memories');

    const scope =
      row.scope === 'project' && row.projectId ? projectScope(row.projectId) : SCOPE_GLOBAL;
    try {
      deps.memory.archive(id, scope);
    } catch (err) {
      if (err instanceof DomainError) {
        return domainErrorPage(c, deps.sessions, err, { title: 'Memory', activeNav: 'memories' });
      }
      throw err;
    }
    return c.redirect(`/dashboard/memories/${id}`);
  });

  app.post('/:id/confirm', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'memory.confirm');
    if (form instanceof Response) return form;

    const id = c.req.param('id');
    const row = deps.memory.unsafeGetById(id);
    if (!row) return c.redirect('/dashboard/memories');

    const scope =
      row.scope === 'project' && row.projectId ? projectScope(row.projectId) : SCOPE_GLOBAL;
    try {
      deps.memory.confirm(id, scope, { agent: 'dashboard-operator' });
    } catch (err) {
      if (err instanceof DomainError) {
        return domainErrorPage(c, deps.sessions, err, { title: 'Memory', activeNav: 'memories' });
      }
      throw err;
    }
    return c.redirect(`/dashboard/memories/${id}?confirmed=1`);
  });

  return app;
}

function clientSideFilter(
  m: Memory,
  projectBySlug: Map<string, { id: string }>,
  projectFilter: string,
  statusFilter: string,
  typeFilter: string,
): boolean {
  if (statusFilter && m.status !== statusFilter) return false;
  if (typeFilter && m.type !== typeFilter) return false;
  if (projectFilter === '__global__') return m.scope === 'global';
  if (projectFilter) {
    const p = projectBySlug.get(projectFilter);
    return m.scope === 'project' && m.projectId === p?.id;
  }
  return true;
}

function sourceLine(source: Memory['source']): string {
  if (!source) return '—';
  const parts = [
    source.agent ? `agent: ${source.agent}` : null,
    source.tokenName ? `token: ${source.tokenName}` : null,
    source.model ? `model: ${source.model}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(' · ') : '—';
}
