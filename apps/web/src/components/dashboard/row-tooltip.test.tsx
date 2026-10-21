import {
  Children,
  isValidElement,
  type ComponentProps,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RowTooltip } from './row-tooltip';

import { TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const state = vi.hoisted(() => ({ open: false, setOpen: vi.fn() }));
vi.mock('react', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useState: () => [state.open, state.setOpen],
}));
beforeEach(() => {
  state.open = false;
  state.setOpen.mockClear();
});

describe('RowTooltip', () => {
  it.each([undefined, false, true])(
    'supports clickToOpen=%s without changing ordinary link navigation',
    (clickToOpen) => {
      const element: ReactElement<{ children: ReactNode; open?: boolean }> = RowTooltip({
        children: <button>Details</button>,
        tooltip: 'Complete information',
        clickToOpen,
      });
      const trigger = Children.toArray(element.props.children).find(
        (child) => isValidElement(child) && child.type === TooltipTrigger,
      );
      if (!isValidElement<ComponentProps<typeof TooltipTrigger>>(trigger))
        throw new Error('Missing trigger');
      expect(element.props.open).toBe(clickToOpen ? false : undefined);
      if (clickToOpen) {
        const event: Pick<MouseEvent<HTMLButtonElement>, 'preventDefault'> = {
          preventDefault: vi.fn(),
        };
        trigger.props.onClick?.(event as MouseEvent<HTMLButtonElement>);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(state.setOpen).toHaveBeenCalledWith(true);
      } else expect(trigger.props.onClick).toBeUndefined();
    },
  );

  it('bounds the tooltip to available viewport space and wraps long content without changing its payload', () => {
    const tooltip = <p>{'Long complete title '.repeat(20)}</p>;
    const element: ReactElement<{ children: ReactNode }> = RowTooltip({
      children: <button>Details</button>,
      tooltip,
    });
    const content = Children.toArray(element.props.children).find(
      (child) => isValidElement(child) && child.type === TooltipContent,
    );
    if (!isValidElement<ComponentProps<typeof TooltipContent>>(content))
      throw new Error('Missing tooltip content');
    expect(content.props.className).toContain(
      'max-w-[min(28rem,var(--radix-tooltip-content-available-width))]',
    );
    expect(content.props.className).toContain('wrap-anywhere');
    expect(content.props.className).toContain('rounded-[10px]');
    expect(content.props.children).toBe(tooltip);
    expect(content.props.collisionPadding).toBe(16);
  });
});
