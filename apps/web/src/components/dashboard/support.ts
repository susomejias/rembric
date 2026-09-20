/**
 * Pure URL and formatting helpers the dashboard views share. They are the
 * surviving half of the retired `components/dashboard/format.ts`: the same
 * `PAGE_SIZE`/`singleParam`/`pageParam`/`queryWithPage` contract the listing
 * routes' `filters.ts` modules were written against, with no JSX and no
 * request- or database-aware code.
 */

/** Standard page size for every paginated dashboard listing. */
export const PAGE_SIZE = 50;

/** The `project` filter value the dashboard retired; normalised away on read. */
export const RETIRED_PROJECT_FILTER = '__global__';

export function truncate(s: string | null | undefined, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 14 ? id.slice(0, 8) + '…' + id.slice(-4) : id;
}

/**
 * A `searchParams` entry as one value. A repeated param (`?a=1&a=2`) resolves to
 * its first occurrence rather than a joined string, matching
 * `URLSearchParams.get`.
 */
export function singleParam(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

/**
 * Clamped so `page * PAGE_SIZE` stays a safe integer — SQLite rejects a
 * non-integer OFFSET.
 */
export function pageParam(value: string | string[] | undefined): number {
  const raw = parseInt(singleParam(value), 10) || 0;
  return Math.min(Math.max(0, raw), Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE));
}

/**
 * Rebuild the query string of a listing URL with `page` replaced, preserving
 * every other param so the pager round-trips the active filters. `page <= 0`
 * drops the param entirely, which is what keeps page 1 and the unfiltered list
 * on the same URL.
 */
export function queryWithPage(query: Readonly<Record<string, string>>, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== '') params.set(key, value);
  }
  if (page <= 0) params.delete('page');
  else params.set('page', String(page));
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

/** Byte counts at the sizes a local database actually reaches. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** `13 May 2026, 22:21` — the UTC fallback string a `<time>` renders before upgrade. */
export function utcStamp(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  const iso = date.toISOString();
  return `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}, ${iso.slice(11, 16)}`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Coarse "how long ago" for list rows, in the same vocabulary the mockup uses. */
export function relativeTime(
  value: Date | string | number | null | undefined,
  nowMs: number,
): string {
  if (value === null || value === undefined) return '—';
  const date = value instanceof Date ? value : new Date(value);
  const deltaMs = nowMs - date.getTime();
  if (Number.isNaN(deltaMs)) return '—';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

/** How long a run lasted, `12m 08s`-shaped, for the session rows. */
export function durationBetween(
  start: Date | string,
  end: Date | string | null,
  nowMs: number,
): string {
  const from = start instanceof Date ? start.getTime() : new Date(start).getTime();
  let to = nowMs;
  if (end !== null) {
    to = end instanceof Date ? end.getTime() : new Date(end).getTime();
  }
  const totalSeconds = Math.max(0, Math.floor((to - from) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = `${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  return hours > 0 ? `${hours}h ${clock}` : clock;
}
