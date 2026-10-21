'use client';

import { useState, type ReactNode } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function RowTooltip({
  children,
  tooltip,
  placement = 'top',
  clickToOpen = false,
}: {
  children: ReactNode;
  tooltip: ReactNode;
  placement?: 'top' | 'bottom';
  clickToOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={clickToOpen ? open : undefined} onOpenChange={clickToOpen ? setOpen : undefined}>
      <TooltipTrigger
        asChild
        onClick={
          clickToOpen
            ? (event) => {
                event.preventDefault();
                setOpen(true);
              }
            : undefined
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        side={placement}
        sideOffset={8}
        collisionPadding={16}
        className="flex w-fit max-w-[min(28rem,var(--radix-tooltip-content-available-width))] flex-col items-stretch gap-1 rounded-[10px] border border-border bg-popover px-3 py-2 text-left text-xs text-foreground shadow-lg shadow-black/40 wrap-anywhere [&>svg]:hidden"
      >
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
