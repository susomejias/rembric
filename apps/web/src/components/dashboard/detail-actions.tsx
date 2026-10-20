'use client';

import { Popover } from 'radix-ui';
import { useState, type ReactNode } from 'react';

export function DetailActions({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={label}
        className="detail-actions cursor-pointer shrink-0 rounded-lg border border-border px-3 py-1 text-xl hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span aria-hidden="true">⋯</span>
      </Popover.Trigger>
      <Popover.Content
        forceMount
        hidden={!open}
        align="end"
        sideOffset={8}
        aria-label={label}
        className="detail-actions-panel min-w-44 space-y-2 rounded-xl border border-border bg-popover p-3 shadow-lg shadow-black/30"
      >
        {children}
      </Popover.Content>
    </Popover.Root>
  );
}
