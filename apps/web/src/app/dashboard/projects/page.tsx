import { DomainError, SLUG_REGEX, type ProjectView } from '@rembric/core';
import { redirect } from 'next/navigation';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { singleParam } from '@/components/dashboard/support';
import {
  DataBody,
  DataHead,
  DataTable,
  DataTd,
  DataTh,
  DataTr,
  Flash,
  LABEL,
  Page,
  Pill,
  SectionBar,
  TableEmpty,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

const CREATE_FORM = 'project.create';
const ARCHIVE_FORM = 'project.archive';
const UNARCHIVE_FORM = 'project.unarchive';
const RENAME_FORM = 'project.rename';

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

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return (typeof value === 'string' ? value : '').trim();
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

  const renderRow = (project: ProjectView) => {
    const isLegacy = !SLUG_REGEX.test(project.slug);
    return (
      <DataTr key={project.id}>
        <DataTd>
          <span className="flex flex-wrap items-center gap-2">
            {project.label}
            {project.isDefault ? <Pill tone="dim">default</Pill> : null}
          </span>
        </DataTd>
        <DataTd className="font-mono text-xs text-muted-foreground">
          <span className="flex flex-wrap items-center gap-2">
            {project.slug}
            {isLegacy ? <Pill tone="amber">legacy</Pill> : null}
          </span>
        </DataTd>
        <DataTd className="font-mono text-xs text-muted-foreground">
          <Time value={project.createdAt} />
        </DataTd>
        <DataTd>
          <div className="flex flex-wrap items-center gap-2">
            <ActionForm action={renameProject} className="flex flex-wrap items-center gap-2">
              <CsrfField form={RENAME_FORM} />
              <input type="hidden" name="id" value={project.id} />
              <Input
                name="displayName"
                defaultValue={project.displayName ?? ''}
                placeholder="display name"
                className="w-[280px]"
              />
              <Button type="submit" variant="outline" size="sm">
                RENAME
              </Button>
            </ActionForm>
            {project.archivedAt ? (
              <ActionForm action={unarchiveProject}>
                <CsrfField form={UNARCHIVE_FORM} />
                <input type="hidden" name="id" value={project.id} />
                <Button type="submit" variant="outline" size="sm">
                  UNARCHIVE
                </Button>
              </ActionForm>
            ) : project.isDefault ? null : (
              <ActionForm action={archiveProject}>
                <CsrfField form={ARCHIVE_FORM} />
                <input type="hidden" name="id" value={project.id} />
                <ConfirmSubmit
                  tone="warn"
                  title={`Archive project "${project.label}"?`}
                  description="New writes will be rejected; existing memories stay queryable. You can unarchive later."
                  confirmLabel="ARCHIVE PROJECT"
                >
                  <Button type="button" variant="outline" size="sm">
                    ARCHIVE
                  </Button>
                </ConfirmSubmit>
              </ActionForm>
            )}
          </div>
        </DataTd>
      </DataTr>
    );
  };

  return (
    <Page>
      <ViewHead
        num="06"
        title="Rembric Projects."
        hl="Rembric"
        meta={[
          { k: 'ACTIVE', v: active.length },
          { k: 'ARCHIVED', v: archived.length },
        ]}
      />

      <p className="mt-4 text-xs text-muted-foreground">
        A project is identified by its slug (the value passed via{' '}
        <code className="font-mono">/mcp/&lt;slug&gt;</code> or{' '}
        <code className="font-mono">{'project.use({slug})'}</code>).
      </p>

      {justCreated ? (
        <div className="mt-5">
          <Flash tone="lime" label="CREATED">
            Created project <code className="font-mono">{justCreated}</code>.
          </Flash>
        </div>
      ) : null}
      {errorMessage ? (
        <div className="mt-5">
          <Flash tone="danger" label="ERROR">
            {errorMessage}
          </Flash>
        </div>
      ) : null}

      <ActionForm action={createProject} className="mt-5 flex flex-wrap items-end gap-3">
        <CsrfField form={CREATE_FORM} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="project-slug" className={`${LABEL} text-muted-foreground`}>
            Slug
          </Label>
          <Input
            id="project-slug"
            name="slug"
            required
            placeholder="my-project"
            pattern="[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?"
            className="w-[220px]"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="project-display-name" className={`${LABEL} text-muted-foreground`}>
            Display name
          </Label>
          <Input
            id="project-display-name"
            name="displayName"
            placeholder="display name (optional)"
            className="w-[320px]"
          />
        </div>
        <Button type="submit">Create project</Button>
      </ActionForm>

      <div className="mt-8">
        <SectionBar name={`Active (${active.length})`} />
        {active.length === 0 ? (
          <TableEmpty>No active projects.</TableEmpty>
        ) : (
          <DataTable>
            <DataHead>
              <DataTh>name</DataTh>
              <DataTh>slug</DataTh>
              <DataTh>created</DataTh>
              <DataTh>actions</DataTh>
            </DataHead>
            <DataBody>{active.map(renderRow)}</DataBody>
          </DataTable>
        )}
      </div>

      {archived.length > 0 ? (
        <div className="mt-8">
          <SectionBar name={`Archived (${archived.length})`} />
          <DataTable>
            <DataHead>
              <DataTh>name</DataTh>
              <DataTh>slug</DataTh>
              <DataTh>created</DataTh>
              <DataTh>actions</DataTh>
            </DataHead>
            <DataBody>{archived.map(renderRow)}</DataBody>
          </DataTable>
        </div>
      ) : null}
    </Page>
  );
}
