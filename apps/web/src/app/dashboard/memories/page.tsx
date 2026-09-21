import {
  deriveReviewState,
  REFUTED_PRIORITY_MS,
  REVIEW_TTL_MS,
  sanitizeFtsQuery,
  type ReviewState,
} from '@rembric/core';
import { MEMORY_TYPES, type Memory, type MemoryStatus, type MemoryType } from '@rembric/db';
import { BrainCircuit } from 'lucide-react';
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
import { PAGE_SIZE, relativeTime, shortId } from '@/components/dashboard/support';
import {
  EmptyNote,
  Page,
  PageHead,
  Panel,
  PanelHead,
  Pill,
  Row,
  Rows,
  StatTile,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The memories list, in the v0 composition: the metric strip, the URL-driven
 * filter bar, and the memory rows as links into the detail page.
 *
 * It stays a server component reading `@rembric/core`/`@rembric/db` directly: no
 * API call, no client-side fetching, no cache that could disagree with the
 * database. Every filter, the page index and the total come from the URL, so the
 * server does the filtering and paginating and the browser back button is the
 * filter's undo.
 */
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
  // The params the pager and the filter form round-trip, as the browser sent
  // them (minus `page` and the retired sentinel).
  const roundTripQuery = memoriesQuery(params);

  const { repos } = getServices();
  const nowMs = Date.now();

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

  // Derived review state per row for the pill, and to refine the FTS path when
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
      <PageHead
        icon={BrainCircuit}
        eyebrow="Memory layer"
        title="Memories"
        description="The durable context Rembric has kept across your projects, ready to be recalled when it matters."
        aside={
          <div className="flex items-center gap-2 rounded-full border border-border bg-accent px-3 py-1.5 text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" />
            {totalMemories.toLocaleString('en-US')} stored
          </div>
        }
      />

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Total memories"
          value={totalMemories.toLocaleString('en-US')}
          hint={`${activeMemories.toLocaleString('en-US')} active`}
        />
        <StatTile label="Showing" value={visible.length} hint={`page ${filters.page + 1}`} />
        <StatTile
          label="Needs review"
          value={totalNeedsReview}
          hint="Past their review TTL"
          tone={totalNeedsReview > 0 ? 'amber' : 'dim'}
        />
      </section>

      <FilterForm action="/dashboard/memories" className="mt-6">
        <FilterField label="Status" htmlFor="f-status" className="w-36">
          <FilterSelect
            id="f-status"
            name="status"
            value={filters.status}
            options={STATUS_OPTIONS}
          />
        </FilterField>
        <FilterField label="Type" htmlFor="f-type" className="w-36">
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
        <FilterField label="Review" htmlFor="f-review" className="w-40">
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
        <FilterField label="Search" htmlFor="f-q" className="min-w-56 flex-1">
          <FilterInput id="f-q" name="q" value={filters.q} placeholder="FTS5 keyword, tag, topic" />
        </FilterField>
        <FilterActions clearHref="/dashboard/memories" />
      </FilterForm>

      <Panel className="mt-6">
        <PanelHead
          eyebrow="Recent context"
          title="What Rembric knows"
          action={
            isFiltered
              ? `filtered · ${roundTripQuery['q'] ? `q=${roundTripQuery['q']}` : 'by URL'}`
              : 'Across all projects'
          }
        />
        {visible.length === 0 ? (
          <EmptyNote>
            {isFiltered ? (
              <>
                No memory matches this filter set.{' '}
                <Link href="/dashboard/memories" className="text-primary hover:underline">
                  Clear the filters
                </Link>
                .
              </>
            ) : (
              <>
                Nothing has been saved in this scope. Save your first memory with the{' '}
                <code className="font-mono">memory.save</code> MCP tool — it appears here
                immediately, and it is never edited or deleted afterwards.
              </>
            )}
          </EmptyNote>
        ) : (
          <Rows>
            {visible.map((memory) => {
              const reviewState = reviewById.get(memory.id) ?? null;
              const tone =
                reviewState === 'needs_review'
                  ? 'amber'
                  : memory.status === 'active'
                    ? 'lime'
                    : 'dim';
              return (
                <Link key={memory.id} href={`/dashboard/memories/${memory.id}`} className="block">
                  <Row columns="md:grid-cols-[minmax(260px,1.5fr)_1fr_auto_auto]">
                    <div className="flex items-start gap-3">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/10" />
                      <div>
                        <p className="text-sm leading-5 text-foreground">{memory.title}</p>
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {memory.type} · {shortId(memory.id)}
                        </p>
                      </div>
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      {memory.projectId
                        ? (projectSlugById.get(memory.projectId) ?? shortId(memory.projectId))
                        : 'global'}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {relativeTime(memory.createdAt, nowMs)}
                    </span>
                    <Pill tone={tone}>
                      {reviewState === 'needs_review' ? 'Needs review' : memory.status}
                    </Pill>
                  </Row>
                </Link>
              );
            })}
          </Rows>
        )}
      </Panel>

      <div className="mt-4">
        <Pager
          page={filters.page}
          hasMore={hasMore}
          total={totalCount}
          totalLabel={`${visible.length} rows`}
          path="/dashboard/memories"
          query={roundTripQuery}
        />
      </div>
    </Page>
  );
}
