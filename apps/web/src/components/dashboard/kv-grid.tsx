import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The label/value grid the detail views use for metadata — the React
 * replacement for `components.ts::kv`/`kvGrid`. A definition list, so the
 * label/value pairing survives without the visual structure.
 */
export function KvGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl
      className={cn(
        'grid grid-cols-1 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-4',
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function Kv({ k, children, mono }: { k: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="bg-card px-3 py-2.5">
      <dt className="font-mono text-[0.66rem] tracking-[0.12em] text-muted-foreground uppercase">
        {k}
      </dt>
      <dd className={cn('mt-1 text-sm break-words', mono && 'font-mono')}>{children}</dd>
    </div>
  );
}
