import { SLUG_REGEX, REVIEW_TTL_MS } from '@rembric/core';
import type { MemoryType } from '@rembric/db';
import Link from 'next/link';

import {
  DEFAULT_PROJECT_STATUS,
  projectsQuery,
  readProjectsFilters,
  type SearchParams,
} from './filters';

import {
  FilterActions,
  FilterField,
  FilterForm,
  FilterSelect,
  Pager,
} from '@/components/dashboard/filters';
import { PAGE_SIZE, relativeTime } from '@/components/dashboard/support';
import {
  Chip,
  DataBody,
  DataHead,
  DataTable,
  DataTd,
  DataTh,
  DataTr,
  Notice,
  Page,
  SectionBar,
  StatCard,
  StatGrid,
  TableEmpty,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The project registry, in the production dashboard's composition: the numbered
 * view head, the corpus stats, the status filter bar, and the projects as a
 * table with the name/slug/created/actions columns.
 *
 * The read is the ported view's own — one `projects.list(true)` for every status
 * — and so is the rule that an unrecognised `status` filters to NOTHING rather
 * than silently widening back to `all`.
 *
 * Rename, archive, unarchive and create are still NOT wired: they are mutations
 * whose Server Action boundary is a separate slice, so this page renders
 * lifecycle state. The per-project `Edit` and `Access` controls the retired view
 * carried are rendered the same way — present, and disabled with the reason.
 */
export const dynamic = 'force-dynamic';

const TTL_BY_TYPE = Object.entries(REVIEW_TTL_MS).filter(
  (entry): entry is [MemoryType, number] => typeof entry[1] === 'number',
);

const STATUS_OPTIONS = [
  { value: 'all', label: 'all projects' },
  { value: 'active', label: 'active' },
  { value: 'archived', label: 'archived' },
];

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readProjectsFilters(params);
  const roundTripQuery = projectsQuery(params);

  const isFiltered = filters.status !== DEFAULT_PROJECT_STATUS;

  const { projects, repos } = getServices();
  const nowMs = Date.now();

  const all = projects.list(true);
  const activeCount = all.filter((p) => p.archivedAt === null).length;
  const archivedCount = all.length - activeCount;

  // `status` is untrusted text, not the enum: an unrecognised value filters to
  // NOTHING rather than silently widening back to `all`.
  const filtered =
    filters.status === 'all'
      ? all
      : filters.status === 'active'
        ? all.filter((p) => p.archivedAt === null)
        : filters.status === 'archived'
          ? all.filter((p) => p.archivedAt !== null)
          : [];

  const offset = filters.page * PAGE_SIZE;
  const visible = filtered.slice(offset, offset + PAGE_SIZE);
  const hasMore = offset + PAGE_SIZE < filtered.length;

  // One grouped read for the whole corpus, keyed by project: a per-row count
  // query would be a second rule for the same number.
  const needsReviewByProject = new Map(
    repos.memory
      .adminCountNeedsReviewByProject({ nowMs, ttlByType: TTL_BY_TYPE })
      .map((row) => [row.projectId ?? 'global', row.count]),
  );
  const totalNeedsReview = [...needsReviewByProject.values()].reduce((acc, n) => acc + n, 0);
  const pendingJudgments = repos.relations.adminCountByStatus('pending');

  return (
    <Page>
      <ViewHead
        num="06"
        title="Rembric Projects."
        hl="Rembric"
        meta={[
          { k: 'ACTIVE', v: activeCount },
          { k: 'ARCHIVED', v: archivedCount },
        ]}
      />

      <StatGrid className="mt-6 sm:grid-cols-3 xl:grid-cols-3">
        <StatCard k="PROJECTS" v={all.length} tone="lime" sub={<span>{activeCount} ACTIVE</span>} />
        <StatCard
          k="NEEDS REVIEW"
          v={totalNeedsReview}
          tone={totalNeedsReview > 0 ? 'amber' : 'dim'}
          sub={<span>ACROSS EVERY PROJECT</span>}
        />
        <StatCard k="PENDING JUDGMENTS" v={pendingJudgments} sub={<span>CANDIDATE PAIRS</span>} />
      </StatGrid>

      <Notice tone="amber" badge="Not connected" className="mt-6 mb-5">
        Create, rename, archive and the per-project access controls are not wired in this port: the
        mutation-protection probe has not landed yet, so this page renders lifecycle state only.
      </Notice>

      <FilterForm action="/dashboard/projects">
        <FilterField label="STATUS" htmlFor="pr-status">
          <FilterSelect
            id="pr-status"
            name="status"
            value={filters.status}
            options={STATUS_OPTIONS}
          />
        </FilterField>
        <FilterActions clearHref="/dashboard/projects" />
      </FilterForm>

      <SectionBar name="Project registry" meta={`${filtered.length} LISTED`} />
      {visible.length === 0 ? (
        <TableEmpty>
          {isFiltered ? (
            <>
              NO PROJECT MATCHES THIS STATUS.{' '}
              <Link href="/dashboard/projects" className="text-primary hover:underline">
                Show all
              </Link>
              .
            </>
          ) : (
            <>
              NO PROJECT EXISTS YET — a project is created the first time a client connects with a
              slug matching <code className="font-mono">{String(SLUG_REGEX)}</code>.
            </>
          )}
        </TableEmpty>
      ) : (
        <DataTable>
          <DataHead>
            <DataTh>name</DataTh>
            <DataTh>slug</DataTh>
            <DataTh>created</DataTh>
            <DataTh>actions</DataTh>
          </DataHead>
          <DataBody>
            {visible.map((project) => {
              const archived = project.archivedAt !== null;
              const needsReview = needsReviewByProject.get(project.id) ?? 0;
              return (
                <DataTr key={project.id}>
                  <DataTd>
                    <Link
                      href={`/dashboard/memories?project=${encodeURIComponent(project.slug)}`}
                      className="transition-colors hover:text-primary"
                    >
                      {project.displayName ?? project.slug}
                    </Link>
                    <span className="ml-3">
                      <Chip tone={archived ? 'dim' : 'lime'}>
                        {archived ? 'Archived' : 'Active'}
                      </Chip>
                    </span>
                  </DataTd>
                  <DataTd className="font-mono text-xs text-muted-foreground">
                    {project.slug}
                  </DataTd>
                  <DataTd className="font-mono text-xs text-muted-foreground">
                    <Time value={project.createdAt} />
                    <span className="ml-2">{relativeTime(project.createdAt, nowMs)}</span>
                  </DataTd>
                  <DataTd>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={
                          needsReview > 0 && !archived
                            ? 'font-mono text-[10px] uppercase tracking-[.12em] text-amber-600 dark:text-amber-400'
                            : 'font-mono text-[10px] uppercase tracking-[.12em] text-muted-foreground'
                        }
                      >
                        {archived ? (
                          <Time value={project.archivedAt} />
                        ) : (
                          `${needsReview} to review`
                        )}
                      </span>
                      <ProjectControl
                        label="Edit"
                        title="Editing the project lands with the projects Server Action"
                      />
                      <ProjectControl
                        label="Access"
                        title="Access management lands with the tokens Server Action"
                      />
                    </div>
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
        total={filtered.length}
        totalLabel={`${visible.length} ROWS`}
        path="/dashboard/projects"
        query={roundTripQuery}
      />
    </Page>
  );
}

/**
 * The per-project action placeholder. It is disabled rather than a no-op button
 * on purpose: the mutation behind it does not exist yet, and an enabled control
 * that silently does nothing is a lie the operator pays for.
 */
function ProjectControl({ label, title }: { label: string; title: string }) {
  return (
    <button
      type="button"
      disabled
      title={title}
      className="w-fit border border-border px-3 py-2 font-mono text-[10px] tracking-[.12em] text-muted-foreground uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  );
}
