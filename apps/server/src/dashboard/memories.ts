import { Hono } from 'hono';

import type { Repositories } from '../db/repositories/index.js';
import { MEMORY_TYPES, type Memory, type MemoryType } from '../db/schema/memory.js';
import { DomainError } from '../services/errors.js';
import { sanitizeFtsQuery } from '../services/hybrid-search.js';
import type { MemoryService } from '../services/memory.js';
import { annotationKindFor, compareAnnotations } from '../services/relations.js';
import {
  deriveReviewState,
  REFUTED_PRIORITY_MS,
  REVIEW_TTL_MS,
  type ReviewState,
} from '../services/review.js';
import { projectScope } from '../services/scope.js';
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
  pageParam,
  pager,
  mdBody,
  backLink,
  resolveProjectFilter,
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
  shortId,
  statusPill,
  verdictPill,
} from './templates.js';

export interface MemoriesDeps {
  repos: Repositories;
  memory: MemoryService;
  sessions: SessionsService;
}

const TTL_BY_TYPE = Object.entries(REVIEW_TTL_MS).filter(
  (e): e is [MemoryType, number] => typeof e[1] === 'number',
);

/** All-scope needs-review count for the sidebar's MEMORIES badge. */
function needsReviewBadgeCount(repos: Repositories): number {
  return repos.memory.adminCountNeedsReview({ nowMs: Date.now(), ttlByType: TTL_BY_TYPE });
}

