'use client';

import { useId, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

export function DetailExpand({
  label,
  accessibleLabel = label,
  collapsedContent,
  children,
  className = '',
}: {
  label: string;
  accessibleLabel?: string;
  collapsedContent?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      {!open ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={accessibleLabel}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(true)}
        >
          {label}
        </Button>
      ) : null}
      {!open ? collapsedContent : null}
      <div id={id} hidden={!open} className={className}>
        {children}
      </div>
    </>
  );
}
