'use client';

import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { ActionForm, type FormAction } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { RenameProjectSheet } from '@/components/dashboard/projects-sheets';
import { Pill, Time } from '@/components/dashboard/ui';
import { DataTable, type DataTableColumn } from '@/components/spectrumui/data-table';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

const MENU_ITEM_ROOT = 'flex h-8 w-full items-center px-2';
const MENU_ITEM_BUTTON = 'h-full w-full justify-start px-0 text-sm font-normal';
const BULK_BUTTON = 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/20 hover:text-warn';

export type ProjectArchiveAction = 'archive' | 'unarchive' | 'none';

export interface ProjectRowData {
  readonly id: string;
  readonly label: string;
  readonly displayName: string | null;
  readonly slug: string;
  readonly isDefault: boolean;
  readonly archived: boolean;
  readonly legacy: boolean;
  readonly createdAt: Date;
}

export interface ProjectServerActions {
  rename: FormAction;
  archive: FormAction;
  unarchive: FormAction;
}

export interface ProjectCsrfTokens {
  readonly rename: string | null;
  readonly archive: string | null;
  readonly unarchive: string | null;
  readonly bulkArchive: string | null;
}

/**
 * The default project is the only one that cannot be archived, and an archived
 * project can only be restored — so a row offers at most one of the two.
 */
export function projectArchiveAction(row: {
  readonly isDefault: boolean;
  readonly archived: boolean;
}): ProjectArchiveAction {
  if (row.archived) return 'unarchive';
  return row.isDefault ? 'none' : 'archive';
}

export function ProjectsTable({
  rows,
  actions,
  csrf,
  bulkArchiveAction,
  quickFilter = false,
  selectable = false,
  searchable = false,
  pageSize,
}: {
  rows: readonly ProjectRowData[];
  actions: ProjectServerActions;
  csrf: ProjectCsrfTokens;
  bulkArchiveAction: FormAction;
  quickFilter?: boolean;
  selectable?: boolean;
  searchable?: boolean;
  pageSize?: number;
}) {
  // The target survives closing so the panel is still painted while it slides
  // out; `renameOpen` alone decides whether the sheet is on screen.
  const [renameTarget, setRenameTarget] = React.useState<ProjectRowData | null>(null);
  const [renameOpen, setRenameOpen] = React.useState(false);

  const columns: DataTableColumn<ProjectRowData>[] = [
    {
      id: 'project',
      header: 'Project',
      sortable: true,
      value: (row) => row.label,
      cell: (row) => (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{row.label}</span>
            {row.isDefault ? <Pill tone="dim">default</Pill> : null}
            {row.archived ? <Pill tone="dim">archived</Pill> : null}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-mono text-[11px] text-muted-foreground">{row.slug}</span>
            {row.legacy ? <Pill tone="amber">legacy</Pill> : null}
          </span>
        </div>
      ),
    },
    {
      id: 'created',
      header: 'Created',
      sortable: true,
      value: (row) => row.createdAt.getTime(),
      cell: (row) => (
        <Time value={row.createdAt} className="font-mono text-xs text-muted-foreground" />
      ),
    },
  ];

  return (
    <>
      <DataTable
        data={rows}
        columns={columns}
        rowId={(row) => row.id}
        rowLabel={(row) => `project ${row.label}`}
        caption="Projects with their slug, creation date and lifecycle actions"
        searchable={searchable}
        searchPlaceholder="Search projects…"
        searchText={(row) => `${row.label} ${row.slug} ${row.displayName ?? ''}`}
        variant="panel"
        density="default"
        emptyState={
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            NO PROJECT MATCHES THIS FILTER
          </div>
        }
        quickFilter={
          quickFilter
            ? {
                columnId: 'state',
                label: 'Filter by state',
                allLabel: 'All',
                getValue: (row) => (row.archived ? 'archived' : 'active'),
              }
            : undefined
        }
        selectable={selectable}
        bulkActions={
          selectable
            ? (context) => {
                const archivable = context.rows.filter(
                  (row) => projectArchiveAction(row) === 'archive',
                );
                const skipped = context.rows.length - archivable.length;
                return (
                  <ActionForm action={bulkArchiveAction} className="flex">
                    <input type="hidden" name="csrf" value={csrf.bulkArchive ?? ''} />
                    {archivable.map((row) => (
                      <input key={row.id} type="hidden" name="id" value={row.id} />
                    ))}
                    <ConfirmSubmit
                      tone="warn"
                      title={`Archive ${archivable.length} selected ${
                        archivable.length === 1 ? 'project' : 'projects'
                      }?`}
                      description={`${archivable.length} ${
                        archivable.length === 1 ? 'project' : 'projects'
                      } will reject new writes while existing memories stay queryable. ${skipped} ${
                        skipped === 1 ? 'project' : 'projects'
                      } will be skipped — the default project cannot be archived, and an archived one is left as it is.`}
                      confirmLabel="ARCHIVE SELECTED"
                    >
                      <Button type="button" size="sm" className={BULK_BUTTON}>
                        Archive selected
                      </Button>
                    </ConfirmSubmit>
                  </ActionForm>
                );
              }
            : undefined
        }
        rowActions={(row) => (
          <ProjectRowMenu
            row={row}
            actions={actions}
            csrf={csrf}
            onRename={() => {
              setRenameTarget(row);
              setRenameOpen(true);
            }}
          />
        )}
        pageSize={pageSize}
      />

      <RenameProjectSheet
        target={renameTarget}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        action={actions.rename}
        csrf={csrf.rename}
      />
    </>
  );
}

function ProjectRowMenu({
  row,
  actions,
  csrf,
  onRename,
}: {
  row: ProjectRowData;
  actions: ProjectServerActions;
  csrf: ProjectCsrfTokens;
  onRename: () => void;
}) {
  const archiveAction = projectArchiveAction(row);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Actions for project ${row.label}`}
          className="size-7 text-muted-foreground hover:text-foreground"
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 border-border bg-popover">
        <DropdownMenuItem asChild>
          <Link
            href={`/dashboard/memories?project=${encodeURIComponent(row.slug)}`}
            className={cn(MENU_ITEM_ROOT, 'cursor-pointer')}
          >
            View memories
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRename} className={MENU_ITEM_ROOT}>
          Rename project
        </DropdownMenuItem>
        {archiveAction === 'none' ? null : (
          <>
            <DropdownMenuSeparator className="bg-border" />
            {archiveAction === 'archive' ? (
              <DropdownMenuItem
                asChild
                onSelect={(event) => event.preventDefault()}
                className="text-warn focus:text-warn"
              >
                <ActionForm action={actions.archive} className={MENU_ITEM_ROOT}>
                  <input type="hidden" name="csrf" value={csrf.archive ?? ''} />
                  <input type="hidden" name="id" value={row.id} />
                  <ConfirmSubmit
                    tone="warn"
                    title={`Archive project "${row.label}"?`}
                    description="New writes will be rejected; existing memories stay queryable. You can unarchive later."
                    confirmLabel="ARCHIVE PROJECT"
                  >
                    <Button type="button" variant="ghost" size="sm" className={MENU_ITEM_BUTTON}>
                      Archive project
                    </Button>
                  </ConfirmSubmit>
                </ActionForm>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
                <ActionForm action={actions.unarchive} className={MENU_ITEM_ROOT}>
                  <input type="hidden" name="csrf" value={csrf.unarchive ?? ''} />
                  <input type="hidden" name="id" value={row.id} />
                  <Button type="submit" variant="ghost" size="sm" className={MENU_ITEM_BUTTON}>
                    Unarchive project
                  </Button>
                </ActionForm>
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
