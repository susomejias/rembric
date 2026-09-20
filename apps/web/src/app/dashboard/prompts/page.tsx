import { sanitizeFtsQuery } from '@rembric/core';
import type { Prompt } from '@rembric/db';
import Link from 'next/link';

import {
  matchesFilters,
  promptsQuery,
  readPromptsFilters,
  resolveProjectFilter,
  type SearchParams,
} from './filters';

import { TableEmptyState, TableNoResults } from '@/components/dashboard/empty-states';
import {
  FilterBar,
  FilterField,
  FilterSearch,
  FilterSelect,
} from '@/components/dashboard/filter-bar';
import { PAGE_SIZE, queryWithPage, shortId, truncate } from '@/components/dashboard/format';
import { Markdown } from '@/components/dashboard/markdown';
import { Pager } from '@/components/dashboard/pager';
import { Timestamp } from '@/components/dashboard/timestamp';
import { ViewHead } from '@/components/dashboard/view-head';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getServices } from '@/lib/services';

/**
 * The prompt library — a server component reading `@rembric/db` directly, with
 * the same sanitized `prompts_fts` search, filters and URL-driven pagination the
 * Hono handler used (`apps/server/src/dashboard/prompts.ts`).
 *
 * Long content expands inline through the browser's own `<details>` element —
 * the replacement for the retired HTMX toggle, with no detail route and no
 * client JavaScript. `Delete`/`Undelete` are NOT ported in this slice: both are
 * mutations and the change's mutation-protection probe has not run.
 */
export const dynamic = 'force-dynamic';

/**
 * The row's derived lifecycle label. It is not `StatusBadge`: `active` means
 * "visible" here and must NOT take the lime tone the same key carries for a
 * memory or a session. Tones mirror the retired pills — `REFINED` lime,
 * `DELETED` dim, `ACTIVE` untoned.
 */
const PROMPT_STATUS_TONE: Record<'active' | 'deleted' | 'refined', string> = {
  active: 'text-muted-foreground',
  deleted: 'text-muted-foreground',
  refined: 'border-primary/50 text-brand-accent',
};

