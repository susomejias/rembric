import { desc, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import type { Db } from '../db/client.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { memory } from '../db/schema/memory.js';
import { projects } from '../db/schema/projects.js';
import { tokens } from '../db/schema/tokens.js';
import type { SessionsService } from '../services/sessions.js';

import { formatTs, html, raw, scopePill, shell, shortId, statusPill } from './templates.js';
import type { ResolvedSession } from './types.js';

export interface SessionsDeps {
  db: Db;
  sessions: SessionsService;
}

function getSession(c: Context): ResolvedSession | null {
  return (c.get('session') as ResolvedSession | undefined) ?? null;
}

export function createSessionsRouter(deps: SessionsDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const rows = deps.db
      .select({
        id: agentSessions.id,
        agent: agentSessions.agent,
        startedAt: agentSessions.startedAt,
        endedAt: agentSessions.endedAt,
        status: agentSessions.status,
        projectId: agentSessions.projectId,
        tokenName: tokens.name,
        tokenRevokedAt: tokens.revokedAt,
        projectSlug: projects.slug,
      })
      .from(agentSessions)
      .leftJoin(tokens, eq(tokens.id, agentSessions.tokenId))
      .leftJoin(projects, eq(projects.id, agentSessions.projectId))
      .orderBy(desc(agentSessions.startedAt))
      .limit(50)
      .all();

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

    const body = html`
      <h1>Sessions</h1>
      ${rows.length === 0
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
                </tr>
              </thead>
              <tbody>
                ${rows.map(
                  (r) => html`
                    <tr>
                      <td class="mono">
                        <a href="/dashboard/sessions/${r.id}">${shortId(r.id)}</a>
                      </td>
                      <td>${r.agent}</td>
                      <td>
                        ${r.projectSlug
                          ? raw(`<code>${r.projectSlug}</code>`)
                          : scopePill('global')}
                      </td>
                      <td class="small">
                        ${r.tokenName ?? '—'}
                        ${r.tokenRevokedAt
                          ? raw('<span class="muted small">(revoked)</span>')
                          : raw('')}
                      </td>
                      <td class="muted">${formatTs(r.startedAt)}</td>
                      <td class="muted">${formatTs(r.endedAt)}</td>
                      <td>${statusPill(r.status)}</td>
                      <td class="right">${countRows[r.id] ?? 0}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
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

    const body = html`
      <h1>Session <code>${shortId(row.id)}</code></h1>
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

  return app;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
