import Link from 'next/link';

import { cn } from '@/lib/utils';

type PageParams = Record<string, string | string[] | undefined>;

function hrefFor(params: PageParams, page: number): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'page' || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) search.append(key, item);
  }
  if (page > 1) search.set('page', String(page));
  const query = search.toString();
  return query ? `?${query}` : '?';
}

const NAV_BUTTON =
  'inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm text-muted-foreground transition-colors hover:text-foreground';

export function ServerPager({
  page,
  total,
  pageSize,
  params,
  className,
}: {
  page: number;
  total: number;
  pageSize: number;
  params: PageParams;
  className?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;

  return (
    <nav
      aria-label="Pagination"
      className={cn('flex items-center justify-center gap-3 pt-4', className)}
    >
      {page > 1 ? (
        <Link href={hrefFor(params, page - 1)} prefetch className={NAV_BUTTON}>
          Prev
        </Link>
      ) : (
        <span aria-disabled className={cn(NAV_BUTTON, 'pointer-events-none opacity-40')}>
          Prev
        </span>
      )}
      <span className="font-mono text-xs text-muted-foreground tabular-nums">
        Page {page} of {pages} · {total} {total === 1 ? 'row' : 'rows'}
      </span>
      {page < pages ? (
        <Link href={hrefFor(params, page + 1)} prefetch className={NAV_BUTTON}>
          Next
        </Link>
      ) : (
        <span aria-disabled className={cn(NAV_BUTTON, 'pointer-events-none opacity-40')}>
          Next
        </span>
      )}
    </nav>
  );
}
