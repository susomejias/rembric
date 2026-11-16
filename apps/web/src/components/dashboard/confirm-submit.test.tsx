import type * as Radix from 'radix-ui';
import { cloneElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmSubmit } from './confirm-submit';

import { Button } from '@/components/ui/button';

vi.mock('@/components/dashboard/action-form', () => ({
  useActionFormId: () => 'radius-test-form',
}));
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

describe('ConfirmSubmit shared shapes', () => {
  it.each(['danger', 'warn'] as const)('inherits modal and action radii for %s', (tone) => {
    const dialog = ConfirmSubmit({
      tone,
      title: 'Delete record?',
      description: 'This cannot be undone.',
      confirmLabel: 'Delete',
      children: <Button type="button">Open</Button>,
    });
    const html = renderToStaticMarkup(cloneElement(dialog, { defaultOpen: true }));
    expect(html).toMatch(/role="alertdialog"[^>]*class="[^"]*rounded-\[16px\]/);
    expect(html).toMatch(/data-slot="alert-dialog-cancel"[^>]*class="[^"]*rounded-\[10px\]/);
    expect(html).toMatch(/data-slot="alert-dialog-action"[^>]*class="[^"]*rounded-\[10px\]/);
    expect(html).toContain('form="radius-test-form"');
    expect(html).toContain(`data-variant="${tone === 'danger' ? 'destructive' : 'warn'}"`);
    expect(html).toContain('type="submit"');
    expect(html).toContain('type="button"');
  });

  it.each([
    ['danger', 'destructive'],
    ['warn', 'warn'],
  ] as const)('maps tone %s to the %s action variant with a Cancel label', (tone, variant) => {
    const dialog = ConfirmSubmit({
      tone,
      title: 'Archive record?',
      description: 'It can be restored later.',
      confirmLabel: 'Archive selected',
      children: <Button type="button">Open</Button>,
    });
    const html = renderToStaticMarkup(cloneElement(dialog, { defaultOpen: true }));
    expect(html).toMatch(
      new RegExp(
        `data-slot="alert-dialog-action"[^>]*data-variant="${variant}"|data-variant="${variant}"[^>]*data-slot="alert-dialog-action"`,
      ),
    );
    expect(html).toMatch(/data-slot="alert-dialog-cancel"[^>]*>Cancel</);
    expect(html).not.toContain('CANCEL');
    expect(html).toContain('Archive selected');
  });
});
