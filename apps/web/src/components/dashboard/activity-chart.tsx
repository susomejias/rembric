'use client';

import { useState } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface ActivityDay {
  readonly day: number;
  readonly saves: number;
  readonly ops: number;
  readonly isToday: boolean;
}

const DAY_MS = 86_400_000;

function formatDay(day: number, isToday: boolean): string {
  if (isToday) return 'Today';
  return new Date(day * DAY_MS).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export function ActivityChart({ days }: { days: readonly ActivityDay[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const peak = Math.max(1, ...days.map((day) => day.saves + day.ops));

  return (
    <div
      className="flex min-h-24 flex-1 items-end gap-[3px] px-5 pb-2 pt-4"
      aria-label="Memory activity per day, last thirty days: saves and consolidation ops"
    >
      {days.map((day, index) => {
        const isHovered = hovered === index;
        const savesPct = Math.max(day.saves > 0 ? 6 : 2, Math.round((day.saves / peak) * 100));
        const opsPct = Math.round((day.ops / peak) * 100);
        return (
          <Tooltip key={day.day} onOpenChange={(open) => setHovered(open ? index : null)}>
            <TooltipTrigger asChild>
              <div
                role="presentation"
                tabIndex={-1}
                className="flex h-full min-w-0 flex-1 cursor-default items-end"
              >
                <div className="flex h-full w-full flex-col justify-end">
                  {day.ops > 0 ? (
                    <div
                      className={cn(
                        'w-full rounded-t-[3px] transition-colors',
                        isHovered ? 'bg-warn' : 'bg-warn/70',
                      )}
                      style={{ height: `${opsPct}%` }}
                    />
                  ) : null}
                  <div
                    className={cn(
                      'w-full transition-colors',
                      day.ops > 0 ? 'rounded-b-[3px]' : 'rounded-[3px]',
                      isHovered || day.isToday ? 'bg-primary' : 'bg-primary/50',
                    )}
                    style={{ height: `${savesPct}%` }}
                  />
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              sideOffset={8}
              collisionPadding={16}
              className="flex flex-col items-stretch gap-0.5 rounded-lg border border-border bg-popover px-3 py-2 text-left text-foreground shadow-lg shadow-black/40 [&>svg]:hidden"
            >
              <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold">
                <span aria-hidden="true" className="size-1.5 rounded-[2px] bg-primary" />
                {day.saves.toLocaleString('en-US')} saved
              </span>
              {day.ops > 0 ? (
                <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-warn">
                  <span aria-hidden="true" className="size-1.5 rounded-[2px] bg-warn" />
                  {day.ops.toLocaleString('en-US')} superseded · archived
                </span>
              ) : null}
              <span className="whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                {formatDay(day.day, day.isToday)}
              </span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
