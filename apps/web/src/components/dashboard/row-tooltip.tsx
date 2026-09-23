'use client';

import type { ReactNode } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function RowTooltip({
  children,
  tooltip,
  placement = 'top',
}: {
  children: ReactNode;
  tooltip: ReactNode;
  placement?: 'top' | 'bottom';
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={placement}
        sideOffset={8}
        collisionPadding={16}
        className="flex w-fit max-w-md flex-col items-stretch gap-1 rounded-lg border border-border bg-popover px-3 py-2 text-left text-xs text-foreground shadow-lg shadow-black/40 [&>svg]:hidden"
      >
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
