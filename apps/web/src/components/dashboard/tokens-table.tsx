'use client';

import { MoreHorizontal } from 'lucide-react';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { Pill, Time } from '@/components/dashboard/ui';
import { DataTable, type DataTableColumn } from '@/components/spectrumui/data-table';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const MENU_ITEM_ROOT = 'flex h-8 w-full items-center px-2';
const MENU_ITEM_BUTTON = 'h-full w-full justify-start px-0 text-sm font-normal';

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
  bulkRevoke: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
}

export interface TokenCsrfTokens {
  readonly revoke: string | null;
  readonly bulkRevoke: string | null;
}

export function TokensTable({
  rows,
  actions,
  csrf,
  quickFilter = true,
  selectable = false,
  searchable = false,
  pageSize = 10,
}: {
  rows: readonly TokenRowData[];
  actions: TokenServerActions;
  csrf: TokenCsrfTokens;
  quickFilter?: boolean;
  selectable?: boolean;
  searchable?: boolean;
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
      searchable={searchable}
      searchPlaceholder="Search tokens…"
      searchText={(row) => `${row.name} ${row.scope} ${row.project}`}
      emptyState={
        <div className="px-5 py-10 text-center text-sm text-muted-foreground">No tokens yet.</div>
      }
      quickFilter={
        quickFilter ? { columnId: 'state', label: 'Filter by state', allLabel: 'All' } : undefined
      }
      selectable={selectable}
      clipboard={false}
      bulkActions={
        selectable
          ? (context) => {
              const revocable = context.rows.filter((row) => !row.revoked);
              const skipped = context.rows.length - revocable.length;
              return (
                <ActionForm action={actions.bulkRevoke} className="flex">
                  <input type="hidden" name="csrf" value={csrf.bulkRevoke ?? ''} />
                  {revocable.map((row) => (
                    <input key={row.id} type="hidden" name="name" value={row.name} />
                  ))}
                  <ConfirmSubmit
                    tone="danger"
                    title={`Revoke ${revocable.length} selected ${
                      revocable.length === 1 ? 'token' : 'tokens'
                    }?`}
                    description={`${revocable.length} ${
                      revocable.length === 1 ? 'token' : 'tokens'
                    } will be revoked. This is IRREVERSIBLE — any agent using ${
                      revocable.length === 1 ? 'it' : 'them'
                    } will lose access immediately. ${skipped} already-revoked ${
                      skipped === 1 ? 'token' : 'tokens'
                    } will be skipped.`}
                    confirmLabel="REVOKE SELECTED"
                  >
                    <Button type="button" variant="destructive" size="sm">
                      Revoke selected
                    </Button>
                  </ConfirmSubmit>
                </ActionForm>
              );
            }
          : undefined
      }
      rowActions={(row) => <TokenRowMenu row={row} actions={actions} csrf={csrf} />}
      pageSize={pageSize}
    />
  );
}

function TokenRowMenu({
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Actions for token ${row.name}`}
          className="size-7 text-muted-foreground hover:text-foreground"
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 border-border bg-popover">
        <DropdownMenuItem
          asChild
          onSelect={(event) => event.preventDefault()}
          className="text-destructive focus:text-destructive"
        >
          <ActionForm action={actions.revoke} className={MENU_ITEM_ROOT}>
            <input type="hidden" name="csrf" value={csrf.revoke ?? ''} />
            <input type="hidden" name="name" value={row.name} />
            <ConfirmSubmit
              tone="danger"
              title={`Revoke token "${row.name}"?`}
              description="This is IRREVERSIBLE. Any agent using this token will lose access immediately."
              confirmLabel="REVOKE TOKEN"
            >
              <Button type="button" variant="ghost" size="sm" className={MENU_ITEM_BUTTON}>
                Revoke token
              </Button>
            </ConfirmSubmit>
          </ActionForm>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
