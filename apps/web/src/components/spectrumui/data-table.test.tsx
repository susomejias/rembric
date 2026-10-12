import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { DataTable } from './data-table';

function renderToolbar(toolbar: ReactNode) {
  return renderToStaticMarkup(
    <DataTable
      data={[]}
      columns={[{ id: 'name', header: 'Name' }]}
      rowId={(row: { id: string }) => row.id}
      toolbar={toolbar}
      animate={false}
    />,
  );
}

describe('DataTable toolbar', () => {
  it.each([false, true])(
    'renders an external search control without key warnings (array=%s)',
    (array) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const search = createElement('input', { type: 'search', 'aria-label': 'Search projects' });
        const html = renderToolbar(array ? [search] : search);

        expect(html).toContain('aria-label="Search projects"');
        const messages = error.mock.calls.flat().map(String).join(' ');
        expect(messages).not.toContain('Each child in a list should have a unique');
      } finally {
        error.mockRestore();
      }
    },
  );
});
