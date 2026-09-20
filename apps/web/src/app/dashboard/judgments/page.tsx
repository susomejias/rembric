import { RELATION_STATUSES } from '@rembric/db';
import Link from 'next/link';

import {
  judgmentsQuery,
  readJudgmentsFilters,
  relationFilters,
  RELATION_KIND_FILTERS,
  type SearchParams,
} from './filters';

import { StatusBadge, VerdictBadge } from '@/components/dashboard/badges';
import { TableEmptyState, TableNoResults } from '@/components/dashboard/empty-states';
import { FilterBar, FilterField, FilterSelect } from '@/components/dashboard/filter-bar';
import { PAGE_SIZE, queryWithPage, truncate } from '@/components/dashboard/format';
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
 * The judgment queue — a server component reading `@rembric/db` directly, with
 * the same status/kind filters, ordering (`created_at DESC` in SQL) and
 * URL-driven pagination the Hono handler used
 * (`apps/server/src/dashboard/judgments.ts`).
 *
 * `Mark orphaned` is NOT ported in this slice: it is a mutation and the change's
 * mutation-protection probe has not run, so this view renders the queue and its
 * state and no dead control.
 *
 * The `source → target` cells render each memory's **title** — the label the
 * current handler shows (`adminListWithContent.sourceTitle`/`targetTitle`); the
 * published spec's sentence still names `content`, which the handler stopped
 * using when titles became required. This is the port of the behaviour, not of
 * the stale sentence.
 */
export const dynamic = 'force-dynamic';

const STATUS_OPTIONS = [
  { value: '', label: 'all statuses' },
  ...RELATION_STATUSES.map((s) => ({ value: s, label: s })),
];

const KIND_OPTIONS = [
  { value: '', label: 'all kinds' },
  ...RELATION_KIND_FILTERS.map((k) => ({ value: k, label: k })),
];

export default async function JudgmentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readJudgmentsFilters(params);
  const roundTripQuery = judgmentsQuery(params);
  const filterKey = queryWithPage(roundTripQuery, 0);

  // Both filters are optional, so an empty filter set means "the whole queue is
  // empty", not "nothing matched".
  const isFiltered = filters.status !== '' || filters.kind !== '';

  const { repos } = getServices();

  const address = relationFilters(filters);
  const offset = filters.page * PAGE_SIZE;
  const rows = repos.relations.adminListWithContent(address, PAGE_SIZE + 1, offset);
  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);
  const total = repos.relations.adminCountWithFilters(address);

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        title="Rembric Judgments."
        meta={[
          { k: 'TOTAL', v: String(total) },
          { k: 'SHOWING', v: `${visible.length} ROWS` },
        ]}
      />

      {/* Remounted whenever the filter set changes, so the uncontrolled
          controls re-seed from the URL on a soft navigation (e.g. CLEAR). */}
      <FilterBar key={filterKey} action="/dashboard/judgments">
        <FilterField label="STATUS" htmlFor="f-status" className="w-36">
          <FilterSelect
            id="f-status"
            name="status"
            value={filters.status}
            options={STATUS_OPTIONS}
          />
        </FilterField>
        <FilterField label="KIND" htmlFor="f-kind" className="w-40">
          <FilterSelect id="f-kind" name="kind" value={filters.kind} options={KIND_OPTIONS} />
        </FilterField>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm">
            FILTER
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/judgments">CLEAR</Link>
          </Button>
        </div>
      </FilterBar>

      <div className="flex flex-col gap-3">
        {visible.length === 0 ? (
          isFiltered ? (
            <TableNoResults what="judgments" clearHref="/dashboard/judgments" />
          ) : (
            <TableEmptyState
              title="No judgments yet"
              description={
                <>
                  A judgment appears when <code className="font-mono">memory.save</code> returns
                  conflict candidates; close them with{' '}
                  <code className="font-mono">memory.judge</code>.
                </>
              }
            />
          )
        ) : (
          <Table className="font-sans">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-28">status</TableHead>
                <TableHead className="w-44">verdict</TableHead>
                <TableHead>source → target</TableHead>
                <TableHead className="w-40">actor</TableHead>
                <TableHead className="w-56">created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell>
                    <VerdictBadge kind={r.relation} />
                  </TableCell>
                  <TableCell className="text-xs">
                    <Link
                      href={`/dashboard/memories/${r.sourceId}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {truncate(r.sourceTitle, 60)}
                    </Link>
                    <span className="mx-1 text-muted-foreground">→</span>
                    <Link
                      href={`/dashboard/memories/${r.targetId}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {truncate(r.targetTitle, 60)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.markedByActor ?? '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    <Link
                      href={`/dashboard/judgments/${r.id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      <Timestamp value={r.createdAt} />
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Pager
          page={filters.page}
          hasMore={hasMore}
          total={total}
          totalLabel={`${visible.length} ROWS`}
          path="/dashboard/judgments"
          query={roundTripQuery}
        />
      </div>
    </div>
  );
}
