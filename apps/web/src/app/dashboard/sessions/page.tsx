import { AGENT_SESSION_STATUSES } from '@rembric/db';
import Link from 'next/link';

import {
  parseSessionStatus,
  readSessionsFilters,
  resolveProjectFilter,
  sessionsQuery,
  type SearchParams,
} from './filters';

import { StatusBadge } from '@/components/dashboard/badges';
import { TableEmptyState, TableNoResults } from '@/components/dashboard/empty-states';
import {
  FilterBar,
  FilterField,
  FilterSearch,
  FilterSelect,
} from '@/components/dashboard/filter-bar';
import { PAGE_SIZE, queryWithPage, shortId, truncate } from '@/components/dashboard/format';
import { Pager } from '@/components/dashboard/pager';
import { Timestamp } from '@/components/dashboard/timestamp';
import { ViewHead } from '@/components/dashboard/view-head';
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
 * The sessions list — a server component reading `@rembric/core`/`@rembric/db`
 * directly, the same read path and URL-driven filter/pagination model as the
 * memories list it follows.
 *
 * The retired view's row actions (Abandon, Delete) are NOT ported in this slice:
 * both are mutations and the change's mutation-protection probe (design D4, task
 * 2.5) has not run, so their form boundary is a decision this view must not
 * pre-empt. The rows carry their lifecycle state and nothing else.
 */
export const dynamic = 'force-dynamic';

