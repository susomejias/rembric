'use client';

import { Info } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export function PageHelp({ text }: { text: string }) {
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={text}>
            <Info aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={8}
          collisionPadding={16}
          className="max-w-xs rounded-lg border border-border bg-popover px-3 py-2 text-xs text-foreground shadow-lg shadow-black/40 [&>svg]:hidden"
        >
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
