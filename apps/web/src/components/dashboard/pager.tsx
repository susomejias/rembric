import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';

import { PAGE_SIZE, queryWithPage } from '@/components/dashboard/format';
import { Button } from '@/components/ui/button';

/**
 * Server-side pagination as URL state: both controls are links to the same page
 * with `page` replaced, so a page change is a new server render, the filters
 * round-trip, and no client JavaScript is needed for the read path (the D10
 * resolution of the dashboard-01 DataTable tension). Replaces
 * `components.ts::pager`.
 *
 * `total` is the true filtered row count. It is `undefined` for a filter whose
 * exact count has no cheap query — the label then states only the page, never a
 * wrong "OF Y".
 */
export function Pager({
  page,
  hasMore,
  total,
  totalLabel,
  path,
  query,
}: {
  page: number;
  hasMore: boolean;
  total?: number;
  totalLabel?: string;
  path: string;
  query: Readonly<Record<string, string>>;
}) {
  const pageCount = total === undefined ? undefined : Math.max(1, Math.ceil(total / PAGE_SIZE));
  const label =
    `PAGE ${page + 1}` +
    (pageCount === undefined ? '' : ` OF ${pageCount}`) +
    (totalLabel ? ` · ${totalLabel}` : '');

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
      <span className="font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </span>
      <span className="flex items-center gap-2">
        {page > 0 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`${path}${queryWithPage(query, page - 1)}`}>
              <ChevronLeftIcon />
              PREV
            </Link>
          </Button>
        ) : null}
        {hasMore ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`${path}${queryWithPage(query, page + 1)}`}>
              NEXT
              <ChevronRightIcon />
            </Link>
          </Button>
        ) : null}
      </span>
    </div>
  );
}
