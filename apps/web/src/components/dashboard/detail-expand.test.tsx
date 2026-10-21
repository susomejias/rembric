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
  it('shows compact milestones only while collapsed and retains the complete expandable sequence', () => {
    state.open = false;
    const props = {
      label: 'Show 97 more events',
      collapsedContent: <span>Compact milestones</span>,
      children: (
        <ol>
          <li>Started</li>
          <li>Middle capture</li>
          <li>Ended</li>
        </ol>
      ),
    };
    const closed = renderToStaticMarkup(DetailExpand(props));
    expect(closed).toContain('Compact milestones');
    expect(closed).toContain('Middle capture');
    expect(closed).toContain('hidden=""');
    state.open = true;
    const expanded = renderToStaticMarkup(DetailExpand(props));
    expect(expanded).not.toContain('Compact milestones');
    expect(expanded).not.toContain('hidden=""');
    expect(expanded).not.toContain('<button');
    expect(expanded).toContain('Middle capture');
  });
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