export function createMemoriesRouter(deps: MemoriesDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const url = new URL(c.req.url);
    const statusFilter = url.searchParams.get('status') ?? 'active';
    const typeFilter = url.searchParams.get('type') ?? '';
    const reviewFilter = url.searchParams.get('review') ?? '';
    const wantNeedsReview = reviewFilter === 'needs_review';
    const rawQuery = url.searchParams.get('q') ?? '';
    // Sanitized before it reaches `memory_fts MATCH` — ordinary punctuation
    // (an apostrophe, a stray quote, "docker-compose") otherwise raises an
    // FTS5 syntax error and 500s the page. `rawQuery` is still what's
    // redisplayed in the search box.
    const query = sanitizeFtsQuery(rawQuery);
    const page = pageParam(url);
    const offset = page * PAGE_SIZE;

    const projectRows = deps.repos.projects.adminListAll();
    const projectById = new Map(projectRows.map((p) => [p.id, p]));

    const {
      slug: projectFilter,
      projectId,
      unknown: unknownProject,
    } = resolveProjectFilter(url, projectRows);
    const nowMs = Date.now();

    let rows: Memory[];
    if (unknownProject) {
      rows = [];
    } else if (query) {
      rows = deps.repos.memory.adminSearchFts(query, {
        status: statusFilter as Memory['status'],
        type: typeFilter ? (typeFilter as Memory['type']) : undefined,
        projectId,
        limit: PAGE_SIZE + 1,
        offset,
      });
    } else if (wantNeedsReview) {
      // needs_review implies active; the SQL path filters + paginates correctly.
      rows = deps.repos.memory.adminFindNeedsReview({
        projectId,
        nowMs,
        limit: PAGE_SIZE + 1,
        offset,
        ttlByType: TTL_BY_TYPE,
        refutedPriorityMs: REFUTED_PRIORITY_MS,
      });
    } else {
      rows = deps.repos.memory.adminList({
        status: statusFilter as Memory['status'],
        type: typeFilter ? (typeFilter as Memory['type']) : undefined,
        projectId,
        limit: PAGE_SIZE + 1,
        offset,
      });
    }

    // Derived review state per row for the badge (and to refine the FTS path
    // when the needs_review filter is combined with a text query).
    const reviewById = new Map<string, ReviewState | null>();
    if (rows.length > 0) {
      const rowIds = rows.map((m) => m.id);
      const reviewTs = deps.repos.memory.reviewTimestampsByIds(rowIds);
      const at = new Date(nowMs);
      for (const m of rows) {
        reviewById.set(
          m.id,
          deriveReviewState(
            {
              type: m.type,
              createdAt: m.createdAt,
              status: m.status,
              lastConfirmedAt: reviewTs.get(m.id)?.affirmedAt ?? null,
              lastRefutedAt: reviewTs.get(m.id)?.refutedAt ?? null,
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

    // needs_review+query has no cheap exact count — leave `totalCount`
    // undefined there so the pager shows a lower bound, not a wrong "OF Y".
    let totalCount: number | undefined;
    if (unknownProject) {
      totalCount = 0;
    } else if (query && wantNeedsReview) {
      totalCount = undefined;
    } else if (offset === 0 && !hasMore) {
      // All three row queries over-fetch by one and paginate in SQL, so an
      // unfull first page IS the total and the count query can be skipped.
      totalCount = visible.length;
    } else if (query) {
      totalCount = deps.repos.memory.adminCountFts(query, {
        status: statusFilter as Memory['status'],
        type: typeFilter ? (typeFilter as Memory['type']) : undefined,
        projectId,
      });
    } else if (wantNeedsReview) {
      totalCount = deps.repos.memory.adminCountNeedsReview({
        projectId,
        nowMs,
        ttlByType: TTL_BY_TYPE,
      });
    } else {
      totalCount = deps.repos.memory.adminCount({
        status: statusFilter as Memory['status'],
        type: typeFilter ? (typeFilter as Memory['type']) : undefined,
        projectId,
      });
    }
    const total = totalCount === undefined ? `${visible.length}+` : String(totalCount);

    const rowsHtml = visible.map((m) => {
      const projectLabel = m.projectId
        ? (projectById.get(m.projectId)?.slug ?? shortId(m.projectId))
        : '—';
      return html`
        <tr data-href="/dashboard/memories/${m.id}">
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
      ...MEMORY_TYPES.map((t) => ({
        value: t,
        label: t,
        selected: typeFilter === t,
      })),
    ];
    const reviewOptions = [
      { value: '', label: 'any review', selected: !wantNeedsReview },
      { value: 'needs_review', label: 'needs_review', selected: wantNeedsReview },
    ];

    const filterBar = filtersBar(
      [
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
          inp('q', rawQuery, 'FTS5 keyword, tag, topic', { type: 'search', id: 'f-q' }),
          { className: 'search' },
        ),
        html`<span class="acts">
          <button class="btn primary" type="submit">FILTER</button>
          <a class="clear" href="/dashboard/memories">CLEAR</a>
        </span>`,
      ],
      { hxTarget: '#memories-list', hxGet: '/dashboard/memories' },
    );

    const body = html`
      ${viewHead({
        num: '02',
        title: 'Rembric Memories.',
        hl: 'Rembric',
        meta: [
          { k: 'TOTAL', v: total },
          { k: 'SHOWING', v: `${visible.length} ROWS` },
        ],
        metaId: 'memories-meta',
      })}

      <div class="append-only-banner">
        <span class="lab">APPEND-ONLY</span>
        <span>
          Memories are <u><b>never deleted or edited</b></u
          >. Lifecycle is <b>active</b> · supersede via new save · <b>archive</b>.
        </span>
      </div>

      ${filterBar}
      <div id="memories-list">
        ${visible.length === 0
          ? tblEmpty('No memories match this filter.')
          : html`
              <div class="tbl-host">
                <table>
                  <thead>
                    <tr>
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
          total: totalCount,
        })}
      </div>
    `;

    return c.html(
      renderPage(c, deps.sessions, body, {
        title: 'Memories',
        activeNav: 'memories',
        counters: { needsReview: needsReviewBadgeCount(deps.repos) },
      }),
    );
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
          counters: { needsReview: needsReviewBadgeCount(deps.repos) },
        }),
        404,
      );
    }

    const project = row.projectId ? deps.repos.projects.adminFindById(row.projectId) : null;
    // `adminGetByIds` has no ORDER BY; sort to honor the chronological contract.
    const predecessors = deps.repos.memory
      .adminGetByIds(row.replaces)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const confirmCount = deps.repos.memory.adminCountConfirmations(row.id);
    const lastConfirmedAt =
      deps.repos.memory.reviewTimestampsByIds([row.id]).get(row.id)?.affirmedAt ?? null;
    const lastRefutedAt =
      deps.repos.memory.reviewTimestampsByIds([row.id]).get(row.id)?.refutedAt ?? null;
    const { reviewState, reviewAfter } = deriveReviewState(
      {
        type: row.type,
        createdAt: row.createdAt,
        status: row.status,
        lastConfirmedAt,
        lastRefutedAt,
      },
      new Date(),
    );
    const successor =
      row.status === 'superseded' ? deps.repos.memory.findSuccessorId(row.id) : undefined;

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
                    <th>content</th>
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
                        <td class="small muted">${truncate(p.content, 160)}</td>
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

    // Uncapped and unpaginated on purpose: the `memory` capability promises the
    // annotations its MCP bound withholds stay "visible via the dashboard", and
    // this is the only per-memory judgment view the dashboard has.
    const touchingRelations = deps.repos.relations
      .adminListTouching(row.id)
      .map((r) => ({ r, kind: annotationKindFor(r, row.id) }))
      .sort((a, b) => compareAnnotations({ ...a.r, kind: a.kind }, { ...b.r, kind: b.kind }));
    const degree = touchingRelations.length;
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
                  ${touchingRelations.map(({ r, kind }) => {
                    const isSource = r.sourceId === row.id;
                    const counterpartId = isSource ? r.targetId : r.sourceId;
                    const counterpartTitle = isSource ? r.targetTitle : r.sourceTitle;
                    const ts = r.judgedAt ?? r.createdAt;
                    // `kind`, not `r.relation`: the column must show what the rows
                    // are sorted by, from this memory's POV. The raw value put a row
                    // labelled supersedes in the superseded_by tier.
                    return html`
                      <tr data-href="/dashboard/judgments/${r.id}">
                        <td>${verdictPill(kind)}</td>
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

    const projectLabel = project?.slug ?? '—';

    const body = html`
      ${viewHead({
        num: '02',
        title: row.title,
        meta: [
          { k: 'ID', v: shortId(row.id) },
          { k: 'STATUS', v: row.status.toUpperCase() },
          { k: 'PROJECT', v: projectLabel },
        ],
      })}
      ${backLink({ href: '/dashboard/memories', label: 'BACK TO MEMORIES' })} ${confirmedFlash}
      ${reviewNotice}
      ${kvGrid([
        kv({ k: 'Status', v: statusPill(row.status) }),
        kv({ k: 'Project', v: projectLabel }),
        kv({ k: 'Type', v: row.type }),
        kv({ k: 'Confirms', v: confirmCount }),
        kv({ k: 'Created', v: formatTs(row.createdAt) }),
        kv({ k: 'Last seen', v: formatTs(row.lastSeenAt) }),
        kv({ k: 'Source', v: sourceLabel }),
        kv({
          k: 'Session',
          v: row.sessionId
            ? html`<a href="/dashboard/sessions/${row.sessionId}">${shortId(row.sessionId)}</a>`
            : '—',
        }),
        ...(successor
          ? [
              kv({
                k: 'Superseded by',
                v: html`<a href="/dashboard/memories/${successor}">${shortId(successor)}</a>`,
              }),
            ]
          : []),
        ...reviewKv,
      ])}

      <h2>Content</h2>
      ${mdBody(row.content)}

      <h2>Tags</h2>
      <p>${tagsHtml}</p>

      <h2>Replaces</h2>
      <p class="mono small">${replacesHtml}</p>

      ${predHtml}

      <h2>Judgments (${degree})</h2>
      ${judgmentsHtml}

      <h2>Actions</h2>
      <p>${archiveButton} ${reviewState !== 'needs_review' ? confirmForm : raw('')}</p>
    `;
    return c.html(
      renderPage(c, deps.sessions, body, {
        title: `Memory ${shortId(row.id)}`,
        activeNav: 'memories',
        counters: { needsReview: needsReviewBadgeCount(deps.repos) },
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
    if (!row.projectId) {
      return domainErrorPage(
        c,
        deps.sessions,
        new DomainError(
          'conflict',
          'This memory predates the default project and has no project to act in. An older image wrote it; it cannot be archived or confirmed from the dashboard.',
        ),
        { title: 'Memory', activeNav: 'memories' },
      );
    }

    try {
      deps.memory.archive(id, projectScope(row.projectId));
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
    if (!row.projectId) {
      return domainErrorPage(
        c,
        deps.sessions,
        new DomainError(
          'conflict',
          'This memory predates the default project and has no project to act in. An older image wrote it; it cannot be archived or confirmed from the dashboard.',
        ),
        { title: 'Memory', activeNav: 'memories' },
      );
    }

    try {
      deps.memory.confirm(id, projectScope(row.projectId), {
        source: { agent: 'dashboard-operator' },
      });
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

function sourceLine(source: Memory['source']): string {
  if (!source) return '—';
  const parts = [
    source.agent ? `agent: ${source.agent}` : null,
    source.tokenName ? `token: ${source.tokenName}` : null,
    source.model ? `model: ${source.model}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(' · ') : '—';
}
