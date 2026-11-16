'use client';

import { Ellipsis } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

export function DetailActions({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button type="button" variant="outline" size="icon-lg" aria-label={label}>
          <Ellipsis aria-hidden="true" />
        </Button>
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
