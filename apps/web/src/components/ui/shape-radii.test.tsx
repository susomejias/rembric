import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AlertDialogContent, AlertDialogFooter } from './alert-dialog';
import { Button, buttonVariants } from './button';
import { DialogContent, DialogFooter } from './dialog';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from './dropdown-menu';
import { Input } from './input';
import { SelectContent, SelectItem, SelectTrigger } from './select';
import { Textarea } from './textarea';

import { DataTable } from '@/components/spectrumui/data-table';

function slotClass(node: ReactNode, slot: string): string | undefined {
  for (const child of Children.toArray(node)) {
    if (
      !isValidElement<{ 'data-slot'?: string; className?: string; children?: ReactNode }>(child)
    ) {
      continue;
    }
    if (child.props['data-slot'] === slot) return child.props.className;
    const nested = slotClass(child.props.children, slot);
    if (nested) return nested;
  }
}

describe('shared component radii', () => {
  it.each(['Copy 1 rows as markdown to the clipboard', 'Clear selection'])(
    'uses 10px for the ordinary selection action %s without changing the floating pill',
    (label) => {
      const html = renderToStaticMarkup(
        <DataTable
          data={[{ id: 'one', name: 'Selected record' }]}
          columns={[{ id: 'name', header: 'Name', value: (row) => row.name }]}
          rowId={(row) => row.id}
          selectable
          selectedIds={['one']}
          bulkActions={() => <span>Bulk actions</span>}
          animate={false}
        />,
      );
      const button = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
      expect(button).toBeDefined();
      expect(button).toContain('rounded-[10px]');
      expect(button).not.toContain('rounded-full');
      expect(html).toContain('gap-1 rounded-full border border-border bg-popover');
    },
  );

  it.each(['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm', 'icon-lg'] as const)(
    'keeps %s buttons at 10px, including button groups',
    (size) => {
      const classes = buttonVariants({ size }).split(' ');
      expect(classes.filter((value) => value.includes('rounded-'))).toEqual(['rounded-[10px]']);
      expect(renderToStaticMarkup(<Button size={size}>Action</Button>)).toContain('rounded-[10px]');
    },
  );

  it('keeps explicitly pill-shaped consumers available', () => {
    const html = renderToStaticMarkup(<Button className="rounded-full">Filter</Button>);
    expect(html).toContain('rounded-full');
    expect(html).not.toContain('rounded-[10px]');
  });

  it.each([
    ['input', Input({})],
    ['textarea', Textarea({})],
    ['select-trigger', SelectTrigger({})],
    ['select-trigger', SelectTrigger({ size: 'sm' })],
  ])('uses 12px for %s controls', (slot, node) => {
    const classes = slotClass(node, String(slot))?.split(' ');
    expect(classes?.filter((value) => value.includes('rounded-'))).toEqual(['rounded-[12px]']);
  });

  it.each([
    ['dialog-content', DialogContent({})],
    ['alert-dialog-content', AlertDialogContent({})],
    ['alert-dialog-content', AlertDialogContent({ size: 'sm' })],
  ])('uses 16px for %s modals', (slot, node) => {
    expect(slotClass(node, String(slot))?.split(' ')).toContain('rounded-[16px]');
  });

  it.each([
    ['dialog-footer', DialogFooter({})],
    ['alert-dialog-footer', AlertDialogFooter({})],
  ])('matches the bottom corners of %s to its modal', (slot, node) => {
    expect(slotClass(node, String(slot))?.split(' ')).toContain('rounded-b-[16px]');
  });

  it.each([
    ['select-content', SelectContent({})],
    ['dropdown-menu-content', DropdownMenuContent({})],
    ['dropdown-menu-sub-content', DropdownMenuSubContent({})],
  ])('retains the existing 16px theme radius for %s', (slot, node) => {
    expect(slotClass(node, String(slot))?.split(' ')).toContain('rounded-lg');
  });

  it.each([
    ['select-item', SelectItem({ value: 'one' })],
    ['dropdown-menu-item', DropdownMenuItem({})],
    ['dropdown-menu-checkbox-item', DropdownMenuCheckboxItem({})],
    ['dropdown-menu-radio-item', DropdownMenuRadioItem({ value: 'one' })],
    ['dropdown-menu-sub-trigger', DropdownMenuSubTrigger({})],
  ])('uses 10px for %s menu actions', (slot, node) => {
    expect(slotClass(node, String(slot))?.split(' ')).toContain('rounded-[10px]');
  });
});
