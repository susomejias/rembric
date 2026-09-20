/**
 * The relative-time renderer the overview's recents tiles share. The published
 * home contract pins the visible text of both tiles to
 * `NOW | <n>M AGO | <n>H AGO | <n>D AGO | <n>MO AGO` (`components.ts::relTime`
 * produced exactly these), so the absolute instant rides on the `<time>`
 * element's `dateTime` and `title` rather than replacing that text.
 */
export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'NOW';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}H AGO`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}D AGO`;
  return `${Math.floor(days / 30)}MO AGO`;
}

export function RelativeTime({ value }: { value: number | Date | null | undefined }) {
  const at = value instanceof Date ? value.getTime() : (value ?? null);
  if (at === null || Number.isNaN(at)) return <>—</>;
  const iso = new Date(at).toISOString();
  return (
    <time dateTime={iso} title={iso}>
      {relativeTime(at)}
    </time>
  );
}
