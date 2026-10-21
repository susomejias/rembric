import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { DetailExpand } from './detail-expand';

const state = vi.hoisted(() => ({ open: false, set: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useId: () => 'expand-test',
  useState: () => [state.open, state.set],
}));
describe('DetailExpand', () => {
  it('keeps complete data mounted but hidden until expansion, with an accessible button', () => {
    state.open = false;
    const node = DetailExpand({
      label: 'Show all 8 judgments',
      children: <a href="/record">Remaining record</a>,
    });
    const html = renderToStaticMarkup(node);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('hidden=""');
    expect(html).toContain('Remaining record');
    const children = (node as React.ReactElement<{ children: React.ReactNode[] }>).props.children;
    const button = children[0] as React.ReactElement<{ onClick: () => void }>;
    button.props.onClick();
    expect(state.set).toHaveBeenCalledWith(true);
    state.open = true;
    const expanded = renderToStaticMarkup(
      DetailExpand({
        label: 'Show all 8 judgments',
        children: <a href="/record">Remaining record</a>,
      }),
    );
    expect(expanded).not.toContain('hidden=""');
    expect(expanded).not.toContain('<button');
    expect(expanded).toContain('href="/record"');
  });
});
