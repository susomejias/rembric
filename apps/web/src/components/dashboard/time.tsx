'use client';

import { useEffect, useState } from 'react';

import { utcStamp } from './support';

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
