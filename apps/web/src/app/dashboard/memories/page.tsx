import {
  deriveReviewState,
  REFUTED_PRIORITY_MS,
  REVIEW_TTL_MS,
  sanitizeFtsQuery,
  type ReviewState,
} from '@rembric/core';
import { MEMORY_TYPES, type Memory, type MemoryStatus, type MemoryType } from '@rembric/db';
import Link from 'next/link';
import { Suspense } from 'react';

import {
  DEFAULT_STATUS,
  memoriesQuery,
  readMemoriesFilters,
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
import { PAGE_SIZE, queryWithPage, shortId } from '@/components/dashboard/format';
import { MemoriesTable, type MemoriesTableRow } from '@/components/dashboard/memories-table';
import { Pager } from '@/components/dashboard/pager';
import { TableSkeleton } from '@/components/dashboard/table-skeleton';
import { ViewHead } from '@/components/dashboard/view-head';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { getServices } from '@/lib/services';

/**
 * The memories list — the first view ported off the Hono dashboard, and the
 * pattern the remaining views follow.
 *
 * It is a server component reading `@rembric/core`/`@rembric/db` directly: no
 * API call, no client-side fetching, no cache that could disagree with the
 * database. Every filter, the page index and the total come from the URL, so the
 * server does the filtering and paginating and the browser back button is the
 * filter's undo.
 *
 * The loading state is a `Suspense` boundary whose fallback is the memories
 * table's own column-shaped skeleton (`TableSkeleton`), and the shell therefore
 * has to hand the awaited `searchParams` down to a child component: a page cannot
 * suspend itself. The alternative the design line named — `useSuspenseQuery` in a
 * client component — was rejected on measurement, not taste: it needs TanStack
 * Query, which this workspace does not depend on, and adding a dependency is out
 * of scope for this change. The read is synchronous SQLite, so the boundary is
 * structural: it is where the fallback belongs, and it is what renders if the
 * read ever becomes one that yields.
 */
export const dynamic = 'force-dynamic';

const TTL_BY_TYPE = Object.entries(REVIEW_TTL_MS).filter(
  (entry): entry is [MemoryType, number] => typeof entry[1] === 'number',
);

const STATUS_OPTIONS = [
  { value: 'active', label: 'active' },
  { value: 'superseded', label: 'superseded' },
  { value: 'archived', label: 'archived' },
] as const;

export default function MemoriesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <MemoriesView searchParams={searchParams} />
    </Suspense>
  );
}

