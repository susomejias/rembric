'use client';

import { useEffect, useState } from 'react';

import { utcStamp } from './support';

/**
 * The viewer's localized stamp — the same fields `utcStamp` prints, formatted in
 * the host locale and a caller-supplied timezone. Exported so the regression
 * test can pin locale and timezone instead of reading the machine's.
 */
export function viewerStamp(date: Date, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

/**
 * A timestamp the server renders as the unambiguous UTC fallback and the client
 * re-renders in the viewer's timezone after mounting. The localization cannot
 * happen during the first render — it is gated on `mounted` so the initial
 * output matches the server byte for byte. The dashboard layout used to rewrite
 * this text node from a pre-hydration script, which is exactly what React then
 * failed to hydrate against.
 */
export function Time({
  value,
  className,
}: {
  value: Date | string | number | null | undefined;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (value === null || value === undefined) return <>—</>;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return <>—</>;
  const iso = date.toISOString();
  return (
    <time dateTime={iso} data-rembric-ts className={className}>
      {mounted
        ? viewerStamp(date, Intl.DateTimeFormat().resolvedOptions().timeZone)
        : utcStamp(date)}
    </time>
  );
}
