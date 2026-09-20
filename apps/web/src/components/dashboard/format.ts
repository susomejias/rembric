/**
 * Pure formatting and URL helpers the list views share. These are the React
 * replacements for `apps/server/src/dashboard/components.ts`'s
 * `PAGE_SIZE`/`truncate`/`pageParam`/`urlWithPage`, plus the id shortening
 * `templates.ts::shortId` owns — kept as plain functions because every ported
 * view needs them and none of them touches the request or the database.
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
