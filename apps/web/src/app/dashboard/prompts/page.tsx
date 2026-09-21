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

import {
  FilterActions,
  FilterField,
  FilterForm,
  FilterInput,
  FilterSelect,
  Pager,
} from '@/components/dashboard/filters';
import { PAGE_SIZE, shortId, truncate } from '@/components/dashboard/support';
import {
  DataBody,
  DataHead,
  DataTable,
  DataTd,
  DataTh,
  DataTr,
  Page,
  Pill,
  SectionBar,
  StatCard,
  StatGrid,
  TableEmpty,
  Tag,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The prompt library, in the production dashboard's composition: the numbered
 * view head, the scope/agent/session/search filter bar, and the prompts as a
 * table with the title/project/session/agent/tags/status/created/content
 * columns.
 *
 * The filter model and the read are the ported view's own: the FTS branch
 * searches the whole corpus post-pagination, so the URL's other filters are
 * applied to its rows in memory (`matchesFilters`) while the non-search branch
 * pushes every filter down into SQL.
 */
export const dynamic = 'force-dynamic';

export default async function PromptsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readPromptsFilters(params);
  const roundTripQuery = promptsQuery(params);

  const isFiltered =
    filters.project !== '' || filters.session !== '' || filters.agent !== '' || filters.q !== '';

  const { repos } = getServices();

  const offset = filters.page * PAGE_SIZE;
  const projectRows = repos.projects.adminListAll();
  const projectById = new Map(projectRows.map((p) => [p.id, p]));
  const resolvedProject = resolveProjectFilter(filters.project, projectRows);

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
      sessionIdPrefix: filters.session || undefined,
      limit: PAGE_SIZE + 1,
      offset,
    });
  }

  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);

  // A text query has no cheap exact count, so the pager shows a lower bound
  // rather than a wrong exact figure.
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

  const activeCount = repos.prompts.adminCount({ includeDeleted: false });
  const deletedCount = repos.prompts.adminCount({ includeDeleted: true }) - activeCount;

  return (
    <Page>
      <ViewHead
        num="03b"
        title="Rembric Prompts."
        hl="Rembric"
        meta={[
          { k: 'TOTAL', v: totalCount === undefined ? `${visible.length}+` : totalCount },
          { k: 'SHOWING', v: `${visible.length} ROWS` },
        ]}
      />

      <StatGrid className="mt-6 sm:grid-cols-3 xl:grid-cols-3">
        <StatCard
          k="LIVE PROMPTS"
          v={activeCount}
          tone="lime"
          sub={<span>VISIBLE TO AGENTS</span>}
        />
        <StatCard
          k="SOFT-DELETED"
          v={deletedCount}
          tone={deletedCount > 0 ? 'amber' : 'dim'}
          sub={<span>HIDDEN UNLESS SHOWN</span>}
        />
        <StatCard k="SHOWING" v={visible.length} sub={<span>PAGE {filters.page + 1}</span>} />
      </StatGrid>

      <FilterForm action="/dashboard/prompts" className="mt-6">
        <FilterField label="SCOPE" htmlFor="p-project">
          <FilterSelect
            id="p-project"
            name="project"
            value={filters.project}
            options={[
              { value: '', label: 'all scopes' },
              ...projectRows.map((p) => ({ value: p.slug, label: p.slug })),
            ]}
          />
        </FilterField>
        <FilterField label="AGENT" htmlFor="p-agent">
          <FilterInput
            id="p-agent"
            name="agent"
            value={filters.agent}
            placeholder="e.g. claude-code"
          />
        </FilterField>
        <FilterField label="SESSION" htmlFor="p-session">
          <FilterInput id="p-session" name="session" value={filters.session} placeholder="01H…" />
        </FilterField>
        <FilterField label="SEARCH" htmlFor="p-q" className="min-w-56 flex-1">
          <FilterInput id="p-q" name="q" value={filters.q} placeholder="FTS5 keyword" />
        </FilterField>
        <FilterField label="DELETED" htmlFor="p-deleted">
          <FilterSelect
            id="p-deleted"
            name="include_deleted"
            value={filters.includeDeleted ? '1' : ''}
            options={[
              { value: '', label: 'hidden' },
              { value: '1', label: 'shown' },
            ]}
          />
        </FilterField>
        <FilterActions clearHref="/dashboard/prompts" />
      </FilterForm>

      <SectionBar
        name="Library"
        meta={ftsQuery ? `${visible.length}+ MATCHING` : `${totalCount ?? 0} MATCHING`}
      />
      {visible.length === 0 ? (
        <TableEmpty>
          {isFiltered ? 'NO PROMPT MATCHES THIS FILTER' : 'NO PROMPT HAS BEEN CAPTURED YET'}
        </TableEmpty>
      ) : (
        <DataTable>
          <DataHead>
            <DataTh>title</DataTh>
            <DataTh>project</DataTh>
            <DataTh>session</DataTh>
            <DataTh>agent</DataTh>
            <DataTh>tags</DataTh>
            <DataTh>status</DataTh>
            <DataTh>created</DataTh>
            <DataTh>content</DataTh>
          </DataHead>
          <DataBody>
            {visible.map((prompt) => {
              const project = prompt.projectId ? projectById.get(prompt.projectId) : undefined;
              const state = prompt.deletedAt
                ? 'deleted'
                : (prompt.replaces?.length ?? 0) > 0
                  ? 'refined'
                  : 'active';
              return (
                <DataTr key={prompt.id} className={prompt.deletedAt ? 'opacity-60' : undefined}>
                  <DataTd className="max-w-[220px] truncate">{truncate(prompt.title, 60)}</DataTd>
                  <DataTd className="text-muted-foreground">{project?.slug ?? '—'}</DataTd>
                  <DataTd className="font-mono text-xs text-muted-foreground">
                    {prompt.sessionId ? (
                      <Link
                        href={`/dashboard/sessions/${prompt.sessionId}`}
                        className="hover:text-primary"
                      >
                        {shortId(prompt.sessionId)}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </DataTd>
                  <DataTd>{prompt.agent}</DataTd>
                  <DataTd>
                    <div className="flex flex-wrap gap-1">
                      {(prompt.tags ?? []).length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        (prompt.tags ?? []).map((tag) => <Tag key={tag}>{tag}</Tag>)
                      )}
                    </div>
                  </DataTd>
                  <DataTd>
                    <Pill tone={state === 'deleted' ? 'dim' : 'lime'}>{state}</Pill>
                  </DataTd>
                  <DataTd className="font-mono text-xs text-muted-foreground">
                    <Time value={prompt.createdAt} />
                  </DataTd>
                  <DataTd className="max-w-[380px] truncate text-muted-foreground">
                    {truncate(prompt.content, 160)}
                  </DataTd>
                </DataTr>
              );
            })}
          </DataBody>
        </DataTable>
      )}

      <Pager
        page={filters.page}
        hasMore={hasMore}
        total={totalCount}
        totalLabel={`${visible.length} ROWS`}
        path="/dashboard/prompts"
        query={roundTripQuery}
      />
    </Page>
  );
}
