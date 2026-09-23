'use client';

import Link from 'next/link';

import { Chip } from '@/components/dashboard/ui';
import { DataTable, type DataTableColumn } from '@/components/spectrumui/data-table';

export interface EntityRowData {
  readonly id: string;
  readonly kind: string;
  readonly value: string;
  readonly project: string;
  readonly linkCount: number;
}

export function EntitiesTable({ rows }: { rows: readonly EntityRowData[] }) {
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
      cell: (row) => <Chip>{row.kind}</Chip>,
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
      variant="panel"
      density="default"
      rowActions={(row) => (
        <Link
          href={`/dashboard/memories?q=${encodeURIComponent(row.value)}`}
          className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground hover:text-primary"
        >
          View memories →
        </Link>
      )}
    />
  );
}
