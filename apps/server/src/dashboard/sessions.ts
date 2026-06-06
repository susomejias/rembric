import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import type { Db } from '../db/client.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { memory } from '../db/schema/memory.js';
import { projects } from '../db/schema/projects.js';
import { prompts as promptsTbl } from '../db/schema/prompts.js';
import { tokens } from '../db/schema/tokens.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import { DomainError } from '../services/errors.js';
import type { SessionsService } from '../services/sessions.js';

import { backLink, PAGE_SIZE, pager, urlWithPage, viewHead } from './components.js';
import { csrfInput, readFormAndVerifyCsrf } from './csrf.js';
import { renderPage } from './page-shell.js';
import { formatTs, html, raw, scopePill, shortId, statusPill } from './templates.js';
import type { ResolvedSession } from './types.js';

export interface SessionsDeps {
  db: Db;
  sessions: SessionsService;
  agentSessions: AgentSessionsService;
}

function getSession(c: Context): ResolvedSession | null {
  return (c.get('session') as ResolvedSession | undefined) ?? null;
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
    const page = Math.max(0, parseInt(url.searchParams.get('page') ?? '0', 10) || 0);
    const offset = page * PAGE_SIZE;

    const baseQuery = (opts: { activeFirst: boolean }) =>
      deps.db
        .select({
          id: agentSessions.id,
          agent: agentSessions.agent,
          title: agentSessions.title,
          description: agentSessions.description,
          startedAt: agentSessions.startedAt,
          endedAt: agentSessions.endedAt,
          status: agentSessions.status,
          deletedAt: agentSessions.deletedAt,
          projectId: agentSessions.projectId,
          tokenName: tokens.name,
          tokenRevokedAt: tokens.revokedAt,
          projectSlug: projects.slug,
        })
        .from(agentSessions)
        .leftJoin(tokens, eq(tokens.id, agentSessions.tokenId))
        .leftJoin(projects, eq(projects.id, agentSessions.projectId))
        .orderBy(
          ...(opts.activeFirst
            ? [sql`CASE WHEN ${agentSessions.status} = 'active' THEN 0 ELSE 1 END`]
            : []),
          desc(agentSessions.startedAt),
        )
        .limit(PAGE_SIZE + 1)
        .offset(offset);

    const visibleRowsRaw = baseQuery({ activeFirst: true })
      .where(isNull(agentSessions.deletedAt))
      .all();
    const visibleHasMore = visibleRowsRaw.length > PAGE_SIZE;
    const visibleRows = visibleRowsRaw.slice(0, PAGE_SIZE);
    const deletedRowsRaw = includeDeleted
      ? baseQuery({ activeFirst: false }).where(isNotNull(agentSessions.deletedAt)).all()
      : [];
    const deletedHasMore = deletedRowsRaw.length > PAGE_SIZE;
    const deletedRows = deletedRowsRaw.slice(0, PAGE_SIZE);

    // Per-session memory counts in one query.
    const countRows = deps.db
      .all<{
        session_id: string;
        n: number;
      }>(
        sql`SELECT session_id, COUNT(*) AS n FROM memory WHERE session_id IS NOT NULL GROUP BY session_id`,
      )
      .reduce<Record<string, number>>((acc, r) => {
        acc[r.session_id] = Number(r.n);
        return acc;
      }, {});
    void memory;

    // Per-session prompt counts (non-deleted only).
    const promptCountRows = deps.db
      .all<{
        session_id: string;
        n: number;
      }>(
        sql`SELECT session_id, COUNT(*) AS n FROM prompts WHERE session_id IS NOT NULL AND deleted_at IS NULL GROUP BY session_id`,
      )
      .reduce<Record<string, number>>((acc, r) => {
        acc[r.session_id] = Number(r.n);
        return acc;
      }, {});

    const renderRow = (r: (typeof visibleRows)[number], opts: { deleted: boolean }) => {
      const displayTitle = titleCascade(r.title, r.description, r.id);
      return html`
        <tr data-href="/dashboard/sessions/${r.id}">
          <td class="rbr-session-title" title="${displayTitle}">
            <a href="/dashboard/sessions/${r.id}">${displayTitle}</a>
          </td>
          <td>${r.agent}</td>
          <td>${r.projectSlug ? raw(`<code>${r.projectSlug}</code>`) : scopePill('global')}</td>
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

    const body = html`
      ${viewHead({
        num: '03',
        title: 'Rembric Sessions.',
        hl: 'Rembric',
        meta: [{ k: 'TOTAL', v: String(visibleRows.length) }],
      })}
      ${flash}
      ${includeDeleted
        ? raw(
            '<p class="small muted">Showing soft-deleted rows. <a href="/dashboard/sessions">Hide</a>.</p>',
          )
        : raw(
            '<p class="small muted"><a href="/dashboard/sessions?include_deleted=1">Show deleted</a></p>',
          )}
      <h2>Sessions (${visibleRows.length})</h2>
      ${visibleRows.length === 0
        ? html`<p class="muted">No agent sessions yet.</p>`
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
          })
        : raw('')}
    `;
    return c.html(renderPage(c, deps.sessions, body, { title: 'Sessions', activeNav: 'sessions' }));
  });

  app.get('/:id', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const id = c.req.param('id');
    const row = deps.db
      .select({
        id: agentSessions.id,
        agent: agentSessions.agent,
        title: agentSessions.title,
        description: agentSessions.description,
        startedAt: agentSessions.startedAt,
        endedAt: agentSessions.endedAt,
        status: agentSessions.status,
        summary: agentSessions.summary,
        deletedAt: agentSessions.deletedAt,
        projectId: agentSessions.projectId,
        tokenName: tokens.name,
        tokenRevokedAt: tokens.revokedAt,
        projectSlug: projects.slug,
      })
      .from(agentSessions)
      .leftJoin(tokens, eq(tokens.id, agentSessions.tokenId))
      .leftJoin(projects, eq(projects.id, agentSessions.projectId))
      .where(eq(agentSessions.id, id))
      .get();

    if (!row) {
      return c.html(
        renderPage(c, deps.sessions, html`<p class="flash error">Session not found.</p>`, {
          title: 'Session',
          activeNav: 'sessions',
        }),
        404,
      );
    }

    const memories = deps.db
      .select()
      .from(memory)
      .where(sql`session_id = ${id}`)
      .orderBy(memory.createdAt)
      .all();

    const sessionPrompts = deps.db
      .select()
      .from(promptsTbl)
      .where(sql`session_id = ${id} AND deleted_at IS NULL`)
      .orderBy(promptsTbl.createdAt)
      .all();

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
      <div class="stat-grid">
        <div class="stat-card">
          <div class="label">Status</div>
          <div class="value">${statusPill(row.status)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Agent</div>
          <div class="value">${row.agent}</div>
        </div>
        <div class="stat-card">
          <div class="label">Project</div>
          <div class="value">${row.projectSlug ?? '— (global)'}</div>
        </div>
        <div class="stat-card">
          <div class="label">Token</div>
          <div class="value">
            ${row.tokenName ?? '—'}
            ${row.tokenRevokedAt ? raw('<span class="muted small">(revoked)</span>') : raw('')}
          </div>
        </div>
        <div class="stat-card">
          <div class="label">Started</div>
          <div class="value" style="font-size:.9rem">${formatTs(row.startedAt)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Ended</div>
          <div class="value" style="font-size:.9rem">${formatTs(row.endedAt)}</div>
        </div>
      </div>

      <p>${actionForm}</p>

      ${row.description
        ? html`<h2>Description (seed goal)</h2>
            <pre>${row.description}</pre>`
        : raw('')}

      <h2>Summary</h2>
      <pre>${row.summary ?? '—'}</pre>

      <h2>Memories (${memories.length})</h2>
      ${memories.length === 0
        ? html`<p class="muted">No memories anchored to this session.</p>`
        : html`
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>type</th>
                    <th>content</th>
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
                          <a href="/dashboard/memories/${m.id}">${truncate(m.content, 120)}</a>
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
        ? html`<p class="muted">No prompts anchored to this session.</p>`
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
                            ? raw(p.tags.map((t) => `<code>${t}</code>`).join(' '))
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
        return c.html(
          renderPage(c, deps.sessions, html`<p class="flash error">${err.message}</p>`, {
            title: 'Sessions',
            activeNav: 'sessions',
          }),
          err.code === 'session_not_found' ? 404 : 400,
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
        return c.html(
          renderPage(c, deps.sessions, html`<p class="flash error">${err.message}</p>`, {
            title: 'Sessions',
            activeNav: 'sessions',
          }),
          err.code === 'session_not_found' ? 404 : 400,
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
        return c.html(
          renderPage(c, deps.sessions, html`<p class="flash error">${err.message}</p>`, {
            title: 'Sessions',
            activeNav: 'sessions',
          }),
          err.code === 'session_not_found' ? 404 : 400,
        );
      }
      throw err;
    }
    return c.redirect(`/dashboard/sessions?abandoned=${encodeURIComponent(id)}`);
  });

  return app;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
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

// Maintained import to keep `and` available if future filters compose.
void and;
