'use client';

import Link from 'next/link';

import { ReviewPill, StatusPill, Time } from '@/components/dashboard/ui';
import { DataTable, type DataTableColumn } from '@/components/spectrumui/data-table';

export interface MemoryRowData {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly project: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date | null;
  readonly needsReview: boolean;
}

export function MemoriesTable({ rows }: { rows: readonly MemoryRowData[] }) {
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
      hideBelow: 'lg',
      value: (row) => row.lastSeenAt?.getTime() ?? null,
      cell: (row) => (
        <Time value={row.lastSeenAt} className="font-mono text-xs text-muted-foreground" />
      ),
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      rowId={(row) => row.id}
      rowLabel={(row) => `${row.type} memory — ${row.title}`}
      caption="Memories with status, creation and last-seen dates"
      variant="panel"
      density="default"
      emptyState={
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          NO MEMORY MATCHES THIS FILTER
        </div>
      }
    />
  );
}
