import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import type { Db } from '../db/client.js';
import { confirmations } from '../db/schema/confirmations.js';
import { memory, type Memory } from '../db/schema/memory.js';
import { projects } from '../db/schema/projects.js';
import { DomainError } from '../services/errors.js';
import type { MemoryService } from '../services/memory.js';
import { projectScope, SCOPE_GLOBAL } from '../services/scope.js';
import type { SessionsService } from '../services/sessions.js';

import { readFormAndVerifyCsrf, csrfInput } from './csrf.js';
import { escape, formatTs, html, raw, scopePill, shell, shortId, statusPill } from './templates.js';
import type { ResolvedSession } from './types.js';

export interface MemoriesDeps {
  db: Db;
  memory: MemoryService;
  sessions: SessionsService;
}

const PAGE_SIZE = 25;

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
    const query = url.searchParams.get('q') ?? '';
    const page = Math.max(0, parseInt(url.searchParams.get('page') ?? '0', 10) || 0);
    const offset = page * PAGE_SIZE;

    const projectRows = deps.db.select().from(projects).all();
    const projectByPath = new Map(projectRows.map((p) => [p.path, p]));
    const projectById = new Map(projectRows.map((p) => [p.id, p]));

    const conditions = [eq(memory.status, statusFilter as 'active' | 'superseded' | 'archived')];
    if (typeFilter) {
      conditions.push(eq(memory.type, typeFilter as Memory['type']));
    }
    if (projectFilter === '__global__') {
      conditions.push(eq(memory.scope, 'global'));
      conditions.push(isNull(memory.projectId));
    } else if (projectFilter) {
      const p = projectByPath.get(projectFilter);
      if (p) {
        conditions.push(eq(memory.scope, 'project'));
        conditions.push(eq(memory.projectId, p.id));
      }
    }

    let rows: Memory[];
    if (query) {
      const ids = deps.db
        .all<{ id: string }>(
          sql`
            SELECT m.id
            FROM memory m
            JOIN memory_fts f ON f.rowid = m.rowid
            WHERE memory_fts MATCH ${query}
            ORDER BY rank, m.created_at DESC
            LIMIT ${PAGE_SIZE} OFFSET ${offset}
          `,
        )
        .map((r) => r.id);
      rows =
        ids.length === 0
          ? []
          : deps.db
              .select()
              .from(memory)
              .where(sql`id IN ${ids}`)
              .all()
              .filter((m) =>
                clientSideFilter(m, projectByPath, projectFilter, statusFilter, typeFilter),
              );
    } else {
      rows = deps.db
        .select()
        .from(memory)
        .where(and(...conditions))
        .orderBy(desc(memory.createdAt))
        .limit(PAGE_SIZE + 1)
        .offset(offset)
        .all();
    }

    const hasMore = rows.length > PAGE_SIZE;
    const visible = rows.slice(0, PAGE_SIZE);

    const rowsHtml = visible.map((m) => {
      const projectLabel = m.projectId
        ? (projectById.get(m.projectId)?.path ?? shortId(m.projectId))
        : '—';
      return html`
        <tr>
          <td class="mono"><a href="/dashboard/memories/${m.id}">${shortId(m.id)}</a></td>
          <td>${scopePill(m.scope)}</td>
          <td>${projectLabel}</td>
          <td>${m.type}</td>
          <td>${truncate(m.content, 100)}</td>
          <td>${statusPill(m.status)}</td>
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
          `<option value="${escape(p.path)}"${projectFilter === p.path ? ' selected' : ''}>${escape(p.path)}</option>`,
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

    const body = html`
      <h1>Memories</h1>
      <form class="filters" method="get">
        <select name="project">
          ${projectOptions}
        </select>
        <select name="status">
          ${statusOptions}
        </select>
        <select name="type">
          ${typeOptions}
        </select>
        <input type="search" name="q" value="${query}" placeholder="FTS keyword" />
        <button type="submit">Filter</button>
        <a class="small" href="/dashboard/memories">clear</a>
      </form>

      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>scope</th>
            <th>project</th>
            <th>type</th>
            <th>content</th>
            <th>status</th>
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

      <div class="pager">
        <span class="small">page ${page + 1}</span>
        <span>
          ${page > 0 ? html`<a href="${urlWithPage(c.req.url, page - 1)}">← prev</a>` : raw('')}
          ${hasMore ? html` <a href="${urlWithPage(c.req.url, page + 1)}">next →</a>` : raw('')}
        </span>
      </div>
    `;

    return c.html(shell(body, { title: 'Memories', activeNav: 'memories' }));
  });

  app.get('/:id', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const id = c.req.param('id');
    const row = deps.memory.unsafeGetById(id);
    if (!row) {
      return c.html(
        shell(html`<p class="flash error">Memory not found.</p>`, {
          title: 'Memory',
          activeNav: 'memories',
        }),
        404,
      );
    }

    const project = row.projectId
      ? deps.db.select().from(projects).where(eq(projects.id, row.projectId)).get()
      : null;
    const predecessors =
      row.replaces.length === 0
        ? []
        : deps.db
            .select()
            .from(memory)
            .where(sql`id IN ${row.replaces}`)
            .all();
    const confirmCountRow = deps.db
      .select({ v: sql<number>`count(*)` })
      .from(confirmations)
      .where(eq(confirmations.memoryId, row.id))
      .get();

    const archiveButton =
      row.status === 'active'
        ? html`
            <form action="/dashboard/memories/${row.id}/archive" method="post" class="inline">
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
            <table>
              <thead>
                <tr>
                  <th>id</th>
                  <th>status</th>
                  <th>content</th>
                  <th>created</th>
                </tr>
              </thead>
              <tbody>
                ${predecessors.map(
                  (p) => html`
                    <tr>
                      <td class="mono">
                        <a href="/dashboard/memories/${p.id}">${shortId(p.id)}</a>
                      </td>
                      <td>${statusPill(p.status)}</td>
                      <td>${truncate(p.content, 120)}</td>
                      <td class="muted">${formatTs(p.createdAt)}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `;

    const tagsHtml =
      row.tags.length === 0
        ? raw('<span class="muted">—</span>')
        : row.tags.map((t) => raw(`<span class="pill">${escape(t)}</span> `));

    const body = html`
      <h1>Memory <code>${shortId(row.id)}</code></h1>
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
          <div class="value">${project?.path ?? '—'}</div>
        </div>
        <div class="stat-card">
          <div class="label">Type</div>
          <div class="value">${row.type}</div>
        </div>
        <div class="stat-card">
          <div class="label">Confirms</div>
          <div class="value">${confirmCountRow?.v ?? 0}</div>
        </div>
        <div class="stat-card">
          <div class="label">Created</div>
          <div class="value" style="font-size:.9rem">${formatTs(row.createdAt)}</div>
        </div>
      </div>

      <h2>Content</h2>
      <pre>${row.content}</pre>

      <h2>Tags</h2>
      <p>${tagsHtml}</p>

      <h2>Replaces</h2>
      <p class="mono small">${row.replaces.length === 0 ? '—' : row.replaces.join(', ')}</p>

      ${predHtml}

      <h2>Actions</h2>
      <p>${archiveButton}</p>
    `;
    return c.html(shell(body, { title: `Memory ${shortId(row.id)}`, activeNav: 'memories' }));
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
          shell(html`<p class="flash error">${err.message}</p>`, {
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
  projectByPath: Map<string, { id: string }>,
  projectFilter: string,
  statusFilter: string,
  typeFilter: string,
): boolean {
  if (statusFilter && m.status !== statusFilter) return false;
  if (typeFilter && m.type !== typeFilter) return false;
  if (projectFilter === '__global__') return m.scope === 'global';
  if (projectFilter) {
    const p = projectByPath.get(projectFilter);
    return m.scope === 'project' && m.projectId === p?.id;
  }
  return true;
}

function urlWithPage(currentUrl: string, page: number): string {
  const u = new URL(currentUrl);
  u.searchParams.set('page', String(page));
  return u.pathname + u.search;
}
