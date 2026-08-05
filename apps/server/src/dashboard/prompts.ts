import { Hono } from 'hono';

import type { Repositories } from '../db/repositories/index.js';
import type { Prompt } from '../db/schema/prompts.js';
import { DomainError } from '../services/errors.js';
import { sanitizeFtsQuery } from '../services/hybrid-search.js';
import type { PromptsService } from '../services/prompts.js';
import type { SessionsService } from '../services/sessions.js';

import {
  domainErrorPage,
  filterGroup,
  filtersBar,
  getSession,
  inp,
  mdBody,
  PAGE_SIZE,
  pageParam,
  pager,
  resolveProjectFilter,
  projectOptions,
  sel,
  tblEmpty,
  truncate,
  urlWithPage,
  viewHead,
} from './components.js';
import { csrfInput, readFormAndVerifyCsrf } from './csrf.js';
import { renderPage } from './page-shell.js';
import { formatTs, html, raw, shortId } from './templates.js';

export interface PromptsDeps {
  repos: Repositories;
  prompts: PromptsService;
  sessions: SessionsService;
}

export function createPromptsRouter(deps: PromptsDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const url = new URL(c.req.url);
    const justDeleted = url.searchParams.get('deleted');
    const justUndeleted = url.searchParams.get('undeleted');
    const includeDeleted = url.searchParams.get('include_deleted') === '1';
    const agentFilter = url.searchParams.get('agent') ?? '';
    const sessionFilter = url.searchParams.get('session') ?? '';
    const rawQuery = url.searchParams.get('q') ?? '';
    // Sanitized before it reaches `prompts_fts MATCH` — ordinary punctuation
    // (an apostrophe, a stray quote, "docker-compose") otherwise raises an
    // FTS5 syntax error and 500s the page. The unsanitized `rawQuery` is
    // still what's redisplayed in the search box.
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
    let rows: Prompt[];
    if (unknownProject) {
      rows = [];
    } else if (query) {
      rows = deps.repos.prompts
        .adminSearchFts(query, PAGE_SIZE + 1, offset)
        .filter((p) => matchesFilters(p, includeDeleted, projectId, agentFilter, sessionFilter));
    } else {
      rows = deps.repos.prompts.adminList({
        includeDeleted,
        projectId,
        agent: agentFilter || undefined,
        // Operator pastes shortId; match by prefix against the session id.
        sessionIdPrefix: sessionFilter || undefined,
        limit: PAGE_SIZE + 1,
        offset,
      });
    }

    const hasMore = rows.length > PAGE_SIZE;
    const visible = rows.slice(0, PAGE_SIZE);

    // A text query has no cheap exact count (FTS filters post-pagination) —
    // leave `totalCount` undefined so the pager shows a lower bound.
    const totalCount: number | undefined = unknownProject
      ? 0
      : query
        ? undefined
        : deps.repos.prompts.adminCount({
            includeDeleted,
            projectId,
            agent: agentFilter || undefined,
            sessionIdPrefix: sessionFilter || undefined,
          });
    const total = totalCount === undefined ? `${visible.length}+` : String(totalCount);

    const flash = justDeleted
      ? html`<p class="flash success">
          Prompt <code>${justDeleted}</code> soft-deleted.
          <a href="/dashboard/prompts?include_deleted=1">View deleted</a>
          to undelete.
        </p>`
      : justUndeleted
        ? html`<p class="flash success">Prompt <code>${justUndeleted}</code> restored.</p>`
        : raw('');

    const renderRow = (p: Prompt) => {
      const projectLabel = p.projectId
        ? (projectById.get(p.projectId)?.slug ?? shortId(p.projectId))
        : '—';
      const isDeleted = p.deletedAt != null;
      const isRefined = isDeleted && Array.isArray(p.replaces) && p.replaces.length > 0;
      const statusPill = isDeleted
        ? isRefined
          ? raw('<span class="pill k-refined">REFINED</span>')
          : raw('<span class="pill k-deleted">DELETED</span>')
        : raw('<span class="pill k-active">ACTIVE</span>');
      const titleCell = p.title
        ? html`<span class="rbr-prompt-title" title="${p.title}">${p.title}</span>`
        : html`<span class="rbr-prompt-title muted">—</span>`;
      const tagsCell =
        Array.isArray(p.tags) && p.tags.length > 0
          ? html`<span class="rbr-prompt-tags"
              >${p.tags.map((t) => html`<span class="tag">${t}</span>`)}</span
            >`
          : raw('—');
      const contentCell = html`
        <details class="rbr-prompt-content">
          <summary>${truncate(p.content, 120)}</summary>
          ${mdBody(p.content)}
        </details>
      `;
      const sessionCell = p.sessionId
        ? html`<a href="/dashboard/sessions/${p.sessionId}" class="mono"
            >${shortId(p.sessionId)}</a
          >`
        : raw('—');
      const actionForm = isDeleted
        ? html`
            <form action="/dashboard/prompts/${p.id}/undelete" method="post" class="inline">
              ${csrfInput(session.session, deps.sessions, 'prompt.undelete')}
              <button type="submit">Undelete</button>
            </form>
          `
        : html`
            <form
              action="/dashboard/prompts/${p.id}/delete"
              method="post"
              class="inline"
              data-confirm="Soft-delete this prompt? It is hidden from default lists, memory.context.recentPrompts, and memory.search_prompts; restorable via the Undelete action."
              data-confirm-label="DELETE PROMPT"
              data-confirm-tone="warn"
            >
              ${csrfInput(session.session, deps.sessions, 'prompt.delete')}
              <button class="warn" type="submit">Delete</button>
            </form>
          `;
      return html`
        <tr>
          <td>${titleCell}</td>
          <td>${projectLabel}</td>
          <td>${sessionCell}</td>
          <td>${p.agent ?? '—'}</td>
          <td>${tagsCell}</td>
          <td>${statusPill}</td>
          <td class="muted">${formatTs(p.createdAt)}</td>
          <td>${contentCell}</td>
          <td class="actions">
            <div class="actions-stack">${actionForm}</div>
          </td>
        </tr>
      `;
    };

    const filterBar = filtersBar([
      filterGroup(
        'SCOPE',
        'f-project',
        sel('project', projectOptions(projectRows, projectFilter), { id: 'f-project' }),
      ),
      filterGroup(
        'SESSION',
        'f-session',
        inp('session', sessionFilter, 'shortId prefix', { id: 'f-session' }),
      ),
      filterGroup(
        'AGENT',
        'f-agent',
        inp('agent', agentFilter, 'e.g. claude-code', { id: 'f-agent' }),
      ),
      filterGroup(
        'SEARCH',
        'f-q',
        inp('q', rawQuery, 'FTS5 over content + tags', { type: 'search', id: 'f-q' }),
        { className: 'search' },
      ),
      includeDeleted ? raw('<input type="hidden" name="include_deleted" value="1" />') : raw(''),
      html`<span class="acts">
        <button class="btn primary" type="submit">FILTER</button>
        <a class="clear" href="/dashboard/prompts${includeDeleted ? '?include_deleted=1' : ''}"
          >CLEAR</a
        >
      </span>`,
    ]);

    const body = html`
      ${viewHead({
        num: '03b',
        title: 'Rembric Prompts.',
        hl: 'Rembric',
        meta: [
          { k: 'TOTAL', v: total },
          { k: 'SHOWING', v: `${visible.length} ROWS` },
        ],
      })}
      ${flash}
      ${includeDeleted
        ? raw(
            '<p class="small muted">Showing soft-deleted rows. <a href="/dashboard/prompts">Hide</a>.</p>',
          )
        : raw(
            '<p class="small muted"><a href="/dashboard/prompts?include_deleted=1">Show deleted</a></p>',
          )}
      ${filterBar}
      ${visible.length === 0
        ? tblEmpty('No prompts match this filter.')
        : html`
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>title</th>
                    <th>project</th>
                    <th>session</th>
                    <th>agent</th>
                    <th>tags</th>
                    <th>status</th>
                    <th>created</th>
                    <th>content</th>
                    <th>actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${visible.map(renderRow)}
                </tbody>
              </table>
            </div>
          `}
      ${visible.length > 0 || page > 0
        ? pager({
            page,
            hasMore,
            pageHrefBuilder: (p) => urlWithPage(c.req.url, p),
            totalLabel: `${visible.length} ROWS`,
            total: totalCount,
          })
        : raw('')}
    `;

    return c.html(
      renderPage(c, deps.sessions, body, {
        title: 'Prompts',
        activeNav: 'prompts',
        view: 'prompts',
      }),
    );
  });

  app.post('/:id/delete', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'prompt.delete');
    if (form instanceof Response) return form;
    const id = c.req.param('id');
    try {
      deps.prompts.softDelete(id, { adminBypass: true });
    } catch (err) {
      if (err instanceof DomainError) {
        return domainErrorPage(
          c,
          deps.sessions,
          err,
          { title: 'Prompts', activeNav: 'prompts' },
          (code) => (code === 'prompt_not_found' ? 404 : 400),
        );
      }
      throw err;
    }
    return c.redirect(`/dashboard/prompts?deleted=${encodeURIComponent(id)}`);
  });

  app.post('/:id/undelete', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'prompt.undelete');
    if (form instanceof Response) return form;
    const id = c.req.param('id');
    try {
      deps.prompts.undelete(id, { adminBypass: true });
    } catch (err) {
      if (err instanceof DomainError) {
        return domainErrorPage(
          c,
          deps.sessions,
          err,
          { title: 'Prompts', activeNav: 'prompts' },
          (code) => (code === 'prompt_not_found' ? 404 : 400),
        );
      }
      throw err;
    }
    return c.redirect(`/dashboard/prompts?undeleted=${encodeURIComponent(id)}`);
  });

  return app;
}

function matchesFilters(
  p: Prompt,
  includeDeleted: boolean,
  projectId: string | undefined,
  agentFilter: string,
  sessionFilter: string,
): boolean {
  if (!includeDeleted && p.deletedAt != null) return false;
  if (projectId !== undefined && p.projectId !== projectId) return false;
  if (agentFilter && p.agent !== agentFilter) return false;
  if (sessionFilter && (!p.sessionId || !p.sessionId.startsWith(sessionFilter))) return false;
  return true;
}
