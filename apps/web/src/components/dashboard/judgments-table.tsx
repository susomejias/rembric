'use client';

import Link from 'next/link';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { Pill, StatusPill, Time } from '@/components/dashboard/ui';
import { DataTable, type DataTableColumn } from '@/components/spectrumui/data-table';
import { Button } from '@/components/ui/button';

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
  readonly createdAt: Date;
  readonly judgedAt: Date | null;
}

export interface JudgmentServerActions {
  orphan: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
}

export interface JudgmentCsrfTokens {
  readonly orphan: string | null;
}

export function JudgmentsTable({
  rows,
  actions,
  csrf,
  pageSize = 10,
}: {
  rows: readonly JudgmentRowData[];
  actions: JudgmentServerActions;
  csrf: JudgmentCsrfTokens;
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
      variant="panel"
      density="default"
      emptyState={
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          NO JUDGMENT MATCHES THIS FILTER
        </div>
      }
      quickFilter={{ columnId: 'relation', label: 'Filter by relation', allLabel: 'All' }}
      rowActions={(row) => <JudgmentRowActions row={row} actions={actions} csrf={csrf} />}
      pageSize={pageSize}
    />
  );
}

function JudgmentRowActions({
  row,
  actions,
  csrf,
}: {
  row: JudgmentRowData;
  actions: JudgmentServerActions;
  csrf: JudgmentCsrfTokens;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link
        href={`/dashboard/judgments/${row.id}`}
        className="font-mono text-[11px] uppercase tracking-[.14em] hover:text-primary"
      >
        View →
      </Link>
      {row.status === 'pending' ? (
        <ActionForm action={actions.orphan}>
          <input type="hidden" name="csrf" value={csrf.orphan ?? ''} />
          <input type="hidden" name="judgmentId" value={row.judgmentId} />
          <ConfirmSubmit
            tone="danger"
            title="Mark this judgment as orphaned?"
            description="It will be removed from the pending queue and won't be re-judged automatically."
            confirmLabel="MARK ORPHANED"
          >
            <Button type="button" variant="outline" size="sm">
              Mark orphaned
            </Button>
          </ConfirmSubmit>
        </ActionForm>
      ) : null}
    </div>
  );
}
