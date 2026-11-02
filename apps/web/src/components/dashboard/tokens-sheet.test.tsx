import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { CreateTokenSheet } from './tokens-sheet';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/ui/sheet', () => {
  const children = ({ children }: { children: ReactNode }) => children;
  return {
    Sheet: children,
    SheetContent: children,
    SheetDescription: children,
    SheetFooter: children,
    SheetHeader: children,
    SheetTitle: children,
    SheetTrigger: children,
  };
});

describe('new token form', () => {
  it('defaults to project controls and non-admin global read guidance', () => {
    const html = renderToStaticMarkup(
      <CreateTokenSheet
        action={() => Promise.resolve({ error: null })}
        csrf="test-csrf"
        projects={[{ id: 'alpha-id', slug: 'alpha' }]}
      />,
    );
    expect(html).toContain('name="tokenType"');
    expect(html).toContain('name="access"');
    expect(html).toContain('name="project"');
    expect(html).toContain('value="alpha"');
    expect(html).toContain('Write access requires at least one project.');
    expect(html).toContain('global read-only access, without administration or dashboard login.');
    expect(html).not.toContain('Full read/write access');
    expect(html).not.toContain('None selected: ADMIN');
  });
});
