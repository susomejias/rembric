'use client';

import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { StatusPill, Time } from '@/components/dashboard/ui';
import { DataTable, type DataTableColumn } from '@/components/spectrumui/data-table';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface SessionRowData {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly agent: string;
  readonly project: string;
  readonly token: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly durationMs: number;
  readonly status: string;
  readonly memories: number;
  readonly prompts: number;
  readonly deleted: boolean;
}

/** Daily memory-write counts for one session, oldest slot first, today last. */
export type SessionSparklines = Record<string, number[]>;

export interface SessionServerActions {
  abandon: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  remove: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  restore: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
}

export interface SessionCsrfTokens {
  readonly abandon: string | null;
  readonly remove: string | null;
  readonly restore: string | null;
}

export function SessionsTable({
  rows,
  memoryCounts,
  promptCounts,
  sparklines,
  actions,
  csrf,
  quickFilter = false,
  selectable = false,
  searchable = false,
  pageSize,
}: {
  rows: readonly SessionRowData[];
  memoryCounts: Record<string, number>;
  promptCounts: Record<string, number>;
  sparklines?: SessionSparklines;
  actions: SessionServerActions;
  csrf: SessionCsrfTokens;
  quickFilter?: boolean;
  selectable?: boolean;
  searchable?: boolean;
  pageSize?: number;
}) {
  const router = useRouter();

  const columns: DataTableColumn<SessionRowData>[] = [
    {
      id: 'session',
      header: 'Session',
      sortable: true,
      value: (row) => row.title,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{row.title}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {row.agent} · {row.project}
          </span>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      value: (row) => row.status,
      cell: (row) => <StatusPill status={row.status} />,
    },
    {
      id: 'duration',
      header: 'Duration',
      sortable: true,
      value: (row) => row.durationMs,
      cell: (row) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default font-mono text-xs tabular-nums text-muted-foreground">
              {formatDuration(row.durationMs)}
            </span>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            sideOffset={8}
            collisionPadding={16}
            className="flex flex-col items-stretch gap-0.5 rounded-lg border border-border bg-popover px-3 py-2 text-left text-foreground shadow-lg shadow-black/40 [&>svg]:hidden"
          >
            <span className="whitespace-nowrap text-xs text-foreground">
              Started <Time value={row.startedAt} />
            </span>
            {row.endedAt ? (
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                Ended <Time value={row.endedAt} />
              </span>
            ) : (
              <span className="whitespace-nowrap text-xs text-primary">Active now</span>
            )}
          </TooltipContent>
        </Tooltip>
      ),
    },
    {
      id: 'memories',
      header: 'Memories',
      numeric: true,
      sortable: true,
      value: (row) => row.memories,
      cell: (row) => {
        const sparkline = sparklines?.[row.id];
        return (
          <div className="flex min-w-0 flex-col items-end gap-1">
            <span>{memoryCounts[row.id] ?? row.memories}</span>
            {sparkline ? <SessionSparkline values={sparkline} /> : null}
          </div>
        );
      },
      formatTotal: (sum) => sum.toLocaleString('en-US'),
    },
    {
      id: 'prompts',
      header: 'Prompts',
      numeric: true,
      hideBelow: 'md',
      value: (row) => row.prompts,
      cell: (row) => promptCounts[row.id] ?? row.prompts,
    },
  ];

  const deleteIds = (ids: string[]) => {
    for (const id of ids) {
      const formData = new FormData();
      formData.set('id', id);
      void actions.remove({ error: null }, formData);
    }
    router.refresh();
  };

  return (
    <TooltipProvider delayDuration={100}>
      <DataTable
        data={rows}
        columns={columns}
        rowId={(row) => row.id}
        rowLabel={(row) => `${row.agent} session — ${row.title}`}
        caption="Agent sessions with status, memory and prompt counts"
        searchable={searchable}
        searchPlaceholder="Search sessions…"
        searchText={(row) => `${row.title} ${row.agent} ${row.project} ${row.token}`}
        variant="panel"
        density="default"
        emptyState={
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            NO SESSION MATCHES THIS FILTER
          </div>
        }
        quickFilter={
          quickFilter
            ? { columnId: 'status', label: 'Filter by status', allLabel: 'All' }
            : undefined
        }
        selectable={selectable}
        bulkActions={
          selectable
            ? (context) => (
                <ConfirmSubmit
                  tone="danger"
                  title={`Soft-delete ${context.ids.length} selected sessions?`}
                  description="Their memories stay queryable but the sessions are hidden from the list. You can restore them from the deleted view."
                  confirmLabel="DELETE SELECTED"
                >
                  <Button type="button" variant="destructive" size="sm">
                    Delete selected
                  </Button>
                </ConfirmSubmit>
              )
            : undefined
        }
        onDelete={
          selectable
            ? (ids) => {
                deleteIds(ids);
              }
            : undefined
        }
        renderDetail={(row) =>
          row.deleted ? null : (
            <div className="flex flex-col gap-2 px-2 py-1 text-xs">
              <p className="whitespace-pre-line leading-relaxed text-muted-foreground">
                {row.description ?? 'No description was captured for this session.'}
              </p>
              <p className="font-mono text-[10px] text-muted-foreground">
                token: {row.token} · {row.memories} memories · {row.prompts} prompts
              </p>
            </div>
          )
        }
        rowActions={(row) => <SessionRowMenu row={row} actions={actions} csrf={csrf} />}
        pageSize={pageSize}
      />
    </TooltipProvider>
  );
}

