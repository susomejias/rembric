'use client';

import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { Pill, StatusPill, Time } from '@/components/dashboard/ui';
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

export interface JudgmentRowData {
  readonly id: string;
  readonly judgmentId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly sourceTitle: string;
  readonly targetTitle: string;
  readonly relation: string | null;
  readonly status: string;
  readonly actor: string | null;
  readonly kind: string | null;
  readonly createdAt: Date;
  readonly judgedAt: Date | null;
}

export interface JudgmentServerActions {
  orphan: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  bulkOrphan: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
}

export interface JudgmentCsrfTokens {
  readonly orphan: string | null;
  readonly bulkOrphan: string | null;
}

export function JudgmentsTable({
  rows,
  actions,
  csrf,
  quickFilter = false,
  selectable = false,
  searchable = false,
  pageSize = 10,
}: {
  rows: readonly JudgmentRowData[];
  actions: JudgmentServerActions;
  csrf: JudgmentCsrfTokens;
  quickFilter?: boolean;
  selectable?: boolean;
  searchable?: boolean;
  pageSize?: number;
}) {
  const columns: DataTableColumn<JudgmentRowData>[] = [
    {
      id: 'judgment',
      header: 'Judgment',
      sortable: true,
      value: (row) => row.sourceTitle,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <Link
            href={`/dashboard/memories/${row.sourceId}`}
            className="truncate text-sm font-medium text-foreground transition-colors hover:text-primary"
          >
            {row.sourceTitle}
          </Link>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            → {row.targetTitle}
          </span>
        </div>
      ),
    },
    {
      id: 'relation',
      header: 'Relation',
      sortable: true,
      value: (row) => row.relation ?? 'pending',
      cell: (row) => (
        <Pill tone={row.relation === null ? 'dim' : 'lime'}>{row.relation ?? 'pending'}</Pill>
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
      id: 'actor',
      header: 'Actor',
      hideBelow: 'lg',
      value: (row) => row.actor ?? '',
      cell: (row) => <span className="text-muted-foreground">{row.actor ?? '—'}</span>,
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
      id: 'judged',
      header: 'Judged',
      sortable: true,
      hideBelow: 'md',
      value: (row) => row.judgedAt?.getTime() ?? 0,
      cell: (row) => (
        <Time value={row.judgedAt} className="font-mono text-xs text-muted-foreground" />
      ),
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      rowId={(row) => row.id}
      rowLabel={(row) => `${row.sourceTitle} → ${row.targetTitle}`}
      caption="Judgments, pending and recently judged"
      searchable={searchable}
      searchPlaceholder="Search judgments…"
      searchText={(row) => `${row.sourceTitle} ${row.targetTitle} ${row.relation ?? 'pending'}`}
      variant="panel"
      density="default"
      emptyState={
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          NO JUDGMENT MATCHES THIS FILTER
        </div>
      }
      quickFilter={
        quickFilter
          ? { columnId: 'relation', label: 'Filter by relation', allLabel: 'All' }
          : undefined
      }
      selectable={selectable}
      bulkActions={
        selectable
          ? (context) => {
              const pendingRows = context.rows.filter((row) => row.status === 'pending');
              const skipped = context.rows.length - pendingRows.length;
              return (
                <ActionForm action={actions.bulkOrphan} className="flex">
                  <input type="hidden" name="csrf" value={csrf.bulkOrphan ?? ''} />
                  {pendingRows.map((row) => (
                    <input key={row.id} type="hidden" name="judgmentId" value={row.judgmentId} />
                  ))}
                  <ConfirmSubmit
                    tone="danger"
                    title={`Mark ${pendingRows.length} selected ${
                      pendingRows.length === 1 ? 'judgment' : 'judgments'
                    } as orphaned?`}
                    description={`${pendingRows.length} pending ${
                      pendingRows.length === 1 ? 'judgment' : 'judgments'
                    } will be removed from the queue and won't be re-judged automatically. ${skipped} non-pending ${
                      skipped === 1 ? 'judgment' : 'judgments'
                    } will be skipped.`}
                    confirmLabel="MARK ORPHANED"
                  >
                    <Button type="button" variant="destructive" size="sm">
                      Mark orphaned
                    </Button>
                  </ConfirmSubmit>
                </ActionForm>
              );
            }
          : undefined
      }
      renderDetail={(row) => (
        <div className="flex flex-col gap-3 px-2 py-1 text-xs">
          <p className="whitespace-pre-line leading-relaxed text-foreground">
            <span className="font-medium">{row.sourceTitle}</span>
            <span aria-hidden="true" className="px-1 text-muted-foreground">
              →
            </span>
            <span className="font-medium">{row.targetTitle}</span>
          </p>
          <p className="font-mono text-[10px] text-muted-foreground">
            relation: {row.relation ?? 'pending'} · actor: {row.actor ?? '—'} · kind:{' '}
            {row.kind ?? '—'}
          </p>
        </div>
      )}
      rowActions={(row) => <JudgmentRowMenu row={row} actions={actions} csrf={csrf} />}
      pageSize={pageSize}
    />
  );
}

function JudgmentRowMenu({
  row,
  actions,
  csrf,
}: {
  row: JudgmentRowData;
  actions: JudgmentServerActions;
  csrf: JudgmentCsrfTokens;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Actions for judgment ${row.sourceTitle}`}
          className="size-7 text-muted-foreground hover:text-foreground"
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 border-border bg-popover">
        <DropdownMenuItem asChild>
          <Link
            href={`/dashboard/judgments/${row.id}`}
            className={cn(MENU_ITEM_ROOT, 'cursor-pointer')}
          >
            View details
          </Link>
        </DropdownMenuItem>
        {row.status === 'pending' ? (
          <>
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              asChild
              onSelect={(event) => event.preventDefault()}
              className="text-destructive focus:text-destructive"
            >
              <ActionForm action={actions.orphan} className={MENU_ITEM_ROOT}>
                <input type="hidden" name="csrf" value={csrf.orphan ?? ''} />
                <input type="hidden" name="judgmentId" value={row.judgmentId} />
                <ConfirmSubmit
                  tone="danger"
                  title="Mark this judgment as orphaned?"
                  description="It will be removed from the pending queue and won't be re-judged automatically."
                  confirmLabel="MARK ORPHANED"
                >
                  <Button type="button" variant="ghost" size="sm" className={MENU_ITEM_BUTTON}>
                    Mark orphaned
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
