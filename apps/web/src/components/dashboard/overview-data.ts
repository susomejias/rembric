import { statSync } from 'node:fs';
import { homedir } from 'node:os';

import type { Repositories } from '@rembric/db';

/**
 * The overview's read layer — every repository and filesystem read the retired
 * Hono home handler performed before rendering (`apps/server/src/server/dashboard-router.ts`,
 * the `GET /` route), and nothing else. Ported rather than imported because
 * `apps/server` is not a dependency of this workspace.
 */

/**
 * Memories created per UTC day over the last seven days, oldest first. SQLite
 * stores `created_at` in ms while `adminCountCreatedByDay` groups on whole days,
 * so the bucket keys are compared the same way here.
 */
export function sevenDayActivity(repos: Repositories): number[] {
  const todayMs = startOfUtcDay(Date.now());
  const sevenAgo = todayMs - 6 * 24 * 60 * 60 * 1000;
  const byDay = new Map<number, number>();
  for (const row of repos.memory.adminCountCreatedByDay(new Date(sevenAgo))) {
    byDay.set(row.day, row.n);
  }
  const out: number[] = [];
  for (let i = 6; i >= 0; i--) {
    out.push(byDay.get(Math.floor((todayMs - i * 24 * 60 * 60 * 1000) / 86_400_000)) ?? 0);
  }
  return out;
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface SystemInfo {
  /** The resolved database path, with the home directory shortened to `~`. */
  dbPath: string;
  /** `data.db` plus its WAL, or `—` while the file does not exist yet. */
  dbSize: string;
  host: string;
  node: string;
}

export function readSystemInfo(dbPath: string): SystemInfo {
  let dbSize = '—';
  try {
    const totalBytes = statSync(dbPath).size + safeSize(`${dbPath}-wal`);
    dbSize = `${(totalBytes / (1024 * 1024)).toFixed(2)} MB`;
  } catch {
    // A database file that does not exist yet is the first-run state, not an error.
  }
  return {
    dbPath: displayPath(dbPath),
    dbSize,
    host: `${process.env['REMBRIC_HOST'] ?? '127.0.0.1'}:${process.env['REMBRIC_PORT'] ?? '8787'}`,
    node: process.versions.node,
  };
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function displayPath(absolute: string): string {
  const home = homedir();
  if (absolute === home || absolute.startsWith(`${home}/`)) {
    return `~${absolute.slice(home.length)}`;
  }
  return absolute;
}

/** `project:<id>` → the project's slug when it still exists; the raw value otherwise. */
export function scopeLabel(repos: Repositories, scope: string | null): string {
  if (scope === null) return '—';
  if (!scope.startsWith('project:')) return scope;
  return repos.projects.adminFindById(scope.slice('project:'.length))?.slug ?? scope;
}

export function shortDisplayId(id: string): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id;
}

/**
 * The two judgment windows the sweep enforces. Same names, defaults and bounds
 * as `apps/server/src/config.ts`'s zod schema, so the thresholds an operator
 * reads on the overview cannot drift from the ones the sweep applies.
 */
export function orphanThresholds(): { afterMs: number; deadlineMs: number } {
  return {
    afterMs: envInt('JUDGMENT_ORPHAN_AFTER_MS', 86_400_000, 60_000, 30 * 86_400_000),
    deadlineMs: envInt('JUDGMENT_ORPHAN_DEADLINE_MS', 14 * 86_400_000, 3_600_000, 365 * 86_400_000),
  };
}

/** `fmtWindow` from the retired overview: `H` below two days, `D` above. */
export function formatWindow(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  return hours >= 48 ? `${Math.round(hours / 24)}D` : `${hours}H`;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
