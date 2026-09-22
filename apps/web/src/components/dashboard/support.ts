export const PAGE_SIZE = 50;

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

export function singleParam(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

export function pageParam(value: string | string[] | undefined): number {
  const raw = parseInt(singleParam(value), 10) || 0;
  return Math.min(Math.max(0, raw), Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE));
}

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