function SessionSparkline({ values }: { values: readonly number[] }) {
  const peak = Math.max(1, ...values);
  const last = values.length - 1;
  return (
    <span aria-hidden="true" className="flex h-3.5 w-[52px] items-end gap-px">
      {values.map((value, index) => (
        <span
          key={index}
          style={{ height: `${value === 0 ? 2 : Math.max(3, Math.round((value / peak) * 14))}px` }}
          className={cn(
            'min-w-0 flex-1 rounded-[1px]',
            index === last ? 'bg-primary' : 'bg-primary/50',
          )}
        />
      ))}
    </span>
  );
}

function SessionRowMenu({
  row,
  actions,
  csrf,
}: {
  row: SessionRowData;
  actions: SessionServerActions;
  csrf: SessionCsrfTokens;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Actions for session ${row.title}`}
          className="size-7 text-muted-foreground hover:text-foreground"
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 border-border bg-popover">
        {row.deleted ? (
          <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
            <ActionForm action={actions.restore} className="flex w-full">
              <input type="hidden" name="csrf" value={csrf.restore ?? ''} />
              <input type="hidden" name="id" value={row.id} />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
              >
                Undelete session
              </Button>
            </ActionForm>
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem asChild>
              <Link
                href={`/dashboard/sessions/${row.id}`}
                className="h-8 w-full cursor-pointer items-center px-2"
              >
                View details
              </Link>
            </DropdownMenuItem>
            {row.status === 'active' ? (
              <DropdownMenuItem
                asChild
                onSelect={(event) => event.preventDefault()}
                className="text-warn focus:text-warn"
              >
                <ActionForm action={actions.abandon} className="flex w-full">
                  <input type="hidden" name="csrf" value={csrf.abandon ?? ''} />
                  <input type="hidden" name="id" value={row.id} />
                  <ConfirmSubmit
                    tone="warn"
                    title="Mark this session as abandoned?"
                    description="Its memories stay queryable and the row stays visible in the list. This transition is not reversible from the dashboard."
                    confirmLabel="ABANDON SESSION"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-full justify-start px-2 font-normal"
                    >
                      Abandon session
                    </Button>
                  </ConfirmSubmit>
                </ActionForm>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              asChild
              onSelect={(event) => event.preventDefault()}
              className="text-destructive focus:text-destructive"
            >
              <ActionForm action={actions.remove} className="flex w-full">
                <input type="hidden" name="csrf" value={csrf.remove ?? ''} />
                <input type="hidden" name="id" value={row.id} />
                <ConfirmSubmit
                  tone="danger"
                  title="Soft-delete this session?"
                  description="Its memories stay queryable but the session is hidden from the list. You can restore it from the deleted view."
                  confirmLabel="DELETE SESSION"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start font-normal"
                  >
                    Delete session
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

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const seconds = Math.floor((ms % 60_000) / 1000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}
