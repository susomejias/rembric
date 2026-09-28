'use client';

import { Search, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Corpus-wide search for the server-paged list views. Writes the query into the
 * `?q=` URL param (debounced) and resets `?page=`, so the server does the actual
 * filtering over every row — unlike a client-side table search, which only sees
 * the rows already loaded for the current page.
 */
export function TableSearch({
  paramKey = 'q',
  placeholder,
  ariaLabel,
  value,
  className,
}: {
  paramKey?: string;
  placeholder: string;
  ariaLabel?: string;
  /** Current param value, so the input starts in sync with the URL. */
  value: string;
  className?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = React.useState(value);
  const lastPushed = React.useRef(value);

  React.useEffect(() => {
    if (value === lastPushed.current) return;
    setQuery(value);
    lastPushed.current = value;
  }, [value]);

  const push = React.useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.delete('page');
      if (next) params.set(paramKey, next);
      else params.delete(paramKey);
      const queryString = params.toString();
      router.replace(queryString ? `?${queryString}` : '?', { scroll: false });
      lastPushed.current = next;
    },
    [paramKey, router, searchParams],
  );

  // Debounced so every keystroke does not hit the server round-trip.
  React.useEffect(() => {
    if (query === lastPushed.current) return;
    const timer = window.setTimeout(() => push(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query, push]);

  return (
    <div className={cn('group/search relative w-full sm:w-64', className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 start-2.5 my-auto size-4 text-muted-foreground"
      />
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className={cn(
          'h-9 w-full rounded-xl border border-border bg-card ps-8 pe-8 text-sm text-foreground placeholder:text-muted-foreground',
          'transition-[border-color] duration-150 ease-out focus:border-ring focus:outline-none',
          '[&::-webkit-search-cancel-button]:hidden',
        )}
      />
      {query ? (
        <button
          type="button"
          onClick={() => {
            setQuery('');
            if (lastPushed.current !== '') push('');
          }}
          aria-label="Clear search"
          className="absolute inset-y-0 end-1 my-auto grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground focus-visible:outline-none"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
