import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** The empty-table state — the React replacement for `components.ts::tblEmpty`. */
export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}
