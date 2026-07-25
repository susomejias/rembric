import { Hono } from 'hono';

import type { Repositories } from '../db/repositories/index.js';
import { ENTITY_KINDS, type EntityKind } from '../db/schema/entities.js';
import type { EntityBackfillWorker } from '../services/entity-backfill-worker.js';
import type { SessionsService } from '../services/sessions.js';
import type { TokensService } from '../services/tokens.js';

import {
  filterGroup,
  filtersBar,
  getSession,
  PAGE_SIZE,
  pager,
  sel,
  statCard,
  tblEmpty,
  urlWithPage,
  viewHead,
} from './components.js';
import { csrfInput, readFormAndVerifyCsrf } from './csrf.js';
import { requireAdmin } from './maintenance.js';
import { renderPage } from './page-shell.js';
import { html, raw, shortId } from './templates.js';

export interface EntitiesDeps {
  repos: Repositories;
  sessions: SessionsService;
  tokens: TokensService;
  /** The live, boot-time singleton — see `DashboardDeps`'s doc comment for why. */
  entityBackfillWorker: EntityBackfillWorker;
}

/**
 * Bounds a manual "rebuild" click to a single request/response cycle
 * instead of an unbounded loop. A corpus larger than this drains the rest
 * on the next periodic backfill tick — genuinely soon, not just "eventually
 * within the hour", because the rebuild reuses the SAME live worker
 * instance (not a throwaway one), so its `possiblyPending` flag correctly
 * reflects any backlog left over from hitting this cap.
 */
const REBUILD_MAX_BATCHES = 200;

export function createEntitiesRouter(deps: EntitiesDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const url = new URL(c.req.url);
    const kindFilter = (url.searchParams.get('kind') ?? '') as EntityKind | '';
    const singleReferenceOnly = url.searchParams.get('single_ref') === '1';
    const page = Math.max(0, parseInt(url.searchParams.get('page') ?? '0', 10) || 0);
    const offset = page * PAGE_SIZE;
    const rebuilt = url.searchParams.get('rebuilt');

    const filters = {
      kind: kindFilter || undefined,
      singleReferenceOnly,
    };
    const rows = deps.repos.entities.adminListEntities(filters, PAGE_SIZE, offset);
    const total = deps.repos.entities.adminCountEntities(filters);
    const byKind = deps.repos.entities.adminCountsByKind();
    const backlog = deps.repos.entities.adminBacklogCount();
    const projectById = new Map(deps.repos.projects.adminListAll().map((p) => [p.id, p]));

    const flashBanner = rebuilt
      ? html`<p class="flash success">
          Entity index rebuilt (${rebuilt} memor${rebuilt === '1' ? 'y' : 'ies'} re-scanned).
        </p>`
      : raw('');

    const kindOptions = [
      { value: '', label: 'ALL KINDS', selected: kindFilter === '' },
      ...ENTITY_KINDS.map((k) => ({
        value: k,
        label: k.toUpperCase(),
        selected: kindFilter === k,
      })),
    ];

    const filterBar = filtersBar([
      filterGroup('KIND', 'f-kind', sel('kind', kindOptions, { id: 'f-kind' })),
      html`<span class="group">
        <label class="k" for="f-single-ref">SINGLE-REFERENCE ONLY</label>
        <input
          type="checkbox"
          id="f-single-ref"
          name="single_ref"
          value="1"
          ${singleReferenceOnly ? raw('checked') : raw('')}
        />
      </span>`,
      html`<span class="acts">
        <button class="btn primary" type="submit">FILTER</button>
        <a class="clear" href="/dashboard/entities">CLEAR</a>
      </span>`,
    ]);

    const renderRow = (r: (typeof rows)[number]) => {
      const projectLabel = r.projectId
        ? (projectById.get(r.projectId)?.slug ?? shortId(r.projectId))
        : 'global';
      return html`
        <tr>
          <td><span class="pill">${r.kind}</span></td>
          <td class="mono">${r.value}</td>
          <td>${projectLabel}</td>
          <td>${r.linkCount}</td>
          <td>
            <a href="/dashboard/memories?q=${encodeURIComponent(r.value)}">VIEW MEMORIES →</a>
          </td>
        </tr>
      `;
    };

    const body = html`
      ${viewHead({
        num: '05b',
        title: 'Rembric Entities.',
        hl: 'Rembric',
        meta: [
          { k: 'TOTAL ENTITIES', v: String(total) },
          { k: 'BACKFILL BACKLOG', v: String(backlog) },
        ],
      })}
      ${flashBanner}
      <div class="grid-6" style="margin-bottom:var(--s-6)">
        ${ENTITY_KINDS.map((k) => {
          const count = byKind.find((b) => b.kind === k)?.count ?? 0;
          return statCard({
            k: k.toUpperCase(),
            v: count,
            tone: 'fg',
            href: `/dashboard/entities?kind=${k}`,
          });
        })}
      </div>
      <form
        action="/dashboard/entities/rebuild"
        method="post"
        data-confirm="Truncate and re-scan the entity index from every non-archived memory? Useful both to backfill a pending scan and to apply a tightened extraction rule retroactively. This does not touch any memory row — only derived entity/link data."
        data-confirm-label="REBUILD ENTITY INDEX"
        data-confirm-tone="warn"
        style="margin-bottom:var(--s-4)"
      >
        ${csrfInput(session.session, deps.sessions, 'entities.rebuild')}
        <button class="btn warn" type="submit">
          REBUILD ENTITY INDEX${backlog > 0 ? html` (${backlog} PENDING)` : raw('')}
        </button>
      </form>
      ${filterBar}
      ${rows.length === 0
        ? tblEmpty('No entities match this filter.')
        : html`
            <div class="tbl-host">
              <table>
                <thead>
                  <tr>
                    <th>kind</th>
                    <th>value</th>
                    <th>scope</th>
                    <th>links</th>
                    <th>actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows.map(renderRow)}
                </tbody>
              </table>
            </div>
          `}
      ${pager({
        page,
        hasMore: offset + rows.length < total,
        pageHrefBuilder: (p) => urlWithPage(c.req.url, p),
        totalLabel: `${rows.length} ROWS`,
        total,
      })}
    `;

    return c.html(
      renderPage(c, deps.sessions, body, {
        title: 'Entities',
        activeNav: 'entities',
        view: 'entities',
      }),
    );
  });

  app.post('/rebuild', async (c) => {
    const guard = requireAdmin(c, deps, { title: 'Entities', activeNav: 'entities' });
    if (guard.forbidden) return guard.forbidden;
    const form = await readFormAndVerifyCsrf(
      c,
      guard.session.session,
      deps.sessions,
      'entities.rebuild',
    );
    if (form instanceof Response) return form;

    deps.repos.entities.truncateAll();
    let processed = 0;
    for (let i = 0; i < REBUILD_MAX_BATCHES; i++) {
      const result = deps.entityBackfillWorker.processBatch({ force: true });
      processed += result.processed;
      if (result.processed === 0) break;
    }

    return c.redirect(`/dashboard/entities?rebuilt=${processed}`);
  });

  return app;
}
