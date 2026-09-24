import { DomainError, SLUG_REGEX, type ProjectView } from '@rembric/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/components/dashboard/action-form';
import { CreateProjectSheet } from '@/components/dashboard/projects-sheets';
import { ProjectsTable, type ProjectRowData } from '@/components/dashboard/projects-table';
import { singleParam } from '@/components/dashboard/support';
import { Flash, Page } from '@/components/dashboard/ui';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

const ARCHIVE_FORM = 'project.archive';
const BULK_ARCHIVE_FORM = 'project.bulk-archive';
const CREATE_FORM = 'project.create';
const RENAME_FORM = 'project.rename';
const UNARCHIVE_FORM = 'project.unarchive';

async function createProject(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, CREATE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const slug = readField(formData, 'slug');
  const displayNameInput = readField(formData, 'displayName');
  const displayName = displayNameInput.length > 0 ? displayNameInput : null;
  if (!slug) return { error: 'Slug is required.' };

  let created: string;
  try {
    created = guard.services.projects.create({ slug, displayName }).slug;
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect(`/dashboard/projects?created=${encodeURIComponent(created)}`);
}

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

function toRowData(project: ProjectView): ProjectRowData {
  return {
    id: project.id,
    label: project.label,
    displayName: project.displayName ?? null,
    slug: project.slug,
    isDefault: project.isDefault,
    archived: project.archivedAt !== null,
    legacy: !SLUG_REGEX.test(project.slug),
    createdAt: project.createdAt,
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

  const { projects } = getServices();
  const active = projects.list();
  const archived = projects.listArchived();

  const csrf = {
    create: await dashboardCsrfToken(CREATE_FORM),
    rename: await dashboardCsrfToken(RENAME_FORM),
    archive: await dashboardCsrfToken(ARCHIVE_FORM),
    unarchive: await dashboardCsrfToken(UNARCHIVE_FORM),
    bulkArchive: await dashboardCsrfToken(BULK_ARCHIVE_FORM),
  };

  const rows = [...active, ...archived].map(toRowData);

  return (
    <Page className="flex flex-col gap-4">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Projects</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {`${rows.length} projects · ${active.length} active`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <CreateProjectSheet action={createProject} csrf={csrf.create} />
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        A project is identified by its slug (the value passed via{' '}
        <code className="font-mono">/mcp/&lt;slug&gt;</code> or{' '}
        <code className="font-mono">{'project.use({slug})'}</code>).
      </p>

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
        rows={rows}
        actions={{
          rename: renameProject,
          archive: archiveProject,
          unarchive: unarchiveProject,
        }}
        csrf={csrf}
        bulkArchiveAction={bulkArchiveProjects}
        searchable
        selectable
        quickFilter
        pageSize={10}
      />
    </Page>
  );
}
