import { DomainError, SLUG_REGEX, type ProjectView } from '@rembric/core';
import { revalidatePath } from 'next/cache';
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
import { ProjectsHeader } from '@/components/dashboard/projects-header';
import { CreateProjectSheet } from '@/components/dashboard/projects-sheets';
import { ProjectsTable, type ProjectRowData } from '@/components/dashboard/projects-table';
import { ResultAlerts } from '@/components/dashboard/result-alerts';
import { singleParam } from '@/components/dashboard/support';
import { TableSearch } from '@/components/dashboard/table-search';
import { Page } from '@/components/dashboard/ui';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';

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
    <Page className="flex flex-col gap-5">
      <ProjectsHeader
        active="projects"
        projectCount={rows.length}
        pendingCount={pendingCount}
        actions={
          <CreateProjectSheet
            action={createProject}
            csrf={csrf.create}
            pending={repositories.live.filter((row) => row.kind === 'unbound')}
          />
        }
      />

      <ResultAlerts created={justCreated} error={errorMessage} />

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
