import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import type { Db } from '../db/client.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { memory } from '../db/schema/memory.js';
import { projects } from '../db/schema/projects.js';
import { tokens } from '../db/schema/tokens.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import { DomainError } from '../services/errors.js';
import type { SessionsService } from '../services/sessions.js';

import { csrfInput, readFormAndVerifyCsrf } from './csrf.js';
import { formatTs, html, raw, scopePill, shell, shortId, statusPill } from './templates.js';
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
    const includeDeleted = url.searchParams.get('include_deleted') === '1';

    const baseQuery = () =>
      deps.db
        .select({
          id: agentSessions.id,
          agent: agentSessions.agent,
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
        .orderBy(desc(agentSessions.startedAt))
        .limit(50);

    const visibleRows = baseQuery().where(isNull(agentSessions.deletedAt)).all();
    const deletedRows = includeDeleted
      ? baseQuery().where(isNotNull(agentSessions.deletedAt)).all()
      : [];

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

    const renderRow = (r: (typeof visibleRows)[number], opts: { deleted: boolean }) => html`
      <tr>
        <td class="mono">
          <a href="/dashboard/sessions/${r.id}">${shortId(r.id)}</a>
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
        <td>
          ${opts.deleted
            ? html`
                <form action="/dashboard/sessions/${r.id}/undelete" method="post" class="inline">
                  ${csrfInput(session.session, deps.sessions, 'session.undelete')}
                  <button type="submit">Undelete</button>
                </form>
              `
            : html`
                <form action="/dashboard/sessions/${r.id}/delete" method="post" class="inline">
                  ${csrfInput(session.session, deps.sessions, 'session.delete')}
                  <button class="warn" type="submit">Delete</button>
                </form>
              `}
        </td>
      </tr>
    `;

    const flash = justDeleted
      ? html`<p class="flash success">
          Session <code>${justDeleted}</code> soft-deleted.
          <a href="/dashboard/sessions/${justDeleted}">View</a>
          to undelete.
        </p>`
      : justRestored
        ? html`<p class="flash success">Session <code>${justRestored}</code> restored.</p>`
        : raw('');

    const body = html`
      <h1>Sessions</h1>
      ${flash}
      ${includeDeleted
        ? raw(
            '<p class="small muted">Showing soft-deleted rows. <a href="/dashboard/sessions">Hide</a>.</p>',
          )
        : raw(
            '<p class="small muted"><a href="/dashboard/sessions?include_deleted=1">Show deleted</a></p>',
          )}
      <h2>Active (${visibleRows.length})</h2>
      ${visibleRows.length === 0
        ? html`<p class="muted">No agent sessions yet.</p>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>id</th>
                  <th>agent</th>
                  <th>project</th>
                  <th>token</th>
                  <th>started</th>
                  <th>ended</th>
                  <th>status</th>
                  <th>memories</th>
                  <th>actions</th>
                </tr>
              </thead>
              <tbody>
                ${visibleRows.map((r) => renderRow(r, { deleted: false }))}
              </tbody>
            </table>
          `}
      ${includeDeleted && deletedRows.length > 0
        ? html`
            <h2>Deleted (${deletedRows.length})</h2>
            <table>
              <thead>
                <tr>
                  <th>id</th>
                  <th>agent</th>
                  <th>project</th>
                  <th>token</th>
                  <th>started</th>
                  <th>ended</th>
                  <th>status</th>
                  <th>memories</th>
                  <th>actions</th>
                </tr>
              </thead>
              <tbody>
                ${deletedRows.map((r) => renderRow(r, { deleted: true }))}
              </tbody>
            </table>
          `
        : raw('')}
    `;
    return c.html(shell(body, { title: 'Sessions', activeNav: 'sessions' }));
  });

  app.get('/:id', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const id = c.req.param('id');
    const row = deps.db
      .select({
        id: agentSessions.id,
        agent: agentSessions.agent,
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
        shell(html`<p class="flash error">Session not found.</p>`, {
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

    const actionForm = row.deletedAt
      ? html`
          <form action="/dashboard/sessions/${row.id}/undelete" method="post" class="inline">
            ${csrfInput(session.session, deps.sessions, 'session.undelete')}
            <button class="primary" type="submit">Undelete</button>
          </form>
        `
      : html`
          <form action="/dashboard/sessions/${row.id}/delete" method="post" class="inline">
            ${csrfInput(session.session, deps.sessions, 'session.delete')}
            <button class="warn" type="submit">Delete</button>
          </form>
        `;

    const body = html`
      <h1>Session <code>${shortId(row.id)}</code></h1>
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
            <table>
              <thead>
                <tr>
                  <th>id</th>
                  <th>type</th>
                  <th>content</th>
                  <th>status</th>
                  <th>created</th>
                </tr>
              </thead>
              <tbody>
                ${memories.map(
                  (m) => html`
                    <tr>
                      <td class="mono">
                        <a href="/dashboard/memories/${m.id}">${shortId(m.id)}</a>
                      </td>
                      <td>${m.type}</td>
                      <td>${truncate(m.content, 120)}</td>
                      <td>${statusPill(m.status)}</td>
                      <td class="muted">${formatTs(m.createdAt)}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
    `;
    return c.html(shell(body, { title: `Session ${shortId(row.id)}`, activeNav: 'sessions' }));
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
          shell(html`<p class="flash error">${err.message}</p>`, {
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
          shell(html`<p class="flash error">${err.message}</p>`, {
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

  return app;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// Maintained import to keep `and` available if future filters compose.
void and;
