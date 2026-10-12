import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OverviewRefreshButton } from './overview-refresh-button';

const state = vi.hoisted(() => ({
  pending: false,
  refresh: vi.fn(),
  transition: vi.fn((action: () => void) => action()),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: state.refresh }) }));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useTransition: () => [state.pending, state.transition],
}));

beforeEach(() => {
  state.pending = false;
  state.refresh.mockClear();
  state.transition.mockClear();
});

describe('OverviewRefreshButton', () => {
  it('refreshes through the router in a transition only when clicked', () => {
    const button = OverviewRefreshButton() as React.ReactElement<{ onClick: () => void }>;
    const html = renderToStaticMarkup(button);

    expect(html).toContain('aria-label="Refresh overview"');
    expect(html).toContain('type="button"');
    expect(html).not.toContain('animate-spin');
    expect(state.refresh).not.toHaveBeenCalled();
    button.props.onClick();
    expect(state.transition).toHaveBeenCalledOnce();
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it('disables repeated clicks and exposes busy feedback with reduced motion support', () => {
    state.pending = true;
    const html = renderToStaticMarkup(OverviewRefreshButton());

    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('animate-spin motion-reduce:animate-none');
  });
});