async function MemoriesView({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const filters = readMemoriesFilters(params);
  // The params the pager and the filter form round-trip, as the browser sent
  // them (minus `page` and the retired sentinel).
  const roundTripQuery = memoriesQuery(params);
  const filterKey = queryWithPage(roundTripQuery, 0);

  const { repos } = getServices();

  const wantsNeedsReview = filters.review === 'needs_review';
  const offset = filters.page * PAGE_SIZE;
  // `searchParams` is untrusted text, not the enum: the cast is what makes a
  // bogus value filter to nothing (the SQL comparison simply matches no row)
  // instead of silently falling back to `active`.
  const status = filters.status as MemoryStatus;
  const type = filters.type === '' ? undefined : (filters.type as MemoryType);
  // Sanitized before it reaches `memory_fts MATCH` — ordinary punctuation (an
  // apostrophe, a stray quote, "docker-compose") otherwise raises an FTS5 syntax
  // error and 500s the page. `filters.q` is still what the search box redisplays.
  const ftsQuery = sanitizeFtsQuery(filters.q);

  // A filter the operator applied, as opposed to the listing's own default: the
  // empty state's two shapes (nothing in this scope vs nothing matching this
  // filter set) are told apart by exactly this.
  const isFiltered =
    filters.project !== '' ||
    filters.type !== '' ||
    filters.review !== '' ||
    filters.q !== '' ||
    filters.status !== DEFAULT_STATUS;

  const projectRows = repos.projects.adminListAll();
  const projectSlugById = new Map(projectRows.map((p) => [p.id, p.slug]));
  const resolvedProject = resolveProjectFilter(filters.project, projectRows);
  const nowMs = Date.now();

  let rows: Memory[];
  if (resolvedProject.unknown) {
    rows = [];
  } else if (ftsQuery) {
    rows = repos.memory.adminSearchFts(ftsQuery, {
      status,
      type,
      projectId: resolvedProject.projectId,
      limit: PAGE_SIZE + 1,
      offset,
    });
  } else if (wantsNeedsReview) {
    rows = repos.memory.adminFindNeedsReview({
      projectId: resolvedProject.projectId,
      nowMs,
      limit: PAGE_SIZE + 1,
      offset,
      ttlByType: TTL_BY_TYPE,
      refutedPriorityMs: REFUTED_PRIORITY_MS,
    });
  } else {
    rows = repos.memory.adminList({
      status,
      type,
      projectId: resolvedProject.projectId,
      limit: PAGE_SIZE + 1,
      offset,
    });
  }

  // Derived review state per row for the badge, and to refine the FTS path when
  // the needs_review filter is combined with a text query.
  const reviewById = new Map<string, ReviewState | null>();
  if (rows.length > 0) {
    const reviewTimestamps = repos.memory.reviewTimestampsByIds(rows.map((m) => m.id));
    const at = new Date(nowMs);
    for (const m of rows) {
      reviewById.set(
        m.id,
        deriveReviewState(
          {
            type: m.type,
            createdAt: m.createdAt,
            status: m.status,
            lastConfirmedAt: reviewTimestamps.get(m.id)?.affirmedAt ?? null,
            lastRefutedAt: reviewTimestamps.get(m.id)?.refutedAt ?? null,
          },
          at,
        ).reviewState,
      );
    }
  }
  if (wantsNeedsReview && ftsQuery) {
    rows = rows.filter((m) => reviewById.get(m.id) === 'needs_review');
  }

  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);

  // needs_review+search has no cheap exact count — leave the total undefined
  // there so the pager shows a lower bound rather than a wrong "OF Y".
  let totalCount: number | undefined;
  if (resolvedProject.unknown) {
    totalCount = 0;
  } else if (ftsQuery && wantsNeedsReview) {
    totalCount = undefined;
  } else if (offset === 0 && !hasMore) {
    // All three row queries over-fetch by one and paginate in SQL, so an unfull
    // first page IS the total and the count query is skipped.
    totalCount = visible.length;
  } else if (ftsQuery) {
    totalCount = repos.memory.adminCountFts(ftsQuery, {
      status,
      type,
      projectId: resolvedProject.projectId,
    });
  } else if (wantsNeedsReview) {
    totalCount = repos.memory.adminCountNeedsReview({
      projectId: resolvedProject.projectId,
      nowMs,
      ttlByType: TTL_BY_TYPE,
    });
  } else {
    totalCount = repos.memory.adminCount({ status, type, projectId: resolvedProject.projectId });
  }
  const total = totalCount === undefined ? `${visible.length}+` : String(totalCount);

  const tableRows: MemoriesTableRow[] = visible.map((m) => ({
    id: m.id,
    projectLabel: m.projectId ? (projectSlugById.get(m.projectId) ?? shortId(m.projectId)) : '—',
    type: m.type,
    title: m.title,
    status: m.status,
    createdAt: m.createdAt,
    reviewState: reviewById.get(m.id) ?? null,
  }));

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        title="Rembric Memories."
        metaId="memories-meta"
        meta={[
          { k: 'TOTAL', v: total },
          { k: 'SHOWING', v: `${visible.length} ROWS` },
        ]}
      />

      <Card className="border-primary/40 bg-primary/5 py-3">
        <CardContent className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="outline" className="border-primary/50 font-mono text-brand-accent">
            APPEND-ONLY
          </Badge>
          <span>
            Memories are <b>never deleted or edited</b>. Lifecycle is <b>active</b> · supersede via
            new save · <b>archive</b>.
          </span>
        </CardContent>
      </Card>

      {/* Remounted whenever the filter set changes, so the uncontrolled
          controls re-seed from the URL on a soft navigation (e.g. CLEAR). */}
      <FilterBar key={filterKey} action="/dashboard/memories">
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
        <FilterField label="STATUS" htmlFor="f-status" className="w-36">
          <FilterSelect
            id="f-status"
            name="status"
            value={filters.status}
            options={STATUS_OPTIONS}
          />
        </FilterField>
        <FilterField label="TYPE" htmlFor="f-type" className="w-36">
          <FilterSelect
            id="f-type"
            name="type"
            value={filters.type}
            options={[
              { value: '', label: 'all types' },
              ...MEMORY_TYPES.map((t) => ({ value: t, label: t })),
            ]}
          />
        </FilterField>
        <FilterField label="REVIEW" htmlFor="f-review" className="w-40">
          <FilterSelect
            id="f-review"
            name="review"
            value={filters.review}
            options={[
              { value: '', label: 'any review' },
              { value: 'needs_review', label: 'needs_review' },
            ]}
          />
        </FilterField>
        <FilterField label="SEARCH" htmlFor="f-q" className="min-w-56 flex-1">
          <FilterSearch
            id="f-q"
            name="q"
            value={filters.q}
            placeholder="FTS5 keyword, tag, topic"
          />
        </FilterField>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm">
            FILTER
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/memories">CLEAR</Link>
          </Button>
        </div>
      </FilterBar>

      <div id="memories-list" className="flex flex-col gap-3">
        {visible.length === 0 ? (
          isFiltered ? (
            <TableNoResults what="memories" clearHref="/dashboard/memories" />
          ) : (
            <TableEmptyState
              title="No memories yet"
              description={
                <>
                  Nothing has been saved in this scope. Save your first memory with the{' '}
                  <code className="font-mono">memory.save</code> MCP tool — it appears here
                  immediately, and it is never edited or deleted afterwards.
                </>
              }
            />
          )
        ) : (
          <MemoriesTable rows={tableRows} />
        )}
        <Pager
          page={filters.page}
          hasMore={hasMore}
          total={totalCount}
          totalLabel={`${visible.length} ROWS`}
          path="/dashboard/memories"
          query={roundTripQuery}
        />
      </div>
    </div>
  );
}
