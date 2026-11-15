import { RedactionTally } from './secret-redaction.js';

export const FILE_RECALL_PER_FILE_MAX = 3;
export const FILE_RECALL_FILES_PER_SESSION = 10;
export const FILE_RECALL_WINDOW_CHARS = 300;
export const FILE_RECALL_MAX_BYTES = 1024;
const WINDOW_SHRINK_STEP = 50;

export interface FileRecallEntry {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
  needsReview: boolean;
}

/** Same normalisation as stored `path` entities; null for anything not repo-relative. */
export function normalizeRepoPath(raw: string): string | null {
  const path = raw
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '');
  if (path.length === 0 || /^[A-Za-z]:/.test(path)) return null;
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return path;
}

export function candidateValues(path: string, siblings: readonly string[]): string[] {
  const tracked = [
    ...new Set(siblings.map(normalizeRepoPath).filter((s): s is string => s !== null)),
  ];
  const values = [path];
  const segments = path.split('/');
  for (let start = 1; start <= segments.length - 2; start++) {
    const suffix = segments.slice(start).join('/');
    const owners = tracked.filter((s) => s === suffix || s.endsWith(`/${suffix}`));
    if (owners.length === 1 && owners[0] === path) values.push(suffix);
  }
  return values;
}

/** Returns the block's lines and the ids of the memories that survived the byte bound. */
export function renderFileRecall(
  path: string,
  entries: readonly FileRecallEntry[],
): { lines: string[]; renderedIds: string[] } {
  if (entries.length === 0) return { lines: [], renderedIds: [] };
  const name = path.split('/').at(-1) ?? path;
  const first = entries[0]!;
  const build = (windowChars: number, count: number): string[] => {
    const shown = entries.slice(0, count);
    const lines = [`rembric: memories about ${path}:`, entryLine(first)];
    if (windowChars > 0) lines.push(mentionWindow(first.content, name, windowChars));
    for (const entry of shown.slice(1)) lines.push(entryLine(entry));
    return lines;
  };
  let windowChars = FILE_RECALL_WINDOW_CHARS;
  let count = entries.length;
  let lines = build(windowChars, count);
  while (bytes(lines) > FILE_RECALL_MAX_BYTES && windowChars > 0) {
    windowChars = Math.max(0, windowChars - WINDOW_SHRINK_STEP);
    lines = build(windowChars, count);
  }
  while (bytes(lines) > FILE_RECALL_MAX_BYTES && count > 1) {
    count -= 1;
    lines = build(windowChars, count);
  }
  return { lines, renderedIds: entries.slice(0, count).map((e) => e.id) };
}

function entryLine(entry: FileRecallEntry): string {
  const title = entry.title.replace(/\s+/g, ' ').trim();
  const date = entry.createdAt.toISOString().slice(0, 10);
  return `- ${title} [${entry.id}] (${date}${entry.needsReview ? ', needs review' : ''})`;
}

/** Redacts before cutting, so a cut can never leave half a secret undetectable. */
function mentionWindow(content: string, name: string, windowChars: number): string {
  const text = new RedactionTally().redact(content).replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  const found = text.indexOf(name);
  const at = found < 0 ? 0 : Array.from(text.slice(0, found)).length;
  const lead = Math.floor(Math.max(0, windowChars - Array.from(name).length) / 2);
  const end = Math.min(chars.length, Math.max(0, at - lead) + windowChars);
  const start = Math.max(0, end - windowChars);
  const body = chars.slice(start, end).join('');
  return `  ${start > 0 ? '…' : ''}${body}${end < chars.length ? '…' : ''}`;
}

function bytes(lines: readonly string[]): number {
  return Buffer.byteLength(lines.join('\n'), 'utf8');
}
