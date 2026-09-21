import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startProcess } from '../lib/process';

/**
 * The startup banner `instrumentation.ts::register()` produces through
 * `startProcess` — the app's replacement for `apps/server`'s
 * `bootstrap.ts` banner, and the only place an operator sees the resolved data
 * directory, the migration narration and the boot's row counts.
 *
 * Driven through the real entry point over a real migrated SQLite file: the
 * banner is a side effect of the boot, so asserting it any other way would test
 * the logger rather than the boot.
 *
 * NOTE (parallel work): the `[bootstrap] counts:` line and the
 * `[bootstrap] no prior state marker` line are produced by the data-loss guard
 * and state-marker work landing in `lib/process.ts` / `packages/db` alongside
 * this suite. The regexes below are the ones `apps/server`'s retired
 * `bootstrap-banner.test.ts` asserted, so they pin the banner's contract rather
 * than one implementation of it.
 *
 * `startProcess` caches its "already started" flag and the service graph on
 * `globalThis` (Next re-evaluates modules on HMR), so each case resets those
 * slots and owns a fresh data directory. A fresh directory is also what keeps
 * `assertDataLossGuard` from terminating the process (exit 78) on a shrinkage it
 * would be right to refuse.
 */

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { raw: { close: () => void }; close: () => void };
  __rembricProcessStarted?: boolean;
};

const globalForTest = globalThis as MutableGlobal;

function resetBootGlobals(): void {
  try {
    globalForTest.__rembricDb?.close();
  } catch {
    // ignore double-close of a fixture the process already closed
  }
  delete globalForTest.__rembricServices;
  delete globalForTest.__rembricDb;
  delete globalForTest.__rembricProcessStarted;
}

const ADMIN_TOKEN = 'banner-test-token-with-enough-entropy-xx';

let dataDir: string;

beforeEach(() => {
  resetBootGlobals();
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-banner-'));
});

afterEach(() => {
  resetBootGlobals();
  delete process.env['REMBRIC_DATA_DIR'];
  delete process.env['REMBRIC_ADMIN_TOKEN'];
  delete process.env['REMBRIC_SESSION_SECRET'];
  delete process.env['REMBRIC_ALLOW_DATA_SHRINKAGE'];
  rmSync(dataDir, { recursive: true, force: true });
});

/** Boot the process over `dir` and return every line it wrote to stderr. */
function boot(dir: string): string[] {
  resetBootGlobals();
  process.env['REMBRIC_DATA_DIR'] = dir;
  process.env['REMBRIC_ADMIN_TOKEN'] = ADMIN_TOKEN;

  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  try {
    startProcess();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

const COUNTS_RE =
  /^\[bootstrap\] counts: memory=(\d+) projects=(\d+) sessions=(\d+) tokens=(\d+) prompts=(\d+)$/;

function countsLine(lines: readonly string[]): string | undefined {
  return lines.find((l) => COUNTS_RE.test(l));
}

describe('startProcess boot banner', () => {
  it('emits the counts banner, with the counts read from the live database', () => {
    const lines = boot(dataDir);

    const banner = countsLine(lines);
    expect(banner).toBeDefined();

    const match = COUNTS_RE.exec(banner as string);
    if (match === null) throw new Error('fixture: counts banner did not parse');
    const [, memory, projects, sessions, tokens, prompts] = match.map(Number);
    expect(memory).toBe(0);
    // Migration 0031 seeds the default project, so a fresh boot is never empty.
    expect(projects).toBeGreaterThanOrEqual(1);
    expect(sessions).toBe(0);
    expect(prompts).toBe(0);
    // The banner describes the state BEFORE the admin bootstrap, which is why
    // it can report zero tokens on a first boot.
    expect(tokens).toBe(0);
  });

  it('marks a fresh data directory as a first boot, before the counts banner', () => {
    const lines = boot(dataDir);

    expect(lines).toContain('[bootstrap] no prior state marker; treating as first boot');
    const marker = lines.findIndex((l) => l.includes('no prior state marker'));
    expect(marker).toBeLessThan(lines.findIndex((l) => l.startsWith('[bootstrap] counts: ')));
  });

  it('reports the persisted row counts on a later boot, not zeroes', () => {
    boot(dataDir); // first boot writes the state marker and the admin token
    const second = boot(dataDir);

    const match = COUNTS_RE.exec(countsLine(second) ?? '');
    expect(match).not.toBeNull();
    expect(Number(match?.[4])).toBe(1); // the token the first boot created
    // A no-op bootstrap says so, and the counts banner is not reset by it.
    expect(second).toContain(
      '[process] admin token present (1 token row(s)) → bootstrap is a no-op',
    );
  });

  it('boots the admin token from the environment and says where it came from', () => {
    const lines = boot(dataDir);
    expect(lines).toContain('[process] admin token bootstrapped from REMBRIC_ADMIN_TOKEN');
    // The banner must narrate the pre-bootstrap state, so it precedes it.
    const banner = lines.findIndex((l) => l.startsWith('[bootstrap] counts: '));
    expect(banner).toBeLessThan(
      lines.indexOf('[process] admin token bootstrapped from REMBRIC_ADMIN_TOKEN'),
    );
  });

  it('absorbs a second call in the same process instead of booting twice', () => {
    const lines = boot(dataDir);
    // The first boot opened the service graph; a second call must not produce a
    // second reaper, a second drain or a second banner.
    globalForTest.__rembricProcessStarted = true;
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    try {
      startProcess();
    } finally {
      spy.mockRestore();
    }

    expect(lines).toContain('[process] already started in this process → skipping re-entry');
    expect(lines.filter((l) => l.startsWith('[bootstrap] counts: '))).toHaveLength(1);
  });
});
