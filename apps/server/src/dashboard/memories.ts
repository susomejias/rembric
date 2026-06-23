import { Hono, type Context } from 'hono';

import type { AdminListMemoriesOpts, Repositories } from '../db/repositories/index.js';
import type { Memory, MemoryType } from '../db/schema/memory.js';
import { DomainError } from '../services/errors.js';
import type { MemoryService } from '../services/memory.js';
import { deriveReviewState, REVIEW_TTL_MS, type ReviewState } from '../services/review.js';
import { projectScope, SCOPE_GLOBAL } from '../services/scope.js';
import type { SessionsService } from '../services/sessions.js';

import { backLink, PAGE_SIZE, pager, renderMarkdown, urlWithPage, viewHead } from './components.js';
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
} from './templates.js';
import type { ResolvedSession } from './types.js';

export interface MemoriesDeps {
  repos: Repositories;
  memory: MemoryService;
  sessions: SessionsService;
}

function getSession(c: Context): ResolvedSession | null {
  return (c.get('session') as ResolvedSession | undefined) ?? null;
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
        .adminSearchFts(query, PAGE_SIZE, offset)
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

    const rowsHtml = visible.map((m) => {
      const projectLabel = m.projectId
        ? (projectById.get(m.projectId)?.slug ?? shortId(m.projectId))
        : '—';
      return html`
        <tr data-href="/dashboard/memories/${m.id}">
          <td>${scopePill(m.scope)}</td>
          <td>${projectLabel}</td>
          <td>${m.type}</td>
          <td><a href="/dashboard/memories/${m.id}">${truncate(m.content, 100)}</a></td>
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

    const projectOptions = [
      raw('<option value="">all scopes</option>'),
      raw(
        `<option value="__global__"${projectFilter === '__global__' ? ' selected' : ''}>global only</option>`,
      ),
      ...projectRows.map((p) =>
        raw(
          `<option value="${escape(p.slug)}"${projectFilter === p.slug ? ' selected' : ''}>${escape(p.slug)}</option>`,
        ),
      ),
    ];

    const statusOptions = (['active', 'superseded', 'archived'] as const).map((s) =>
      raw(`<option value="${s}"${statusFilter === s ? ' selected' : ''}>${s}</option>`),
    );
    const typeOptions = [
      raw(`<option value="">all types</option>`),
      ...(['user', 'feedback', 'project', 'reference'] as const).map((t) =>
        raw(`<option value="${t}"${typeFilter === t ? ' selected' : ''}>${t}</option>`),
      ),
    ];
    const reviewOptions = [
      raw(`<option value="">any review</option>`),
      raw(
        `<option value="needs_review"${wantNeedsReview ? ' selected' : ''}>needs_review</option>`,
      ),
    ];

    const body = html`
      ${viewHead({
        num: '02',
        title: 'Rembric Memories.',
        hl: 'Rembric',
        meta: [
          { k: 'TOTAL', v: String(rows.length) },
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

      <form class="filters" method="get">
        <span class="group">
          <span class="k">SCOPE</span>
          <select name="project">
            ${projectOptions}
          </select>
        </span>
        <span class="group">
          <span class="k">STATUS</span>
          <select name="status">
            ${statusOptions}
          </select>
        </span>
        <span class="group">
          <span class="k">TYPE</span>
          <select name="type">
            ${typeOptions}
          </select>
        </span>
        <span class="group">
          <span class="k">REVIEW</span>
          <select name="review">
            ${reviewOptions}
          </select>
        </span>
        <span class="group search">
          <span class="k">SEARCH</span>
          <input type="search" name="q" value="${query}" placeholder="FTS5 keyword, tag, topic" />
        </span>
        <span class="acts">
          <button class="btn primary" type="submit">FILTER</button>
          <a class="clear" href="/dashboard/memories">CLEAR</a>
        </span>
      </form>

      <div class="tbl-host">
        <table>
          <thead>
            <tr>
              <th>scope</th>
              <th>project</th>
              <th>type</th>
              <th>content</th>
              <th>status</th>
              <th>review</th>
              <th>created</th>
            </tr>
          </thead>
          <tbody>
            ${visible.length === 0
              ? html`<tr>
                  <td colspan="7" class="muted">No memories match this filter.</td>
                </tr>`
              : rowsHtml}
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
    // Shown only for an active row whose type has a TTL (reviewAfter set).
    const reviewCard =
      reviewState !== null && reviewAfter !== null
        ? html`
            <div class="stat-card">
              <div class="label">Review</div>
              <div class="value">
                ${reviewState === 'needs_review' ? reviewPill() : raw('fresh')}
              </div>
              <div class="label" style="margin-top:.4rem">Review after</div>
              <div class="value" style="font-size:.9rem">${formatTs(reviewAfter)}</div>
            </div>
          `
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
                          <a href="/dashboard/memories/${p.id}">${truncate(p.content, 120)}</a>
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

    const body = html`
      ${viewHead({
        num: '02',
        title: `Rembric Memory ${shortId(row.id)}.`,
        hl: 'Rembric',
        meta: [
          { k: 'STATUS', v: row.status.toUpperCase() },
          { k: 'SCOPE', v: row.scope.toUpperCase() },
        ],
      })}
      ${backLink({ href: '/dashboard/memories', label: 'BACK TO MEMORIES' })}
      <div class="stat-grid">
        <div class="stat-card">
          <div class="label">Status</div>
          <div class="value">${statusPill(row.status)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Scope</div>
          <div class="value">${scopePill(row.scope)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Project</div>
          <div class="value">${project?.slug ?? '—'}</div>
        </div>
        <div class="stat-card">
          <div class="label">Type</div>
          <div class="value">${row.type}</div>
        </div>
        <div class="stat-card">
          <div class="label">Confirms</div>
          <div class="value">${confirmCount}</div>
        </div>
        <div class="stat-card">
          <div class="label">Created</div>
          <div class="value" style="font-size:.9rem">${formatTs(row.createdAt)}</div>
        </div>
        ${reviewCard}
      </div>

      <h2>Content</h2>
      <div class="md-body">${renderMarkdown(row.content)}</div>

      <h2>Tags</h2>
      <p>${tagsHtml}</p>

      <h2>Replaces</h2>
      <p class="mono small">${row.replaces.length === 0 ? '—' : row.replaces.join(', ')}</p>

      ${predHtml}

      <h2>Actions</h2>
      <p>${archiveButton}</p>
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
        return c.html(
          renderPage(c, deps.sessions, html`<p class="flash error">${err.message}</p>`, {
            title: 'Memory',
            activeNav: 'memories',
          }),
          400,
        );
      }
      throw err;
    }
    return c.redirect(`/dashboard/memories/${id}`);
  });

  return app;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
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
