import type * as Radix from 'radix-ui';
import { cloneElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type * as Confirmation from './confirm-submit';
import { TokensTable, type TokenRowData } from './tokens-table';

vi.mock('@/components/dashboard/quick-filter', () => ({ useServerQuickFilter: () => null }));
vi.mock('@/components/spectrumui/data-table', () => ({
  DataTable: ({
    data,
    rowActions,
  }: {
    data: TokenRowData[];
    rowActions: (row: TokenRowData) => ReactNode;
  }) => (
    <>
      {data.map((row) => (
        <div key={row.id}>{rowActions(row)}</div>
      ))}
    </>
  ),
}));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/dashboard/confirm-submit', async (original) => {
  const mod = await original<typeof Confirmation>();
  return {
    ConfirmSubmit: (props: ComponentProps<typeof mod.ConfirmSubmit>) =>
      cloneElement(mod.ConfirmSubmit(props), { defaultOpen: true }),
  };
});
vi.mock('radix-ui', async (original) => {
  const radix = await original<typeof Radix>();
  return {
    ...radix,
    AlertDialog: {
      ...radix.AlertDialog,
      Portal: ({ children }: { children: ReactNode }) => children,
    },
  };
});

const action = () => Promise.resolve({ error: null });
function markup(revoked: boolean, state: string): string {
  return renderToStaticMarkup(
    <TokensTable
      rows={[
        {
          id: 'immutable-id',
          name: 'token-name',
          scope: '*',
          project: '—',
          createdAt: new Date(0),
          expiresAt: null,
          state,
          stateTone: 'dim',
          revoked,
        },
      ]}
      actions={{ delete: action, revoke: action, bulkRevoke: action }}
      csrf={{ delete: 'delete-csrf', revoke: 'revoke-csrf', bulkRevoke: null }}
    />,
  );
}

describe('token deletion confirmation wiring', () => {
  it('offers a danger confirmation with immutable ID, retained-history warning and non-submit Cancel', () => {
    const html = markup(true, 'revoked');
    expect(html.match(/>Delete<\/button>/g)).toHaveLength(2);
    expect(html).not.toContain('>Delete token</button>');
    expect(html).not.toContain('DELETE TOKEN');
    expect(html).toContain('name="id" value="immutable-id"');
    expect(html).toContain('value="delete-csrf"');
    expect(html).toContain('Session and memory history will be retained');
    expect(html).toContain('role="alertdialog"');
    expect(html).toMatch(/type="button"[^>]*data-slot="alert-dialog-cancel"/);
    expect(html).toMatch(
      /type="submit"[^>]*data-slot="alert-dialog-action"[^>]*data-variant="destructive"/,
    );
    expect(html).not.toContain('Revoke token');
  });

  it.each(['active', 'expired'])('offers only revocation for unrevoked %s tokens', (state) => {
    const html = markup(false, state);
    expect(html).toContain('Revoke token');
    expect(html).toContain('value="revoke-csrf"');
    expect(html).not.toContain('>Delete</button>');
    expect(html).not.toContain('DELETE TOKEN');
  });
});
