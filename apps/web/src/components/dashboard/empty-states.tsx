import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The per-table empty states. A filtered-to-nothing table and an empty corpus
 * are different situations, and the operator can only act on the first one, so
 * each view composes its own copy from these two shapes rather than rendering a
 * generic "nothing here" line:
 *
 *  - `TableNoResults` is the filtered case, and its one action is the way out of
 *    the filter set (`Clear filters`, the same destination the view's CLEAR
 *    button points at).
 *  - `TableEmptyState` is the corpus case: the view supplies the hint that
 *    explains how a row is created, because no button in this dashboard can
 *    create one (memories, sessions, prompts and judgments all arrive through
 *    the MCP/HTTP surface, not through a dashboard form).
 *
 * Midday's `tables/core/empty-states.tsx` is the same split (`NoResults` with a
 * `Clear filters` action, `EmptyState` with a view-supplied title/description);
 * the copy here is Rembric's.
 */

export function TableEmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-14 text-center',
        className,
      )}
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

/** The filtered case: a way out of the filter set, and nothing else. */
export function TableNoResults({
  what,
  clearHref,
  description = 'Try another keyword, or widen the filters.',
}: {
  what: string;
  clearHref: string;
  description?: ReactNode;
}) {
  return (
    <TableEmptyState
      title={`No ${what} match this filter`}
      description={description}
      action={
        <Button asChild variant="outline" size="sm">
          <Link href={clearHref}>CLEAR FILTERS</Link>
        </Button>
      }
    />
  );
}
