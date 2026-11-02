import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RotationState } from './token-rotation';
import { TokensTable, type TokenRowData, type TokenServerActions } from './tokens-table';

const hooks = vi.hoisted(() => ({
  setState: vi.fn(),
  effects: [] as (() => (() => void) | void)[],
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useState: (value: unknown) => [value, hooks.setState],
  useRef: (value: unknown) => ({ current: value }),
  useLayoutEffect: (effect: () => (() => void) | void) => hooks.effects.push(effect),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/dashboard/quick-filter', () => ({ useServerQuickFilter: () => null }));

beforeEach(() => {
  hooks.effects.length = 0;
  hooks.setState.mockClear();
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

function mount(rotate: () => Promise<RotationState>) {
  const action = () => Promise.resolve({ error: null });
  const element = TokensTable({
    rows: [],
    actions: { rotate, promote: action, delete: action, revoke: action, bulkRevoke: action },
    csrf: { rotate: null, promote: null, delete: null, revoke: null, bulkRevoke: null },
  }) as React.ReactElement<{ children: React.ReactNode[] }>;
  const table = element.props.children[1] as React.ReactElement<{
    rowActions: (row: TokenRowData) => React.ReactElement<{ actions: TokenServerActions }>;
  }>;
  const row: TokenRowData = {
    id: 'id',
    name: 'token',
    scope: '*',
    project: '—',
    state: 'active',
    stateTone: 'lime',
    revoked: false,
    createdAt: new Date(0),
    expiresAt: null,
  };
  const rotateInView = () =>
    table.props.rowActions(row).props.actions.rotate({ error: null }, new FormData());
  const cleanup = hooks.effects.map((effect) => effect());
  return { rotateInView, cleanup: () => cleanup.forEach((fn) => fn?.()) };
}

describe('rotation result view lifecycle', () => {
  it('clears retained state before painting an activated view', () => {
    mount(() => Promise.resolve({ error: null }));
    expect(hooks.setState).toHaveBeenCalledWith(null);
    hooks.setState.mockClear();
    hooks.effects.forEach((effect) => effect());
    expect(hooks.setState).toHaveBeenCalledWith(null);
  });

  it('discards secret state synchronously on pagehide and removes the listener on cleanup', () => {
    const view = mount(() => Promise.resolve({ error: null, plaintext: 'new-secret' }));
    hooks.setState.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    expect(hooks.setState).toHaveBeenCalledWith(null);
    view.cleanup();
    hooks.setState.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    expect(hooks.setState).not.toHaveBeenCalled();
  });

  it.each(['pagehide', 'cleanup'])(
    'discards a pending result after %s, but admits a fresh request',
    async (leave) => {
      let resolve!: (value: RotationState) => void;
      const pending = new Promise<RotationState>((done) => {
        resolve = done;
      });
      const view = mount(() => pending);
      const result = view.rotateInView();
      hooks.setState.mockClear();
      if (leave === 'pagehide') window.dispatchEvent(new Event('pagehide'));
      else view.cleanup();
      resolve({ error: null, plaintext: 'new-secret' });
      expect(await result).not.toHaveProperty('plaintext');
      expect(hooks.setState).toHaveBeenCalledWith(null);
      expect(await view.rotateInView()).toEqual({ error: null, plaintext: 'new-secret' });
    },
  );
});