export default async function PromptsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readPromptsFilters(params);
  const roundTripQuery = promptsQuery(params);
  const filterKey = queryWithPage(roundTripQuery, 0);

  // `include_deleted` widens the list rather than narrowing it, so it is not
  // part of "is this list filtered" — an empty result with it on is still an
  // empty corpus.
  const isFiltered =
    filters.project !== '' || filters.session !== '' || filters.agent !== '' || filters.q !== '';

  const { repos } = getServices();

  const offset = filters.page * PAGE_SIZE;
  const projectRows = repos.projects.adminListAll();
  const projectById = new Map(projectRows.map((p) => [p.id, p]));
  const resolvedProject = resolveProjectFilter(filters.project, projectRows);

  // Sanitized before it reaches `prompts_fts MATCH` — ordinary punctuation (an
  // apostrophe, a stray quote, "docker-compose") otherwise raises an FTS5 syntax
  // error and 500s the page. `filters.q` is still what the search box redisplays.
  const ftsQuery = sanitizeFtsQuery(filters.q);

  let rows: Prompt[];
  if (resolvedProject.unknown) {
    rows = [];
  } else if (ftsQuery) {
    rows = repos.prompts.adminSearchFts(ftsQuery, PAGE_SIZE + 1, offset).filter((p) =>
      matchesFilters(p, {
        includeDeleted: filters.includeDeleted,
        projectId: resolvedProject.projectId,
        agent: filters.agent,
        session: filters.session,
      }),
    );
  } else {
    rows = repos.prompts.adminList({
      includeDeleted: filters.includeDeleted,
      projectId: resolvedProject.projectId,
      agent: filters.agent || undefined,
      // The operator pastes a shortId; match by prefix against the session id.
      sessionIdPrefix: filters.session || undefined,
      limit: PAGE_SIZE + 1,
      offset,
    });
  }

  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);

  // A text query has no cheap exact count (its extra filters run in memory after
  // pagination), so the total is left undefined and the header shows a lower
  // bound rather than a wrong exact figure.
  const totalCount: number | undefined = resolvedProject.unknown
    ? 0
    : ftsQuery
      ? undefined
      : repos.prompts.adminCount({
          includeDeleted: filters.includeDeleted,
          projectId: resolvedProject.projectId,
          agent: filters.agent || undefined,
          sessionIdPrefix: filters.session || undefined,
        });
  const total = totalCount === undefined ? `${visible.length}+` : String(totalCount);

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        num="03b"
        title="Rembric Prompts."
        meta={[
          { k: 'TOTAL', v: total },
          { k: 'SHOWING', v: `${visible.length} ROWS` },
        ]}
      />

      <p className="text-xs text-muted-foreground">
        {filters.includeDeleted ? (
          <>
            Showing soft-deleted rows. <Link href="/dashboard/prompts">Hide</Link>.
          </>
        ) : (
          <Link href="/dashboard/prompts?include_deleted=1">Show deleted</Link>
        )}
      </p>

      <FilterBar key={filterKey} action="/dashboard/prompts">
        <FilterField label="SCOPE" htmlFor="f-project" className="w-44">
          <FilterSelect
            id="f-project"
            name="project"
            value={filters.project}
            options={[
              { value: '', label: 'all scopes' },
              ...projectRows.map((p) => ({ value: p.slug, label: p.slug })),
            ]}
          />
        </FilterField>
        <FilterField label="SESSION" htmlFor="f-session" className="w-40">
          <FilterSearch
            id="f-session"
            name="session"
            value={filters.session}
            placeholder="shortId prefix"
          />
        </FilterField>
        <FilterField label="AGENT" htmlFor="f-agent" className="w-40">
          <FilterSearch
            id="f-agent"
            name="agent"
            value={filters.agent}
            placeholder="e.g. claude-code"
          />
        </FilterField>
        <FilterField label="SEARCH" htmlFor="f-q" className="min-w-56 flex-1">
          <FilterSearch
            id="f-q"
            name="q"
            value={filters.q}
            placeholder="FTS5 over content + tags"
          />
        </FilterField>
        {filters.includeDeleted ? <input type="hidden" name="include_deleted" value="1" /> : null}
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm">
            FILTER
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link
              href={
                filters.includeDeleted
                  ? '/dashboard/prompts?include_deleted=1'
                  : '/dashboard/prompts'
              }
            >
              CLEAR
            </Link>
          </Button>
        </div>
      </FilterBar>

      <div className="flex flex-col gap-3">
        {visible.length === 0 ? (
          isFiltered ? (
            <TableNoResults
              what="prompts"
              clearHref={
                filters.includeDeleted
                  ? '/dashboard/prompts?include_deleted=1'
                  : '/dashboard/prompts'
              }
            />
          ) : (
            <TableEmptyState
              title="No prompts yet"
              description={
                <>
                  Prompts are captured by the client plugins as they work, through{' '}
                  <code className="font-mono">memory.save_prompt</code>. Nothing has been captured
                  in this scope yet.
                </>
              }
            />
          )
        ) : (
          <Table className="font-sans">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-56">title</TableHead>
                <TableHead className="w-32">project</TableHead>
                <TableHead className="w-28">session</TableHead>
                <TableHead className="w-32">agent</TableHead>
                <TableHead className="w-40">tags</TableHead>
                <TableHead className="w-28">status</TableHead>
                <TableHead className="w-52">created</TableHead>
                <TableHead>content</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((p) => {
                const deleted = p.deletedAt != null;
                const refined = deleted && Array.isArray(p.replaces) && p.replaces.length > 0;
                const status = deleted ? (refined ? 'refined' : 'deleted') : 'active';
                const title = promptTitle(p);
                return (
                  <TableRow key={p.id}>
                    <TableCell className="max-w-[16rem]" title={title}>
                      <span className="font-medium">{title}</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {p.projectId
                        ? (projectById.get(p.projectId)?.slug ?? shortId(p.projectId))
                        : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {p.sessionId ? (
                        <Link
                          href={`/dashboard/sessions/${p.sessionId}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {shortId(p.sessionId)}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {p.agent ?? '—'}
                    </TableCell>
                    <TableCell>
                      {Array.isArray(p.tags) && p.tags.length > 0 ? (
                        <span className="flex flex-wrap gap-1">
                          {p.tags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="font-mono">
                              {tag}
                            </Badge>
                          ))}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`font-mono uppercase ${PROMPT_STATUS_TONE[status]}`}
                      >
                        {status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      <Timestamp value={p.createdAt} />
                    </TableCell>
                    <TableCell className="max-w-md text-xs whitespace-normal">
                      <details>
                        <summary className="cursor-pointer text-muted-foreground">
                          {truncate(p.content, 120)}
                        </summary>
                        <div className="pt-2">
                          <Markdown content={p.content} />
                        </div>
                      </details>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <Pager
          page={filters.page}
          hasMore={hasMore}
          total={totalCount}
          totalLabel={`${visible.length} ROWS`}
          path="/dashboard/prompts"
          query={roundTripQuery}
        />
      </div>
    </div>
  );
}

/** The prompt title cascade: `title` → truncated content → shortId. */
function promptTitle(p: Prompt): string {
  if (p.title && p.title.length > 0) return p.title;
  const truncated = truncate(p.content, 80);
  return truncated.length > 0 ? truncated : shortId(p.id);
}
