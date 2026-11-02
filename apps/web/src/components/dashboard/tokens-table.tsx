'use client';

import type { Token } from '@rembric/db';
import { MoreHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import {
  useServerQuickFilter,
  type TableQuickFilterSpec,
} from '@/components/dashboard/quick-filter';
import { TokenRotationResult, type RotationState } from '@/components/dashboard/token-rotation';
import { Pill, Time } from '@/components/dashboard/ui';
import { DataTable, type DataTableColumn } from '@/components/spectrumui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const MENU_ITEM_ROOT = 'flex h-8 w-full items-center px-2';
const MENU_ITEM_BUTTON = 'h-full w-full justify-start px-0 text-sm font-normal';

export interface TokenRowData extends Pick<
  Token,
  'id' | 'name' | 'scope' | 'createdAt' | 'expiresAt'
> {
  readonly project: string;
  readonly state: string;
  readonly stateTone: 'lime' | 'amber' | 'danger' | 'dim';
  readonly revoked: boolean;
}

export interface TokenServerActions {
  rotate: (prevState: ActionState, formData: FormData) => Promise<RotationState>;
  promote: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  delete: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  revoke: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
  bulkRevoke: (prevState: ActionState, formData: FormData) => Promise<ActionState>;
}

export interface TokenCsrfTokens {
  readonly rotate: string | null;
  readonly promote: string | null;
  readonly delete: string | null;
  readonly revoke: string | null;
  readonly bulkRevoke: string | null;
}

export function TokensTable({
  rows,
  actions,
  csrf,
  selectable = false,
  toolbar,
  quickFilter,
  pageSize = 20,
}: {
  rows: readonly TokenRowData[];
  actions: TokenServerActions;
  csrf: TokenCsrfTokens;
  selectable?: boolean;
  toolbar?: React.ReactNode;
  quickFilter?: TableQuickFilterSpec;
  pageSize?: number;
}) {
  const quickFilterControl = useServerQuickFilter(quickFilter ?? null);
  const router = useRouter();
  const [rotation, setRotation] = useState<{
    name: string;
    plaintext: string;
    reauthenticate: boolean;
  } | null>(null);
  const generation = useRef(0);
  useLayoutEffect(() => {
    setRotation(null);
    const discard = () => {
      generation.current += 1;
      flushSync(() => setRotation(null));
    };
    window.addEventListener('pagehide', discard);
    return () => {
      window.removeEventListener('pagehide', discard);
      generation.current += 1;
      setRotation(null);
    };
  }, []);

  async function rotateInView(state: ActionState, data: FormData): Promise<RotationState> {
    const started = generation.current;
    const result = await actions.rotate(state, data);
    return started === generation.current
      ? result
      : {
          error:
            'Rotation result discarded after leaving this view. If needed, explicitly rotate again.',
        };
  }

  const columns: DataTableColumn<TokenRowData>[] = [
    {
      id: 'token',
      header: 'Token',
      sortable: true,
      value: (row) => row.name,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{row.name}</span>
            {row.scope === '*' ? <Badge variant="secondary">Admin</Badge> : null}
          </div>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {row.scope === '*'
              ? 'All projects · Server administration'
              : `${row.scope} · ${row.project}`}
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
    <>
      {rotation ? (
        <TokenRotationResult
          name={rotation.name}
          plaintext={rotation.plaintext}
          onDismiss={() => {
            const reauthenticate = rotation.reauthenticate;
            setRotation(null);
            if (reauthenticate) router.replace('/dashboard/login');
            else router.refresh();
          }}
        />
      ) : null}
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
        quickFilterControl={quickFilterControl ?? undefined}
        toolbar={toolbar}
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
        rowActions={(row) => (
          <TokenRowMenu
            row={row}
            actions={{ ...actions, rotate: rotateInView }}
            csrf={csrf}
            onRotated={setRotation}
          />
        )}
        pageSize={pageSize}
      />
    </>
  );
}

function TokenRowMenu({
  row,
  actions,
  csrf,
  onRotated,
}: {
  row: TokenRowData;
  actions: TokenServerActions;
  csrf: TokenCsrfTokens;
  onRotated: (result: { name: string; plaintext: string; reauthenticate: boolean }) => void;
}) {
  const submitted = useRef(false);
  const [rotating, setRotating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  async function rotate(state: ActionState, data: FormData): Promise<ActionState> {
    try {
      const result = await actions.rotate(state, data);
      if (result.error === null && result.plaintext) {
        setMenuOpen(false);
        onRotated({
          name: row.name,
          plaintext: result.plaintext,
          reauthenticate: result.reauthenticate === true,
        });
      }
      return { error: result.error };
    } catch {
      return {
        error:
          'Rotation could not be confirmed. The secret may have changed. Check your connection before explicitly rotating again.',
      };
    } finally {
      submitted.current = false;
      setRotating(false);
    }
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
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
        {row.state === 'active' ? (
          <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
            <ActionForm
              action={rotate}
              className={MENU_ITEM_ROOT}
              onSubmit={(event) => {
                if (submitted.current) {
                  event.preventDefault();
                  return;
                }
                submitted.current = true;
                setRotating(true);
              }}
            >
              <input type="hidden" name="csrf" value={csrf.rotate ?? ''} />
              <input type="hidden" name="id" value={row.id} />
              <ConfirmSubmit
                tone="danger"
                title={`Rotate token "${row.name}"?`}
                description="The previous secret will stop working immediately. Linked dashboard sessions and all OAuth codes, access and refresh tokens will be invalidated. Update clients with the replacement secret and reconnect. This cannot be undone."
                confirmLabel="Rotate token"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={MENU_ITEM_BUTTON}
                  disabled={rotating}
                >
                  {rotating ? 'Rotating…' : 'Rotate token'}
                </Button>
              </ConfirmSubmit>
            </ActionForm>
          </DropdownMenuItem>
        ) : null}
        {row.state === 'active' && row.scope !== '*' ? (
          <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
            <ActionForm action={actions.promote} className={MENU_ITEM_ROOT}>
              <input type="hidden" name="csrf" value={csrf.promote ?? ''} />
              <input type="hidden" name="id" value={row.id} />
              <ConfirmSubmit
                tone="danger"
                title={`Make token "${row.name}" administrator?`}
                description="Every holder of the existing secret gains full read/write access to every project, plus dashboard and server administration. The secret will not change. This cannot be undone here."
                confirmLabel="Make administrator"
              >
                <Button type="button" variant="ghost" size="sm" className={MENU_ITEM_BUTTON}>
                  Make administrator
                </Button>
              </ConfirmSubmit>
            </ActionForm>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          asChild
          onSelect={(event) => event.preventDefault()}
          className="text-destructive focus:text-destructive"
        >
          <ActionForm
            action={row.revoked ? actions.delete : actions.revoke}
            className={MENU_ITEM_ROOT}
          >
            <input
              type="hidden"
              name="csrf"
              value={(row.revoked ? csrf.delete : csrf.revoke) ?? ''}
            />
            <input
              type="hidden"
              name={row.revoked ? 'id' : 'name'}
              value={row.revoked ? row.id : row.name}
            />
            <ConfirmSubmit
              tone="danger"
              title={`${row.revoked ? 'Delete' : 'Revoke'} token "${row.name}"?`}
              description={
                row.revoked
                  ? 'This token will be removed from the list. Session and memory history will be retained. This cannot be undone.'
                  : 'This is IRREVERSIBLE. Any agent using this token will lose access immediately.'
              }
              confirmLabel={row.revoked ? 'Delete' : 'REVOKE TOKEN'}
            >
              <Button type="button" variant="ghost" size="sm" className={MENU_ITEM_BUTTON}>
                {row.revoked ? 'Delete' : 'Revoke token'}
              </Button>
            </ConfirmSubmit>
          </ActionForm>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