const STATUS_OPTIONS = [
  { value: '', label: 'all statuses' },
  ...AGENT_SESSION_STATUSES.map((s) => ({ value: s, label: s })),
];

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readSessionsFilters(params);
  const roundTripQuery = sessionsQuery(params);
  const filterKey = queryWithPage(roundTripQuery, 0);

  const { repos } = getServices();

  const offset = filters.page * PAGE_SIZE;
  const status = parseSessionStatus(filters.status);
  const projectRows = repos.projects.adminListAll();
  const resolvedProject = resolveProjectFilter(filters.project, projectRows);

  // Same distinction the memories list draws: "this scope has no sessions" is a
  // different answer from "this filter set matches none".
  const isFiltered = filters.project !== '' || filters.agent !== '' || filters.status !== '';

  const address = {
    deleted: false,
    projectId: resolvedProject.projectId,
    agent: filters.agent || undefined,
    status,
  };
  const visibleRowsRaw = resolvedProject.unknown
    ? []
    : repos.agentSessions.adminList({
        ...address,
        activeFirst: true,
        limit: PAGE_SIZE + 1,
        offset,
      });
  const visibleHasMore = visibleRowsRaw.length > PAGE_SIZE;
  const visibleRows = visibleRowsRaw.slice(0, PAGE_SIZE);

  // Filters apply to the non-deleted table only, exactly as the retired view
  // read them; the soft-deleted table is a second, unfiltered page-sized slice.
  const deletedRowsRaw = filters.includeDeleted
    ? repos.agentSessions.adminList({
        deleted: true,
        activeFirst: false,
        limit: PAGE_SIZE + 1,
        offset,
      })
    : [];
  const deletedHasMore = deletedRowsRaw.length > PAGE_SIZE;
  const deletedRows = deletedRowsRaw.slice(0, PAGE_SIZE);

  const memoryCounts = repos.memory.adminCountBySession(
    [...visibleRows, ...deletedRows].map((r) => r.id),
  );
  const promptCounts = repos.prompts.adminCountBySession(
    [...visibleRows, ...deletedRows].map((r) => r.id),
  );

  const total = resolvedProject.unknown ? 0 : repos.agentSessions.adminCount(address);

  const renderRows = (rows: typeof visibleRows) =>
    rows.map((r) => {
      const displayTitle = titleCascade(r.title, r.description, r.id);
      return (
        <TableRow key={r.id}>
          <TableCell className="max-w-[22rem]">
            <Link
              href={`/dashboard/sessions/${r.id}`}
              title={displayTitle}
              className="font-medium underline-offset-4 hover:underline"
            >
              {truncate(displayTitle, 40)}
            </Link>
          </TableCell>
          <TableCell className="text-xs">{r.agent}</TableCell>
          <TableCell className="font-mono text-xs text-muted-foreground">
            {r.projectSlug ?? '—'}
          </TableCell>
          <TableCell className="text-xs text-muted-foreground">
            {r.tokenName ?? '—'}
            {r.tokenRevokedAt ? <span className="ml-1 text-xs">(revoked)</span> : null}
          </TableCell>
          <TableCell className="font-mono text-xs text-muted-foreground">
            <Timestamp value={r.startedAt} />
          </TableCell>
          <TableCell className="font-mono text-xs text-muted-foreground">
            <Timestamp value={r.endedAt} />
          </TableCell>
          <TableCell>
            <StatusBadge status={r.status} />
          </TableCell>
          <TableCell className="text-right font-mono text-xs">{memoryCounts[r.id] ?? 0}</TableCell>
          <TableCell className="text-right font-mono text-xs">{promptCounts[r.id] ?? 0}</TableCell>
        </TableRow>
      );
    });

  const header = (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead>title</TableHead>
        <TableHead className="w-28">agent</TableHead>
        <TableHead className="w-32">project</TableHead>
        <TableHead className="w-32">token</TableHead>
        <TableHead className="w-44">started</TableHead>
        <TableHead className="w-44">ended</TableHead>
        <TableHead className="w-28">status</TableHead>
        <TableHead className="w-24 text-right">memories</TableHead>
        <TableHead className="w-24 text-right">prompts</TableHead>
      </TableRow>
    </TableHeader>
  );

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        title="Rembric Sessions."
        meta={[
          { k: 'TOTAL', v: String(total) },
          { k: 'SHOWING', v: `${visibleRows.length} ROWS` },
        ]}
      />

      <p className="text-xs text-muted-foreground">
        {filters.includeDeleted ? (
          <>
            Showing soft-deleted rows. <Link href="/dashboard/sessions">Hide</Link>.
          </>
        ) : (
          <Link href="/dashboard/sessions?include_deleted=1">Show deleted</Link>
        )}
      </p>

      <FilterBar key={filterKey} action="/dashboard/sessions">
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
        <FilterField label="AGENT" htmlFor="f-agent" className="w-44">
          <FilterSearch
            id="f-agent"
            name="agent"
            value={filters.agent}
            placeholder="e.g. claude-code"
          />
        </FilterField>
        <FilterField label="STATUS" htmlFor="f-status" className="w-36">
          <FilterSelect
            id="f-status"
            name="status"
            value={filters.status}
            options={STATUS_OPTIONS}
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
                  ? '/dashboard/sessions?include_deleted=1'
                  : '/dashboard/sessions'
              }
            >
              CLEAR
            </Link>
          </Button>
        </div>
      </FilterBar>

      <div className="flex flex-col gap-3">
        {visibleRows.length === 0 ? (
          isFiltered ? (
            <TableNoResults
              what="agent sessions"
              clearHref={
                filters.includeDeleted
                  ? '/dashboard/sessions?include_deleted=1'
                  : '/dashboard/sessions'
              }
            />
          ) : (
            <TableEmptyState
              title="No sessions yet"
              description={
                <>
                  A session row is opened by the client plugin's{' '}
                  <code className="font-mono">POST /api/&lt;slug&gt;/sessions</code> on start, not
                  by anything in this dashboard. Point a client at this server and its sessions
                  appear here.
                </>
              }
            />
          )
        ) : (
          <Table className="font-sans">
            {header}
            <TableBody>{renderRows(visibleRows)}</TableBody>
          </Table>
        )}

        {filters.includeDeleted && deletedRows.length > 0 ? (
          <>
            <h2 className="mt-2 font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
              Deleted ({deletedRows.length})
            </h2>
            <Table className="font-sans">
              {header}
              <TableBody>{renderRows(deletedRows)}</TableBody>
            </Table>
          </>
        ) : null}

        <Pager
          page={filters.page}
          hasMore={visibleHasMore || (filters.includeDeleted && deletedHasMore)}
          total={total}
          totalLabel={`${visibleRows.length} ROWS`}
          path="/dashboard/sessions"
          query={roundTripQuery}
        />
      </div>
    </div>
  );
}

/**
 * Derive a human-readable label for a session row: explicit title →
 * description (seed goal) → shortId. Placeholder titles count as real titles —
 * they are still more informative than the bare shortId.
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
