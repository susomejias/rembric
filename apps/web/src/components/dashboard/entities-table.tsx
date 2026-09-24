'use client';

import Link from 'next/link';

import { DataTable, type DataTableColumn } from '@/components/spectrumui/data-table';
import { cn } from '@/lib/utils';

function KindPill({ kind }: { kind: string }) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize',
        'border-border bg-input/60 text-muted-foreground',
      )}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
      {kind}
    </span>
  );
}

export interface EntityRowData {
  readonly id: string;
  readonly kind: string;
  readonly value: string;
  readonly project: string;
  readonly linkCount: number;
}

export function EntitiesTable({
  rows,
  quickFilter = false,
  searchable = false,
  pageSize,
}: {
  rows: readonly EntityRowData[];
  quickFilter?: boolean;
  searchable?: boolean;
  pageSize?: number;
}) {
  const columns: DataTableColumn<EntityRowData>[] = [
    {
      id: 'entity',
      header: 'Entity',
      sortable: true,
      value: (row) => row.value,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{row.value}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {row.linkCount} {row.linkCount === 1 ? 'link' : 'links'}
          </span>
        </div>
      ),
    },
    {
      id: 'kind',
      header: 'Kind',
      sortable: true,
      value: (row) => row.kind,
      cell: (row) => <KindPill kind={row.kind} />,
    },
    {
      id: 'project',
      header: 'Project',
      sortable: true,
      hideBelow: 'md',
      value: (row) => row.project,
      cell: (row) => <span className="text-muted-foreground">{row.project}</span>,
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      rowId={(row) => row.id}
      rowLabel={(row) => `${row.kind} entity — ${row.value}`}
      caption="Entities with kind, project and reference count"
      searchable={searchable}
      searchPlaceholder="Search entities…"
      searchText={(row) => `${row.value} ${row.kind} ${row.project}`}
      variant="panel"
      density="default"
      emptyState={
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">
          NO ENTITY MATCHES THIS FILTER
        </div>
      }
      quickFilter={
        quickFilter ? { columnId: 'kind', label: 'Filter by kind', allLabel: 'All' } : undefined
      }
      renderDetail={(row) => (
        <div className="flex flex-col gap-2 px-2 py-1 text-xs">
          <p className="font-mono text-[11px] text-foreground break-all">{row.value}</p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {`kind: ${row.kind} · project: ${row.project} · ${row.linkCount} ${
              row.linkCount === 1 ? 'memory' : 'memories'
            } · id: ${row.id}`}
          </p>
        </div>
      )}
      rowActions={(row) => (
        <Link
          href={`/dashboard/memories?q=${encodeURIComponent(row.value)}`}
          className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground hover:text-primary"
        >
          View memories →
        </Link>
      )}
      pageSize={pageSize}
    />
  );
}
