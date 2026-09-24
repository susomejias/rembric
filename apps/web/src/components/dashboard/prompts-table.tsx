'use client';

import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { shortId } from '@/components/dashboard/support';
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

export interface PromptRowData {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly project: string;
  readonly sessionId: string | null;
  readonly agent: string;
  readonly tags: readonly string[];
  readonly status: string;
  readonly createdAt: Date;
  readonly deleted: boolean;
}

export interface PromptServerActions {
  remove: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  restore: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  bulkRemove: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
}

export interface PromptCsrfTokens {
  readonly remove: string | null;
  readonly restore: string | null;
  readonly bulkRemove: string | null;
}

export function PromptsTable({
  rows,
  actions,
  csrf,
  quickFilter = false,
  selectable = false,
  searchable = false,
  pageSize,
}: {
  rows: readonly PromptRowData[];
  actions: PromptServerActions;
  csrf: PromptCsrfTokens;
  quickFilter?: boolean;
  selectable?: boolean;
  searchable?: boolean;
  pageSize?: number;
}) {
  const columns: DataTableColumn<PromptRowData>[] = [
    {
      id: 'prompt',
      header: 'Prompt',
      sortable: true,
      value: (row) => row.title,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{row.title}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {row.project} · <Time value={row.createdAt} />
          </span>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      value: (row) => row.status,
      cell: (row) => <Pill tone={row.status === 'deleted' ? 'dim' : 'lime'}>{row.status}</Pill>,
    },
    {
      id: 'session',
      header: 'Session',
      sortable: true,
      hideBelow: 'md',
      value: (row) => row.sessionId ?? '',
      cell: (row) =>
        row.sessionId ? (
          <Link
            href={`/dashboard/sessions/${row.sessionId}`}
            className="font-mono text-xs text-muted-foreground hover:text-primary"
          >
            {shortId(row.sessionId)}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      rowId={(row) => row.id}
      rowLabel={(row) => `prompt ${row.title}`}
      caption="Captured prompts with scope, session and status"
      searchable={searchable}
      searchPlaceholder="Search prompts…"
      searchText={(row) =>
        `${row.title} ${row.content} ${row.project} ${row.agent} ${row.tags.join(' ')} ${
          row.sessionId ?? ''
        }`
      }
      variant="panel"
      density="default"
      emptyState={
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          NO PROMPT MATCHES THIS FILTER
        </div>
      }
      quickFilter={
        quickFilter ? { columnId: 'status', label: 'Filter by status', allLabel: 'All' } : undefined
      }
      selectable={selectable}
      bulkActions={
        selectable
          ? (context) => (
              <ActionForm action={actions.bulkRemove} className="flex">
                <input type="hidden" name="csrf" value={csrf.bulkRemove ?? ''} />
                {context.ids.map((id) => (
                  <input key={id} type="hidden" name="id" value={id} />
                ))}
                <ConfirmSubmit
                  tone="danger"
                  title={`Soft-delete ${context.ids.length} selected ${
                    context.ids.length === 1 ? 'prompt' : 'prompts'
                  }?`}
                  description="They are hidden from default lists, memory.context.recentPrompts, and memory.search_prompts; restorable from the deleted view."
                  confirmLabel="DELETE SELECTED"
                >
                  <Button type="button" variant="destructive" size="sm">
                    Delete selected
                  </Button>
                </ConfirmSubmit>
              </ActionForm>
            )
          : undefined
      }
      renderDetail={(row) => (
        <div className="flex flex-col gap-3 px-2 py-1 text-xs">
          <p className="whitespace-pre-line leading-relaxed text-foreground">{row.content}</p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {row.agent} · {row.tags.length > 0 ? row.tags.join(' · ') : 'no tags'}
          </p>
        </div>
      )}
      rowActions={(row) => <PromptRowMenu row={row} actions={actions} csrf={csrf} />}
      pageSize={pageSize}
    />
  );
}

function PromptRowMenu({
  row,
  actions,
  csrf,
}: {
  row: PromptRowData;
  actions: PromptServerActions;
  csrf: PromptCsrfTokens;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Actions for prompt ${row.title}`}
          className="size-7 text-muted-foreground hover:text-foreground"
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 border-border bg-popover">
        {row.deleted ? (
          <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
            <ActionForm action={actions.restore} className={MENU_ITEM_ROOT}>
              <input type="hidden" name="csrf" value={csrf.restore ?? ''} />
              <input type="hidden" name="id" value={row.id} />
              <Button type="submit" variant="ghost" size="sm" className={MENU_ITEM_BUTTON}>
                Undelete prompt
              </Button>
            </ActionForm>
          </DropdownMenuItem>
        ) : (
          <>
            {row.sessionId ? (
              <DropdownMenuItem asChild>
                <Link
                  href={`/dashboard/sessions/${row.sessionId}`}
                  className={cn(MENU_ITEM_ROOT, 'cursor-pointer')}
                >
                  View details
                </Link>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              asChild
              onSelect={(event) => event.preventDefault()}
              className="text-destructive focus:text-destructive"
            >
              <ActionForm action={actions.remove} className={MENU_ITEM_ROOT}>
                <input type="hidden" name="csrf" value={csrf.remove ?? ''} />
                <input type="hidden" name="id" value={row.id} />
                <ConfirmSubmit
                  tone="danger"
                  title="Soft-delete this prompt?"
                  description="It is hidden from default lists, memory.context.recentPrompts, and memory.search_prompts; restorable via the Undelete action."
                  confirmLabel="DELETE PROMPT"
                >
                  <Button type="button" variant="ghost" size="sm" className={MENU_ITEM_BUTTON}>
                    Delete prompt
                  </Button>
                </ConfirmSubmit>
              </ActionForm>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
