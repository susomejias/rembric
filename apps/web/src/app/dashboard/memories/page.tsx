import {
  deriveReviewState,
  REFUTED_PRIORITY_MS,
  REVIEW_TTL_MS,
  sanitizeFtsQuery,
  type ReviewState,
} from '@rembric/core';
import { MEMORY_TYPES, type Memory, type MemoryStatus, type MemoryType } from '@rembric/db';
import Link from 'next/link';

import {
  DEFAULT_STATUS,
  memoriesQuery,
  readMemoriesFilters,
  resolveProjectFilter,
  type SearchParams,
} from './filters';

import {
  FilterActions,
  FilterField,
  FilterForm,
  FilterInput,
  FilterSelect,
  Pager,
} from '@/components/dashboard/filters';
import { MemoriesTable } from '@/components/dashboard/memories-table';
import { PAGE_SIZE, shortId } from '@/components/dashboard/support';
import { Page, StatCard, StatGrid, TableEmpty } from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

const TTL_BY_TYPE = Object.entries(REVIEW_TTL_MS).filter(
  (entry): entry is [MemoryType, number] => typeof entry[1] === 'number',
);

const STATUS_OPTIONS = [
  { value: 'active', label: 'active' },
  { value: 'superseded', label: 'superseded' },
  { value: 'archived', label: 'archived' },
];

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readMemoriesFilters(params);
  const roundTripQuery = memoriesQuery(params);

  const { repos } = getServices();
  const nowMs = Date.now();

  const wantsNeedsReview = filters.review === 'needs_review';
  const offset = filters.page * PAGE_SIZE;
  const status = filters.status as MemoryStatus;
  const type = filters.type === '' ? undefined : (filters.type as MemoryType);
  const ftsQuery = sanitizeFtsQuery(filters.q);

  const isFiltered =
    filters.project !== '' ||
    filters.type !== '' ||
    filters.review !== '' ||
    filters.q !== '' ||
    filters.status !== DEFAULT_STATUS;

  const projectRows = repos.projects.adminListAll();
  const projectSlugById = new Map(projectRows.map((p) => [p.id, p.slug]));
  const resolvedProject = resolveProjectFilter(filters.project, projectRows);

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

  let totalCount: number | undefined;
  if (resolvedProject.unknown) {
    totalCount = 0;
  } else if (ftsQuery && wantsNeedsReview) {
    totalCount = undefined;
  } else if (offset === 0 && !hasMore) {
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

  const statusCounts = repos.memory.countRowsByStatus();
  const totalMemories = statusCounts.reduce((acc, row) => acc + row.count, 0);
  const activeMemories = statusCounts.find((row) => row.status === 'active')?.count ?? 0;
  const totalNeedsReview = repos.memory.adminCountNeedsReview({ nowMs, ttlByType: TTL_BY_TYPE });

  return (
    <Page>
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Memories</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {totalMemories.toLocaleString('en-US')} total · {activeMemories.toLocaleString('en-US')}{' '}
            active · {totalNeedsReview.toLocaleString('en-US')} need review
          </p>
        </div>
      </section>

      <StatGrid className="mt-6 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4">
        <StatCard
          k="TOTAL MEMORIES"
          v={totalMemories.toLocaleString('en-US')}
          tone="lime"
          sub={<span>ALL TIME</span>}
        />
        <StatCard
          k="ACTIVE MEMORIES"
          v={activeMemories.toLocaleString('en-US')}
          sub={<span>RECALLABLE</span>}
        />
        <StatCard k="SHOWING" v={visible.length} sub={<span>PAGE {filters.page + 1}</span>} />
        <StatCard
          k="NEEDS REVIEW"
          v={totalNeedsReview}
          tone={totalNeedsReview > 0 ? 'amber' : 'dim'}
          sub={<span>PAST THEIR TTL</span>}
        />
      </StatGrid>

      <FilterForm action="/dashboard/memories" className="mt-6">
        <FilterField label="SCOPE" htmlFor="f-project">
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
        <FilterField label="STATUS" htmlFor="f-status">
          <FilterSelect
            id="f-status"
            name="status"
            value={filters.status}
            options={STATUS_OPTIONS}
          />
        </FilterField>
        <FilterField label="TYPE" htmlFor="f-type">
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
        <FilterField label="REVIEW" htmlFor="f-review">
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
          <FilterInput id="f-q" name="q" value={filters.q} placeholder="FTS5 keyword, tag, topic" />
        </FilterField>
        <FilterActions clearHref="/dashboard/memories" />
      </FilterForm>

      {visible.length === 0 ? (
        <TableEmpty>
          {isFiltered ? (
            <>
              No memories match this filter.{' '}
              <Link href="/dashboard/memories" className="text-primary hover:underline">
                Clear the filters
              </Link>
              .
            </>
          ) : (
            <>
              Nothing has been saved in this scope — save your first with the{' '}
              <code className="font-mono">memory.save</code> MCP tool.
            </>
          )}
        </TableEmpty>
      ) : (
        <MemoriesTable
          rows={visible.map((memory) => ({
            id: memory.id,
            title: memory.title,
            type: memory.type,
            project: memory.projectId
              ? (projectSlugById.get(memory.projectId) ?? shortId(memory.projectId))
              : '—',
            status: memory.status,
            createdAt: memory.createdAt,
            lastSeenAt: memory.lastSeenAt,
            needsReview: (reviewById.get(memory.id) ?? null) === 'needs_review',
          }))}
        />
      )}

      <Pager
        page={filters.page}
        hasMore={hasMore}
        total={totalCount}
        totalLabel={`${visible.length} ROWS`}
        path="/dashboard/memories"
        query={roundTripQuery}
      />
    </Page>
  );
}
