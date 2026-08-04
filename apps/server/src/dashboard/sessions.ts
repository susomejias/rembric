import { Hono } from 'hono';

import type { Repositories } from '../db/repositories/index.js';
import { AGENT_SESSION_STATUSES, type AgentSessionStatus } from '../db/schema/agent-sessions.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import { DomainError } from '../services/errors.js';
import type { SessionsService } from '../services/sessions.js';

import {
  backLink,
  domainErrorPage,
  filterGroup,
  filtersBar,
  getSession,
  inp,
  kv,
  kvGrid,
  PAGE_SIZE,
  pageParam,
  pager,
  projectFilterParam,
  mdBody,
  sel,
  tblEmpty,
  truncate,
  urlWithPage,
  viewHead,
} from './components.js';
import { csrfInput, readFormAndVerifyCsrf } from './csrf.js';
import { renderPage } from './page-shell.js';
import { escape, formatTs, html, raw, rawPill, shortId, statusPill } from './templates.js';

export interface SessionsDeps {
  repos: Repositories;
  sessions: SessionsService;
  agentSessions: AgentSessionsService;
}

export function createSessionsRouter(deps: SessionsDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const url = new URL(c.req.url);
    const justDeleted = url.searchParams.get('deleted');
    const justRestored = url.searchParams.get('restored');
    const justAbandoned = url.searchParams.get('abandoned');
    const includeDeleted = url.searchParams.get('include_deleted') === '1';
    const projectFilter = projectFilterParam(url);
    const agentFilter = url.searchParams.get('agent') ?? '';
    const statusFilterRaw = url.searchParams.get('status') ?? '';
    const statusFilter = (AGENT_SESSION_STATUSES as readonly string[]).includes(statusFilterRaw)
      ? (statusFilterRaw as AgentSessionStatus)
      : undefined;
    const page = pageParam(url);
    const offset = page * PAGE_SIZE;

    const projectRows = deps.repos.projects.adminListAll();
    const projectBySlug = new Map(projectRows.map((p) => [p.slug, p]));

    let projectId: string | undefined;
    if (projectFilter) {
      const p = projectBySlug.get(projectFilter);
      if (p) projectId = p.id;
    }

    const visibleRowsRaw = deps.repos.agentSessions.adminList({
      deleted: false,
      activeFirst: true,
      projectId,
      agent: agentFilter || undefined,
      status: statusFilter,
      limit: PAGE_SIZE + 1,
      offset,
    });
    const visibleHasMore = visibleRowsRaw.length > PAGE_SIZE;
    const visibleRows = visibleRowsRaw.slice(0, PAGE_SIZE);
    // Filters apply to the non-deleted table only; include_deleted is unchanged.
    const deletedRowsRaw = includeDeleted
      ? deps.repos.agentSessions.adminList({
          deleted: true,
          activeFirst: false,
          limit: PAGE_SIZE + 1,
          offset,
        })
      : [];
    const deletedHasMore = deletedRowsRaw.length > PAGE_SIZE;
    const deletedRows = deletedRowsRaw.slice(0, PAGE_SIZE);

    const pageSessionIds = [...visibleRows, ...deletedRows].map((r) => r.id);
    const countRows = deps.repos.memory.adminCountBySession(pageSessionIds);
    const promptCountRows = deps.repos.prompts.adminCountBySession(pageSessionIds);

    const renderRow = (r: (typeof visibleRows)[number], opts: { deleted: boolean }) => {
      const displayTitle = titleCascade(r.title, r.description, r.id);
      return html`
        <tr data-href="/dashboard/sessions/${r.id}">
          <td class="rbr-session-title" title="${displayTitle}">
            <a href="/dashboard/sessions/${r.id}">${displayTitle}</a>
          </td>
          <td>${r.agent}</td>
          <td>${r.projectSlug ? raw(`<code>${escape(r.projectSlug)}</code>`) : raw('—')}</td>
          <td class="small">
            ${r.tokenName ?? '—'}
            ${r.tokenRevokedAt ? raw('<span class="muted small">(revoked)</span>') : raw('')}
          </td>
          <td class="muted">${formatTs(r.startedAt)}</td>
          <td class="muted">${formatTs(r.endedAt)}</td>
          <td>${statusPill(r.status)}</td>
          <td class="right">${countRows[r.id] ?? 0}</td>
          <td class="right">${promptCountRows[r.id] ?? 0}</td>
          <td class="actions">
            <div class="actions-stack">
              ${opts.deleted
                ? html`
                    <form
                      action="/dashboard/sessions/${r.id}/undelete"
                      method="post"
                      class="inline"
                    >
                      ${csrfInput(session.session, deps.sessions, 'session.undelete')}
                      <button type="submit">Undelete</button>
                    </form>
                  `
                : html`
                    ${r.status === 'active'
                      ? html`
                          <form
                            action="/dashboard/sessions/${r.id}/abandon"
                            method="post"
                            class="inline"
                            data-confirm="Mark this session as abandoned? Its ${countRows[r.id] ??
                            0} memories stay queryable and the row stays visible in the list. This transition is not reversible from the dashboard."
                            data-confirm-label="ABANDON SESSION"
                            data-confirm-tone="warn"
                          >
                            ${csrfInput(session.session, deps.sessions, 'session.abandon')}
                            <button class="warn" type="submit">Abandon</button>
                          </form>
                        `
                      : raw('')}
                    <form
                      action="/dashboard/sessions/${r.id}/delete"
                      method="post"
                      class="inline"
                      data-confirm="Soft-delete this session? Its memories stay queryable but the session is hidden from the list. You can restore it with ?include_deleted=1."
                      data-confirm-label="DELETE SESSION"
                      data-confirm-tone="danger"
                    >
                      ${csrfInput(session.session, deps.sessions, 'session.delete')}
                      <button class="danger" type="submit">Delete</button>
                    </form>
                  `}
            </div>
          </td>
        </tr>
      `;
    };

    const flash = justDeleted
      ? html`<p class="flash success">
          Session <code>${justDeleted}</code> soft-deleted.
          <a href="/dashboard/sessions/${justDeleted}">View</a>
          to undelete.
        </p>`
      : justRestored
        ? html`<p class="flash success">Session <code>${justRestored}</code> restored.</p>`
        : justAbandoned
          ? html`<p class="flash success">
              Session <code>${justAbandoned}</code> marked as abandoned.
              <a href="/dashboard/sessions/${justAbandoned}">View</a>.
            </p>`
          : raw('');

    const projectOptionsList = [
      { value: '', label: 'all scopes', selected: projectFilter === '' },
      ...projectRows.map((p) => ({
        value: p.slug,
        label: p.slug,
        selected: projectFilter === p.slug,
      })),
    ];
    const statusOptionsList = [
      { value: '', label: 'all statuses', selected: statusFilterRaw === '' },
      ...AGENT_SESSION_STATUSES.map((s) => ({
        value: s,
        label: s,
        selected: statusFilterRaw === s,
      })),
    ];
    const filterBar = filtersBar([
      filterGroup('SCOPE', 'f-project', sel('project', projectOptionsList, { id: 'f-project' })),
      filterGroup(
        'AGENT',
        'f-agent',
        inp('agent', agentFilter, 'e.g. claude-code', { id: 'f-agent' }),
      ),
      filterGroup('STATUS', 'f-status', sel('status', statusOptionsList, { id: 'f-status' })),
      includeDeleted ? raw('<input type="hidden" name="include_deleted" value="1" />') : raw(''),
      html`<span class="acts">
        <button class="btn primary" type="submit">FILTER</button>
        <a class="clear" href="/dashboard/sessions${includeDeleted ? '?include_deleted=1' : ''}"
          >CLEAR</a
        >
      </span>`,
    ]);

    const total = deps.repos.agentSessions.adminCount({
      deleted: false,
      projectId,
      agent: agentFilter || undefined,
      status: statusFilter,
    });

    const body = html`
      ${viewHead({
        num: '03',
        title: 'Rembric Sessions.',
        hl: 'Rembric',
        meta: [{ k: 'TOTAL', v: String(total) }],
      })}
      ${flash}
      ${includeDeleted
        ? raw(
            '<p class="small muted">Showing soft-deleted rows. <a href="/dashboard/sessions">Hide</a>.</p>',
          )
        : raw(
            '<p class="small muted"><a href="/dashboard/sessions?include_deleted=1">Show deleted</a></p>',
          )}
      ${filterBar}
      <h2>Sessions (${visibleRows.length})</h2>
      ${visibleRows.length === 0
        ? tblEmpty('No agent sessions match this filter.')
        : html`
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>title</th>
                    <th>agent</th>
                    <th>project</th>
                    <th>token</th>
                    <th>started</th>
                    <th>ended</th>
                    <th>status</th>
                    <th>memories</th>
                    <th>prompts</th>
                    <th>actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${visibleRows.map((r) => renderRow(r, { deleted: false }))}
                </tbody>
              </table>
            </div>
          `}
      ${includeDeleted && deletedRows.length > 0
        ? html`
            <h2>Deleted (${deletedRows.length})</h2>
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>title</th>
                    <th>agent</th>
                    <th>project</th>
                    <th>token</th>
                    <th>started</th>
                    <th>ended</th>
                    <th>status</th>
                    <th>memories</th>
                    <th>prompts</th>
                    <th>actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${deletedRows.map((r) => renderRow(r, { deleted: true }))}
                </tbody>
              </table>
            </div>
          `
        : raw('')}
      ${visibleRows.length > 0 || page > 0
        ? pager({
            page,
            hasMore: visibleHasMore || (includeDeleted && deletedHasMore),
            pageHrefBuilder: (p) => urlWithPage(c.req.url, p),
            totalLabel: `${visibleRows.length} ROWS`,
            total,
          })
        : raw('')}
    `;
    return c.html(renderPage(c, deps.sessions, body, { title: 'Sessions', activeNav: 'sessions' }));
  });

  app.get('/:id', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const id = c.req.param('id');
    const row = deps.repos.agentSessions.adminGetDetail(id);

    if (!row) {
      return c.html(
        renderPage(c, deps.sessions, html`<p class="flash error">Session not found.</p>`, {
          title: 'Session',
          activeNav: 'sessions',
        }),
        404,
      );
    }

    const memories = deps.repos.memory.adminListBySession(id);
    const sessionPrompts = deps.repos.prompts.adminListBySession(id);

    const memoriesCount = memories.length;
    const actionForm = row.deletedAt
      ? html`
          <div class="actions-stack">
            <form action="/dashboard/sessions/${row.id}/undelete" method="post" class="inline">
              ${csrfInput(session.session, deps.sessions, 'session.undelete')}
              <button class="primary" type="submit">Undelete</button>
            </form>
          </div>
        `
      : html`
          <div class="actions-stack">
            ${row.status === 'active'
              ? html`
                  <form
                    action="/dashboard/sessions/${row.id}/abandon"
                    method="post"
                    class="inline"
                    data-confirm="Mark this session as abandoned? Its ${memoriesCount} memories stay queryable and the row stays visible in the list. This transition is not reversible from the dashboard."
                    data-confirm-label="ABANDON SESSION"
                    data-confirm-tone="warn"
                  >
                    ${csrfInput(session.session, deps.sessions, 'session.abandon')}
                    <button class="warn" type="submit">Abandon</button>
                  </form>
                `
              : raw('')}
            <form
              action="/dashboard/sessions/${row.id}/delete"
              method="post"
              class="inline"
              data-confirm="Soft-delete this session? Its memories stay queryable but the session is hidden from the list. You can restore it from the list with ?include_deleted=1."
              data-confirm-label="DELETE SESSION"
              data-confirm-tone="danger"
            >
              ${csrfInput(session.session, deps.sessions, 'session.delete')}
              <button class="danger" type="submit">Delete</button>
            </form>
          </div>
        `;

    const detailTitle = titleCascade(row.title, row.description, row.id);
    const body = html`
      ${viewHead({
        num: '03',
        title: `${detailTitle}.`,
        hl: '',
        meta: [{ k: 'STATUS', v: row.status.toUpperCase() }],
      })}
      ${backLink({ href: '/dashboard/sessions', label: 'BACK TO SESSIONS' })}
      ${row.deletedAt
        ? html`<p class="flash error">
            This session is soft-deleted (at ${formatTs(row.deletedAt)}). Memories that reference it
            keep their <code>session_id</code> pointer intact.
          </p>`
        : raw('')}
      ${kvGrid([
        kv({ k: 'Status', v: statusPill(row.status) }),
        kv({ k: 'Agent', v: row.agent }),
        kv({ k: 'Project', v: row.projectSlug ?? '—' }),
        kv({
          k: 'Token',
          v: html`${row.tokenName ?? '—'}${row.tokenRevokedAt
            ? raw('<span class="muted small">(revoked)</span>')
            : raw('')}`,
        }),
        kv({ k: 'Started', v: formatTs(row.startedAt) }),
        kv({ k: 'Ended', v: formatTs(row.endedAt) }),
      ])}

      <p>${actionForm}</p>

      ${row.description
        ? html`<h2>Description (seed goal)</h2>
            ${mdBody(row.description)}`
        : raw('')}

      <h2>Summary${row.summary && !row.summaryFinal ? html` ${rawPill()}` : raw('')}</h2>
      ${row.summary
        ? row.summaryFinal
          ? mdBody(row.summary)
          : html`<pre>${row.summary}</pre>`
        : html`<p>—</p>`}

      <h2>Memories (${memories.length})</h2>
      ${memories.length === 0
        ? tblEmpty('No memories anchored to this session.')
        : html`
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>type</th>
                    <th>title</th>
                    <th>status</th>
                    <th>created</th>
                  </tr>
                </thead>
                <tbody>
                  ${memories.map(
                    (m) => html`
                      <tr data-href="/dashboard/memories/${m.id}">
                        <td>${m.type}</td>
                        <td>
                          <a href="/dashboard/memories/${m.id}">${truncate(m.title, 120)}</a>
                        </td>
                        <td>${statusPill(m.status)}</td>
                        <td class="muted">${formatTs(m.createdAt)}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `}

      <h2>Prompts (${sessionPrompts.length})</h2>
      ${sessionPrompts.length === 0
        ? tblEmpty('No prompts anchored to this session.')
        : html`
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>title</th>
                    <th>content</th>
                    <th>tags</th>
                    <th>created</th>
                  </tr>
                </thead>
                <tbody>
                  ${sessionPrompts.map(
                    (p) => html`
                      <tr>
                        <td>${p.title ?? '—'}</td>
                        <td>${truncate(p.content, 120)}</td>
                        <td>
                          ${Array.isArray(p.tags) && p.tags.length > 0
                            ? raw(p.tags.map((t) => `<code>${escape(t)}</code>`).join(' '))
                            : raw('—')}
                        </td>
                        <td class="muted">${formatTs(p.createdAt)}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `}
    `;
    return c.html(
      renderPage(c, deps.sessions, body, {
        title: `Session ${shortId(row.id)}`,
        activeNav: 'sessions',
      }),
    );
  });

  app.post('/:id/delete', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'session.delete');
    if (form instanceof Response) return form;
    const id = c.req.param('id');
    try {
      deps.agentSessions.softDelete(id, { adminBypass: true });
    } catch (err) {
      if (err instanceof DomainError) {
        return domainErrorPage(
          c,
          deps.sessions,
          err,
          { title: 'Sessions', activeNav: 'sessions' },
          (code) => (code === 'session_not_found' ? 404 : 400),
        );
      }
      throw err;
    }
    return c.redirect(`/dashboard/sessions?deleted=${encodeURIComponent(id)}`);
  });

  app.post('/:id/undelete', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'session.undelete');
    if (form instanceof Response) return form;
    const id = c.req.param('id');
    try {
      deps.agentSessions.undelete(id, { adminBypass: true });
    } catch (err) {
      if (err instanceof DomainError) {
        return domainErrorPage(
          c,
          deps.sessions,
          err,
          { title: 'Sessions', activeNav: 'sessions' },
          (code) => (code === 'session_not_found' ? 404 : 400),
        );
      }
      throw err;
    }
    return c.redirect(`/dashboard/sessions?restored=${encodeURIComponent(id)}`);
  });

  app.post('/:id/abandon', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'session.abandon');
    if (form instanceof Response) return form;
    const id = c.req.param('id');
    try {
      deps.agentSessions.markAbandoned(id, { adminBypass: true });
    } catch (err) {
      if (err instanceof DomainError) {
        return domainErrorPage(
          c,
          deps.sessions,
          err,
          { title: 'Sessions', activeNav: 'sessions' },
          (code) => (code === 'session_not_found' ? 404 : 400),
        );
      }
      throw err;
    }
    return c.redirect(`/dashboard/sessions?abandoned=${encodeURIComponent(id)}`);
  });

  return app;
}

/**
 * Derive a human-readable label for a session row.
 *
 * Cascade: explicit title → description (seed goal) → shortId fallback.
 * The cascade does NOT short-circuit placeholder titles (e.g. `rembric ·
 * 22:14 UTC`) — they count as real titles for display because they are
 * still more informative than the bare shortId.
 */
function titleCascade(
  title: string | null | undefined,
  description: string | null | undefined,
  id: string,
): string {
  if (title && title.length > 0) return title;
  if (description && description.length > 0) return description;
  return shortId(id);
}
