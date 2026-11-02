import type * as Radix from 'radix-ui';
import { cloneElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type * as Forms from './action-form';
import type * as Confirmation from './confirm-submit';
import { TokensTable, type TokenRowData } from './tokens-table';

import type { DataTableColumn } from '@/components/spectrumui/data-table';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));

const renderedActions = vi.hoisted(() => [] as unknown[]);
vi.mock('@/components/dashboard/action-form', async (original) => {
  const mod = await original<typeof Forms>();
  return {
    ...mod,
    ActionForm: (props: ComponentProps<typeof mod.ActionForm>) => {
      renderedActions.push(props.action);
      return <mod.ActionForm {...props} />;
    },
  };
});
vi.mock('@/components/dashboard/quick-filter', () => ({ useServerQuickFilter: () => null }));
vi.mock('@/components/spectrumui/data-table', () => ({
  DataTable: ({
    data,
    columns,
    rowActions,
  }: {
    data: TokenRowData[];
    columns: DataTableColumn<TokenRowData>[];
    rowActions: (row: TokenRowData) => ReactNode;
  }) => (
    <>
      {data.map((row, index) => (
        <div key={row.id}>
          {columns.map((column) => (
            <div key={column.id}>{column.cell?.(row, index)}</div>
          ))}
          {rowActions(row)}
        </div>
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
const promote = () => Promise.resolve({ error: null });
const rotate = () => Promise.resolve({ error: null });
function markup(revoked: boolean, state: string, scope = '*'): string {
  renderedActions.length = 0;
  return renderToStaticMarkup(
    <TokensTable
      rows={[
        {
          id: 'immutable-id',
          name: 'token-name',
          scope,
          project: '—',
          createdAt: new Date(0),
          expiresAt: null,
          state,
          stateTone: 'dim',
          revoked,
        },
      ]}
      actions={{ delete: action, revoke: action, bulkRevoke: action, promote, rotate }}
      csrf={{
        delete: 'delete-csrf',
        revoke: 'revoke-csrf',
        bulkRevoke: null,
        promote: 'promotion-csrf',
        rotate: 'rotation-csrf',
      }}
    />,
  );
}

describe('token administrator label', () => {
  it('labels administrator authority independently from lifecycle state', () => {
    for (const state of ['active', 'revoked', 'expired']) {
      const html = markup(state === 'revoked', state);
      expect(html).toContain('>Admin</span>');
      expect(html).toContain('All projects · Server administration');
      expect(html).not.toContain('* · —');
    }
  });

  it.each(['read:*', 'projects', 'read:projects', 'project:alpha'])(
    'does not label %s as administrator',
    (scope) => {
      const html = markup(false, 'active', scope);
      expect(html).not.toContain('>Admin</span>');
      expect(html).toContain(`${scope} · —`);
    },
  );
});

describe('token promotion confirmation wiring', () => {
  it('offers active nonadmins an ID-only danger confirmation naming the target and every secret holder', () => {
    const html = markup(false, 'active', 'read:*');
    expect(html.match(/>Make administrator<\/button>/g)).toHaveLength(2);
    expect(html).toContain('token-name');
    expect(html).toContain('name="id" value="immutable-id"');
    expect(html).toContain('value="promotion-csrf"');
    expect(renderedActions).toContain(promote);
    expect(html).toContain('Every holder of the existing secret');
    expect(html).toContain('full read/write access to every project');
    expect(html).toContain('dashboard and server administration');
    expect(html).toMatch(/type="button"[^>]*data-slot="alert-dialog-cancel"/);
    expect(html).toContain('CANCEL');
    expect(html).toMatch(
      /type="submit"[^>]*data-slot="alert-dialog-action"[^>]*data-variant="destructive"/,
    );
  });

  it.each(['revoked', 'expired', 'inert', 'no projects', 'deleted'])(
    'never offers promotion for %s rows',
    (state) => {
      expect(markup(state === 'revoked', state, 'projects')).not.toContain('Make administrator');
    },
  );

  it('never offers promotion for current administrators', () => {
    expect(markup(false, 'active')).not.toContain('Make administrator');
  });
});

describe('token rotation confirmation wiring', () => {
  it.each(['*', 'read:*'])('offers active %s an ID-only danger confirmation', (scope) => {
    const html = markup(false, 'active', scope);
    expect(html).toContain('Rotate token');
    expect(html).toContain('Rotate token &quot;token-name&quot;?');
    expect(html).toContain('value="rotation-csrf"');
    expect(html).toContain('name="id" value="immutable-id"');
    expect(renderedActions).toHaveLength(scope === '*' ? 2 : 3);
    expect(html).toContain('dashboard sessions');
    expect(html).toContain('OAuth');
    expect(html).toContain('reconnect');
    expect(html).toContain('CANCEL');
  });

  it.each(['revoked', 'expired', 'inert', 'no projects', 'deleted'])(
    'never offers rotation for %s rows',
    (state) => expect(markup(state === 'revoked', state)).not.toContain('Rotate token'),
  );
});

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
