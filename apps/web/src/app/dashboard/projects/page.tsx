import { SLUG_REGEX, type ProjectView } from '@rembric/core';

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
  Notice,
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
import { getServices } from '@/lib/services';

/**
 * The project registry, in the production dashboard's composition: the view
 * head, the slug explanation, the create form, and the active and archived
 * projects as two tables with the name/slug/created/actions columns.
 *
 * The reads are the ported view's own — `projects.list()` for the active table
 * and `projects.listArchived()` for the archived one — and so is the legacy
 * slug rule (`SLUG_REGEX`) and the default-project exception to archiving.
 *
 * Create, rename, archive and unarchive are still NOT wired: they are mutations
 * whose handler is a separate slice. Every field and control main carries is
 * rendered, disabled, with the reason on its `title`; nothing submits. The
 * created/error flashes are read off the URL the create redirect would carry,
 * so they render only for a hand-crafted query string.
 */
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

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
            <Input
              disabled
              defaultValue={project.displayName ?? ''}
              placeholder="display name"
              className="w-[280px]"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled
              title="Renaming a project lands with the projects Server Action"
            >
              RENAME
            </Button>
            {project.archivedAt ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled
                title="Unarchiving a project lands with the projects Server Action"
              >
                UNARCHIVE
              </Button>
            ) : project.isDefault ? null : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled
                title="Archiving a project lands with the projects Server Action"
              >
                ARCHIVE
              </Button>
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

      <Notice tone="amber" badge="Not connected" className="mt-5">
        Create, rename, archive and unarchive are not wired in this port: the projects Server Action
        is a separate slice, so this page renders lifecycle state only. No control here submits.
      </Notice>

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

      <form className="mt-5 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="project-slug" className={`${LABEL} text-muted-foreground`}>
            Slug
          </Label>
          <Input
            id="project-slug"
            name="slug"
            disabled
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
            disabled
            placeholder="display name (optional)"
            className="w-[320px]"
          />
        </div>
        <Button
          type="submit"
          disabled
          title="Project creation lands with the projects Server Action"
        >
          Create project
        </Button>
      </form>

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
