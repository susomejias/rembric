'use client';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { Pill, Time } from '@/components/dashboard/ui';
import { DataTable, type DataTableColumn } from '@/components/spectrumui/data-table';
import { Button } from '@/components/ui/button';

export interface TokenRowData {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly project: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly state: string;
  readonly stateTone: 'lime' | 'amber' | 'danger' | 'dim';
  readonly revoked: boolean;
}

export interface TokenServerActions {
  revoke: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
}

export interface TokenCsrfTokens {
  readonly revoke: string | null;
}

export function TokensTable({
  rows,
  actions,
  csrf,
  pageSize = 10,
}: {
  rows: readonly TokenRowData[];
  actions: TokenServerActions;
  csrf: TokenCsrfTokens;
  pageSize?: number;
}) {
  const columns: DataTableColumn<TokenRowData>[] = [
    {
      id: 'token',
      header: 'Token',
      sortable: true,
      value: (row) => row.name,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{row.name}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {row.scope} · {row.project}
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
    {
      id: 'expires',
      header: 'Expires',
      sortable: true,
      hideBelow: 'md',
      value: (row) => row.expiresAt?.getTime() ?? 0,
      cell: (row) => (
        <Time value={row.expiresAt} className="font-mono text-xs text-muted-foreground" />
      ),
    },
    {
      id: 'state',
      header: 'State',
      sortable: true,
      value: (row) => row.state,
      cell: (row) => <Pill tone={row.stateTone}>{row.state}</Pill>,
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      rowId={(row) => row.id}
      rowLabel={(row) => `token ${row.name}`}
      caption="Access tokens with scope, expiry and revocation state"
      variant="panel"
      density="default"
      emptyState={
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">No tokens yet.</div>
      }
      quickFilter={{ columnId: 'state', label: 'Filter by state', allLabel: 'All' }}
      rowActions={(row) => <TokenRowActions row={row} actions={actions} csrf={csrf} />}
      pageSize={pageSize}
    />
  );
}

function TokenRowActions({
  row,
  actions,
  csrf,
}: {
  row: TokenRowData;
  actions: TokenServerActions;
  csrf: TokenCsrfTokens;
}) {
  if (row.revoked) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <ActionForm action={actions.revoke}>
      <input type="hidden" name="csrf" value={csrf.revoke ?? ''} />
      <input type="hidden" name="name" value={row.name} />
      <ConfirmSubmit
        tone="danger"
        title={`Revoke token "${row.name}"?`}
        description="This is IRREVERSIBLE. Any agent using this token will lose access immediately."
        confirmLabel="REVOKE TOKEN"
      >
        <Button type="button" variant="destructive" size="sm">
          Revoke
        </Button>
      </ConfirmSubmit>
    </ActionForm>
  );
}
