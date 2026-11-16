import { DomainError, SLUG_REGEX, type ProjectView } from '@rembric/core';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  acceptRepositoryRemotes,
  bindRepository,
  createProject,
  discardPendingRepository,
  removeRepositoryBinding,
  restorePendingRepository,
} from './actions';
import { loadRepositoryData, type RepositoryData } from './repositories-data';
import {
  ACCEPT_REMOTES_FORM,
  BIND_FORM,
  CREATE_FORM,
  DISCARD_FORM,
  REMOVE_FORM,
  RESTORE_FORM,
} from './repository-forms';

import type { ActionState } from '@/components/dashboard/action-form';
import { PageHelp } from '@/components/dashboard/page-help';
import { CreateProjectSheet } from '@/components/dashboard/projects-sheets';
import { ProjectsTable, type ProjectRowData } from '@/components/dashboard/projects-table';
import { singleParam } from '@/components/dashboard/support';
import { TableSearch } from '@/components/dashboard/table-search';
import { Flash, LABEL, Page } from '@/components/dashboard/ui';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

const ARCHIVE_FORM = 'project.archive';
const BULK_ARCHIVE_FORM = 'project.bulk-archive';
const RENAME_FORM = 'project.rename';
const UNARCHIVE_FORM = 'project.unarchive';

async function archiveProject(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, ARCHIVE_FORM);
  if (!guard.ok) return guardFailure(guard);

  try {
    guard.services.projects.archive(readField(formData, 'id'));
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect('/dashboard/projects');
}

async function unarchiveProject(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, UNARCHIVE_FORM);
  if (!guard.ok) return guardFailure(guard);

  try {
    guard.services.projects.unarchive(readField(formData, 'id'));
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect('/dashboard/projects');
}

async function renameProject(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, RENAME_FORM);
  if (!guard.ok) return guardFailure(guard);

  const displayName = readField(formData, 'displayName');
  if (!displayName) return { error: 'Display name is required.' };

  try {
    guard.services.projects.rename(readField(formData, 'id'), displayName);
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect('/dashboard/projects');
}

async function bulkArchiveProjects(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, BULK_ARCHIVE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const ids = formData.getAll('id').filter((value): value is string => typeof value === 'string');
  try {
    for (const id of ids) {
      guard.services.projects.archive(id);
    }
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  revalidatePath('/dashboard/projects');
  return { error: null };
}

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return (typeof value === 'string' ? value : '').trim();
}

function toRowData(project: ProjectView, repositories: RepositoryData): ProjectRowData {
  return {
    id: project.id,
    label: project.label,
    displayName: project.displayName ?? null,
    slug: project.slug,
    isDefault: project.isDefault,
    archived: project.archivedAt !== null,
    legacy: !SLUG_REGEX.test(project.slug),
    createdAt: project.createdAt,
    repositories: repositories.forProject(project.id),
  };
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const justCreated = singleParam(params.created);
  const errorMessage = singleParam(params.error);

  const services = getServices();
  const { projects } = services;
  const active = projects.list();
  const archived = projects.listArchived();
  const repositories = loadRepositoryData(
    services,
    [...active, ...archived].map((p) => ({ id: p.id, slug: p.slug })),
  );

  const csrf = {
    create: await dashboardCsrfToken(CREATE_FORM),
    rename: await dashboardCsrfToken(RENAME_FORM),
    archive: await dashboardCsrfToken(ARCHIVE_FORM),
    unarchive: await dashboardCsrfToken(UNARCHIVE_FORM),
    bulkArchive: await dashboardCsrfToken(BULK_ARCHIVE_FORM),
  };
  const repositoryCsrf = {
    bind: await dashboardCsrfToken(BIND_FORM),
    remove: await dashboardCsrfToken(REMOVE_FORM),
    acceptRemotes: await dashboardCsrfToken(ACCEPT_REMOTES_FORM),
    discard: await dashboardCsrfToken(DISCARD_FORM),
    restore: await dashboardCsrfToken(RESTORE_FORM),
  };
  const pendingCount = repositories.live.length;

  const rows = [...active, ...archived].map((project) => toRowData(project, repositories));
  const q = singleParam(params['q']).trim();
  const needle = q.toLowerCase();
  const lifecycleParam = ['active', 'archived'].includes(singleParam(params['lifecycle']))
    ? singleParam(params['lifecycle'])
    : null;
  const activeCount = rows.filter((row) => !row.archived).length;
  const visibleRows = rows
    .filter((row) =>
      lifecycleParam === 'active'
        ? !row.archived
        : lifecycleParam === 'archived'
          ? row.archived
          : true,
    )
    .filter((row) => {
      if (!needle) return true;
      return `${row.label} ${row.slug} ${row.displayName ?? ''}`.toLowerCase().includes(needle);
    });

  return (
    <Page className="flex flex-col gap-4">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">Projects</h1>
            <PageHelp text="Scopes that group memory per project — agents address them by slug." />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <Link
            href="/dashboard/projects/repositories"
            data-pending-repositories={pendingCount}
            className={cn(
              'inline-flex h-8 items-center gap-2 rounded-[10px] border px-3 text-xs font-medium transition-colors',
              pendingCount > 0
                ? 'border-warn/40 text-foreground hover:bg-warn/10'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            Pending repositories
            <span className={cn(LABEL, 'font-semibold', pendingCount > 0 && 'text-warn')}>
              {pendingCount}
            </span>
          </Link>
          <CreateProjectSheet
            action={createProject}
            csrf={csrf.create}
            pending={repositories.live.filter((row) => row.kind === 'unbound')}
          />
        </div>
      </section>

      {justCreated ? (
        <Flash tone="lime" label="CREATED">
          Created project <code className="font-mono">{justCreated}</code>.
        </Flash>
      ) : null}
      {errorMessage ? (
        <Flash tone="danger" label="ERROR">
          {errorMessage}
        </Flash>
      ) : null}

      <ProjectsTable
        rows={visibleRows}
        actions={{
          rename: renameProject,
          archive: archiveProject,
          unarchive: unarchiveProject,
        }}
        csrf={csrf}
        repositoryActions={{
          bind: bindRepository,
          remove: removeRepositoryBinding,
          acceptRemotes: acceptRepositoryRemotes,
          discard: discardPendingRepository,
          restore: restorePendingRepository,
        }}
        repositoryCsrf={repositoryCsrf}
        bulkArchiveAction={bulkArchiveProjects}
        selectable
        toolbar={
          <TableSearch value={q} placeholder="Search projects…" ariaLabel="Search projects" />
        }
        quickFilter={{
          paramKey: 'lifecycle',
          active: lifecycleParam,
          options: [
            { value: 'active', label: 'Active' },
            { value: 'archived', label: 'Archived' },
          ],
          counts: { active: activeCount, archived: rows.length - activeCount },
          totalCount: rows.length,
          allLabel: 'All',
          label: 'Filter by state',
        }}
        pageSize={20}
      />
    </Page>
  );
}
