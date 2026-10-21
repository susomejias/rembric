import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DetailCopy } from './detail-copy';

const state = vi.hoisted(() => ({ value: 'idle', set: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useState: () => [state.value, state.set],
}));
afterEach(() => {
  vi.unstubAllGlobals();
  state.value = 'idle';
  state.set.mockClear();
});
describe('DetailCopy', () => {
  it('reuses the clipboard control with the existing panel label', () => {
    const html = renderToStaticMarkup(DetailCopy({ text: 'body', label: 'Copy markdown' }));
    expect(html).toContain('aria-label="Copy markdown"');
    expect(html).toContain('>Copy markdown</span>');
  });
  it('copies the exact supplied markdown through the clipboard boundary', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const node = DetailCopy({ text: '# A title\n\nFull **body**' }) as React.ReactElement<{
      onClick: () => void;
    }>;
    expect(renderToStaticMarkup(node)).toContain('aria-label="Copy"');
    node.props.onClick();
    await vi.waitFor(() => expect(state.set).toHaveBeenCalledWith('copied'));
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith('# A title\n\nFull **body**');
    expect(state.set).toHaveBeenCalledWith('copied');
  });
  it('reports clipboard rejection instead of claiming success or throwing', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const node = DetailCopy({ text: 'body' }) as React.ReactElement<{
      onClick: () => void;
    }>;
    node.props.onClick();
    await vi.waitFor(() => expect(state.set).toHaveBeenCalledWith('error'));
    state.value = 'error';
    expect(renderToStaticMarkup(DetailCopy({ text: 'body' }))).toContain('Copy failed');
    expect(state.set).not.toHaveBeenCalledWith('copied');
  });
});
