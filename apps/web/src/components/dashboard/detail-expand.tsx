'use client';

import { useId, useState, type ReactNode } from 'react';

export function DetailExpand({
  label,
  accessibleLabel = label,
  children,
  className = '',
}: {
  label: string;
  accessibleLabel?: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      {!open ? (
        <button
          type="button"
          className={`ficha-expand ${className}`}
          aria-label={accessibleLabel}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(true)}
        >
          {label}
        </button>
      ) : null}
      <div id={id} hidden={!open} className={className}>
        {children}
      </div>
    </>
  );
}
