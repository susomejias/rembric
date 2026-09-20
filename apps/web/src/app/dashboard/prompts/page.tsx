import { sanitizeFtsQuery } from '@rembric/core';
import type { Prompt } from '@rembric/db';
import { FileText } from 'lucide-react';
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
import { PAGE_SIZE, relativeTime, shortId, truncate } from '@/components/dashboard/support';
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
 * The prompt library, in the v0 composition.
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
  const nowMs = Date.now();

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
      <PageHead
        icon={FileText}
        eyebrow="Prompt library"
        title="Prompts"
        description="Reusable instructions that guide agents when they read and write context."
        aside={
          <Link
            href={
              filters.includeDeleted ? '/dashboard/prompts' : '/dashboard/prompts?include_deleted=1'
            }
            className="text-[11px] text-(--ink)/45 transition-colors hover:text-(--accent-ink)"
          >
            {filters.includeDeleted ? 'Hide soft-deleted rows' : 'Show soft-deleted rows'}
          </Link>
        }
      />

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatTile label="Live prompts" value={activeCount} tone="lime" hint="visible to agents" />
        <StatTile
          label="Soft-deleted"
          value={deletedCount}
          tone={deletedCount > 0 ? 'amber' : 'dim'}
          hint="hidden unless shown"
        />
        <StatTile
          label="Rows on this page"
          value={visible.length}
          hint={`page ${filters.page + 1}`}
        />
      </section>

      <FilterForm action="/dashboard/prompts" className="mt-6">
        <FilterField label="Scope" htmlFor="p-project" className="w-44">
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
        <FilterField label="Agent" htmlFor="p-agent" className="w-40">
          <FilterInput id="p-agent" name="agent" value={filters.agent} placeholder="claude-code" />
        </FilterField>
        <FilterField label="Session prefix" htmlFor="p-session" className="w-40">
          <FilterInput id="p-session" name="session" value={filters.session} placeholder="01H…" />
        </FilterField>
        <FilterField label="Search" htmlFor="p-q" className="min-w-56 flex-1">
          <FilterInput id="p-q" name="q" value={filters.q} placeholder="FTS5 keyword" />
        </FilterField>
        <FilterField label="Deleted" htmlFor="p-deleted" className="w-32">
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

      <Panel className="mt-6">
        <PanelHead
          eyebrow="Library"
          title="Instructions in use"
          action={ftsQuery ? `${visible.length}+ matching` : `${totalCount ?? 0} matching`}
        />
        {visible.length === 0 ? (
          <EmptyNote>
            {isFiltered
              ? 'No prompt matches this filter set.'
              : 'No prompt has been captured yet. Prompts appear as agents report the instructions they run with.'}
          </EmptyNote>
        ) : (
          <Rows>
            {visible.map((prompt) => {
              const project = prompt.projectId ? projectById.get(prompt.projectId) : undefined;
              const state = prompt.deletedAt
                ? 'deleted'
                : (prompt.replaces?.length ?? 0) > 0
                  ? 'refined'
                  : 'active';
              return (
                <Row key={prompt.id} columns="md:grid-cols-[auto_1.5fr_1fr_auto]">
                  <span
                    className={`grid size-7 place-items-center rounded-lg ${
                      state === 'deleted'
                        ? 'bg-(--ink)/[5%] text-(--ink)/45'
                        : 'bg-(--accent-ink)/[8%] text-(--accent-ink)/70'
                    }`}
                  >
                    <FileText className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm text-(--ink)/80">{truncate(prompt.content, 160)}</p>
                    <p className="mt-1 text-[10px] text-(--ink)/38">
                      {prompt.agent} · {prompt.sessionId ? shortId(prompt.sessionId) : 'no session'}{' '}
                      · {relativeTime(prompt.createdAt, nowMs)}
                    </p>
                  </div>
                  <span className="text-[11px] text-(--ink)/45">{project?.slug ?? 'global'}</span>
                  <Pill tone={state === 'active' ? 'lime' : state === 'refined' ? 'lime' : 'dim'}>
                    {state}
                  </Pill>
                </Row>
              );
            })}
          </Rows>
        )}
        <div className="px-5 pb-5 md:px-6">
          <Pager
            page={filters.page}
            hasMore={hasMore}
            total={totalCount}
            totalLabel={`${visible.length} rows`}
            path="/dashboard/prompts"
            query={roundTripQuery}
          />
        </div>
      </Panel>
    </Page>
  );
}
