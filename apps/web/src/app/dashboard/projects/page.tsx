import { SLUG_REGEX, REVIEW_TTL_MS } from '@rembric/core';
import type { MemoryType } from '@rembric/db';
import { FileText } from 'lucide-react';
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
  EmptyNote,
  Notice,
  Page,
  PageHead,
  Panel,
  PanelHead,
  Row,
  Rows,
  StatTile,
  Time,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The project registry, in the v0 composition.
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
      <PageHead
        icon={FileText}
        eyebrow="Workspace registry"
        title="Projects"
        description={
          <>
            Projects isolate sessions, memories, prompts, relations, and consolidation work behind a
            stable slug — the value passed via <code className="font-mono">/mcp/&lt;slug&gt;</code>{' '}
            or <code className="font-mono">project.use({'{slug}'})</code>.
          </>
        }
        aside={
          <div className="text-right text-[11px] text-muted-foreground">
            <p>Active {activeCount}</p>
            <p>Archived {archivedCount}</p>
          </div>
        }
      />

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatTile label="Projects" value={all.length} tone="lime" hint={`${activeCount} active`} />
        <StatTile
          label="Needs review"
          value={totalNeedsReview}
          tone={totalNeedsReview > 0 ? 'amber' : 'dim'}
          hint="across every project"
        />
        <StatTile label="Pending judgments" value={pendingJudgments} hint="candidate pairs" />
      </section>

      <Notice tone="amber" badge="Not connected" className="mt-6">
        Create, rename, archive and the per-project access controls are not wired in this port: the
        mutation-protection probe has not landed yet, so this page renders lifecycle state only.
      </Notice>

      <FilterForm action="/dashboard/projects" className="mt-6">
        <FilterField label="Status" htmlFor="pr-status" className="w-44">
          <FilterSelect
            id="pr-status"
            name="status"
            value={filters.status}
            options={STATUS_OPTIONS}
          />
        </FilterField>
        <FilterActions clearHref="/dashboard/projects" />
      </FilterForm>

      <Panel className="mt-6">
        <PanelHead
          eyebrow="Project registry"
          title="Active and archived projects"
          action={`${filtered.length} listed`}
        />
        {visible.length === 0 ? (
          <EmptyNote>
            {isFiltered ? (
              <>
                No project matches this status.{' '}
                <Link href="/dashboard/projects" className="text-primary hover:underline">
                  Show all
                </Link>
                .
              </>
            ) : (
              <>
                No project exists yet. A project is created the first time a client connects with a
                slug that matches <code className="font-mono">{String(SLUG_REGEX)}</code>.
              </>
            )}
          </EmptyNote>
        ) : (
          <Rows>
            {visible.map((project) => {
              const archived = project.archivedAt !== null;
              const needsReview = needsReviewByProject.get(project.id) ?? 0;
              return (
                <Row key={project.id} columns="md:grid-cols-[1.4fr_1.1fr_1.1fr_auto_auto]">
                  <div>
                    <Link
                      href={`/dashboard/memories?project=${encodeURIComponent(project.slug)}`}
                      className="text-sm text-foreground hover:text-primary"
                    >
                      {project.displayName ?? project.slug}
                    </Link>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      created <Time value={project.createdAt} /> ·{' '}
                      {relativeTime(project.createdAt, nowMs)}
                    </p>
                  </div>
                  <code className="text-xs text-muted-foreground">{project.slug}</code>
                  <span
                    className={`text-[11px] ${needsReview > 0 && !archived ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
                  >
                    {archived ? (
                      <Time value={project.archivedAt} />
                    ) : (
                      <>
                        {needsReview} to review
                        {project.isDefault ? ' · default' : ''}
                      </>
                    )}
                  </span>
                  <Chip tone={archived ? 'dim' : 'lime'}>{archived ? 'Archived' : 'Active'}</Chip>
                  <div className="flex flex-wrap gap-2">
                    <ProjectControl
                      label="Edit"
                      title="Editing the project lands with the projects Server Action"
                    />
                    <ProjectControl
                      label="Access"
                      title="Access management lands with the tokens Server Action"
                    />
                  </div>
                </Row>
              );
            })}
          </Rows>
        )}
        <div className="px-5 pb-5 md:px-6">
          <Pager
            page={filters.page}
            hasMore={hasMore}
            total={filtered.length}
            totalLabel={`${visible.length} rows`}
            path="/dashboard/projects"
            query={roundTripQuery}
          />
        </div>
      </Panel>
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
      className="w-fit border border-border px-3 py-2 text-[10px] tracking-[.12em] text-muted-foreground uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  );
}
