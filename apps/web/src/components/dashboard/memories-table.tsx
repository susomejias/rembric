'use client';

import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { ReviewPill, StatusPill, Time } from '@/components/dashboard/ui';
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

export interface MemoryRowData {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly type: string;
  readonly project: string;
  readonly tags: readonly string[];
  readonly status: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date | null;
  readonly needsReview: boolean;
  readonly confirms: number;
}

export interface MemoryServerActions {
  archive: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  confirm: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
}

export interface MemoryCsrfTokens {
  readonly archive: string | null;
  readonly confirm: string | null;
  readonly bulkArchive: string | null;
}

export function MemoriesTable({
  rows,
  actions,
  csrf,
  bulkArchive,
  quickFilter = false,
  selectable = false,
  searchable = false,
  pageSize,
}: {
  rows: readonly MemoryRowData[];
  actions: MemoryServerActions;
  csrf: MemoryCsrfTokens;
  bulkArchive: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  quickFilter?: boolean;
  selectable?: boolean;
  searchable?: boolean;
  pageSize?: number;
}) {
  const columns: DataTableColumn<MemoryRowData>[] = [
    {
      id: 'memory',
      header: 'Memory',
      sortable: true,
      value: (row) => row.title,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <Link
            href={`/dashboard/memories/${row.id}`}
            className="truncate text-sm font-medium text-foreground transition-colors hover:text-primary"
          >
            {row.title}
          </Link>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {row.type} · {row.project}
          </span>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      value: (row) => row.status,
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill status={row.status} />
          {row.needsReview ? <ReviewPill /> : null}
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
    {
      id: 'lastSeen',
      header: 'Last seen',
      sortable: true,
      hideBelow: 'lg',
      value: (row) => row.lastSeenAt?.getTime() ?? null,
      cell: (row) => (
        <Time value={row.lastSeenAt} className="font-mono text-xs text-muted-foreground" />
      ),
    },
    {
      id: 'confirms',
      header: 'Confirms',
      numeric: true,
      sortable: true,
      hideBelow: 'md',
      value: (row) => row.confirms,
      cell: (row) => <span className="tabular-nums">{row.confirms}</span>,
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      rowId={(row) => row.id}
      rowLabel={(row) => `${row.type} memory — ${row.title}`}
      caption="Memories with status, creation, last-seen dates and affirmation counts"
      searchable={searchable}
      searchPlaceholder="Search memories…"
      searchText={(row) => `${row.title} ${row.content} ${row.tags.join(' ')} ${row.project}`}
      variant="panel"
      density="default"
      emptyState={
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          NO MEMORY MATCHES THIS FILTER
        </div>
      }
      quickFilter={
        quickFilter ? { columnId: 'status', label: 'Filter by status', allLabel: 'All' } : undefined
      }
      selectable={selectable}
      bulkActions={
        selectable
          ? (context) => {
              const activeRows = context.rows.filter((row) => row.status === 'active');
              const skipped = context.rows.length - activeRows.length;
              return (
                <ActionForm action={bulkArchive} className="flex">
                  <input type="hidden" name="csrf" value={csrf.bulkArchive ?? ''} />
                  {activeRows.map((row) => (
                    <input key={row.id} type="hidden" name="id" value={row.id} />
                  ))}
                  <ConfirmSubmit
                    tone="warn"
                    title={`Archive ${activeRows.length} selected ${
                      activeRows.length === 1 ? 'memory' : 'memories'
                    }?`}
                    description={`${activeRows.length} active ${
                      activeRows.length === 1 ? 'memory' : 'memories'
                    } will stop appearing in active recall. ${skipped} non-active ${
                      skipped === 1 ? 'memory' : 'memories'
                    } will be skipped. The rows stay visible here and no content is deleted.`}
                    confirmLabel="ARCHIVE SELECTED"
                  >
                    <Button
                      type="button"
                      size="sm"
                      className="border-warn/40 bg-warn/10 text-warn hover:bg-warn/20 hover:text-warn"
                    >
                      Archive selected
                    </Button>
                  </ConfirmSubmit>
                </ActionForm>
              );
            }
          : undefined
      }
      renderDetail={(row) => (
        <div className="flex flex-col gap-3 px-2 py-1 text-xs">
          <p className="whitespace-pre-line leading-relaxed text-foreground">{row.content}</p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {row.type} · {row.confirms} confirms · {row.tags.length} tags
          </p>
        </div>
      )}
      rowActions={(row) => <MemoryRowMenu row={row} actions={actions} csrf={csrf} />}
      pageSize={pageSize}
    />
  );
}

function MemoryRowMenu({
  row,
  actions,
  csrf,
}: {
  row: MemoryRowData;
  actions: MemoryServerActions;
  csrf: MemoryCsrfTokens;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Actions for memory ${row.title}`}
          className="size-7 text-muted-foreground hover:text-foreground"
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 border-border bg-popover">
        <DropdownMenuItem asChild>
          <Link
            href={`/dashboard/memories/${row.id}`}
            className={cn(MENU_ITEM_ROOT, 'cursor-pointer')}
          >
            View details
          </Link>
        </DropdownMenuItem>
        {row.needsReview ? (
          <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
            <ActionForm action={actions.confirm} className={MENU_ITEM_ROOT}>
              <input type="hidden" name="csrf" value={csrf.confirm ?? ''} />
              <input type="hidden" name="id" value={row.id} />
              <ConfirmSubmit
                tone="warn"
                title="Re-affirm this memory?"
                description="Records a memory.confirm affirmation now, moving the row back to fresh past its per-type TTL. The content is unchanged."
                confirmLabel="CONFIRM MEMORY"
              >
                <Button type="button" variant="ghost" size="sm" className={MENU_ITEM_BUTTON}>
                  Confirm memory
                </Button>
              </ConfirmSubmit>
            </ActionForm>
          </DropdownMenuItem>
        ) : null}
        {row.status === 'active' ? (
          <>
            <DropdownMenuSeparator className="bg-border" />
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
                  title="Archive this memory?"
                  description="It will stop appearing in active recall. You can re-save the topic later to bring it back; the row is never deleted."
                  confirmLabel="ARCHIVE MEMORY"
                >
                  <Button type="button" variant="ghost" size="sm" className={MENU_ITEM_BUTTON}>
                    Archive memory
                  </Button>
                </ConfirmSubmit>
              </ActionForm>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
