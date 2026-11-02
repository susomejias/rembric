import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { TokenRotationResult } from './token-rotation';

vi.mock('@/components/ui/dialog', () => {
  const children = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: children,
    DialogContent: children,
    DialogHeader: children,
    DialogTitle: children,
    DialogDescription: children,
    DialogFooter: children,
  };
});

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe('one-time rotation result', () => {
  it('shows the returned secret with Copy and dismissal but no form, link or secret transport', () => {
    const html = renderToStaticMarkup(
      <TokenRotationResult name="agent" plaintext="replacement-secret" onDismiss={vi.fn()} />,
    );
    expect(html).toContain('replacement-secret</code>');
    expect(html).toContain('Copy</button>');
    expect(html).toContain('Done</button>');
    expect(html).toContain('will not be shown again');
    expect(html).toContain('reconnect');
    expect(html).not.toMatch(/<form|<input|href=|created=|hash/);
  });

  it('dismisses on close, never on open', () => {
    const dismiss = vi.fn();
    const result: ReactElement<{ onOpenChange: (open: boolean) => void }> = TokenRotationResult({
      name: 'agent',
      plaintext: 'secret',
      onDismiss: dismiss,
    });
    result.props.onOpenChange(true);
    expect(dismiss).not.toHaveBeenCalled();
    result.props.onOpenChange(false);
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
