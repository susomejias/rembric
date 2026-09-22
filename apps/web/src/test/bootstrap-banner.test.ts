import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startProcess } from '../lib/process';

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { raw: { close: () => void }; close: () => void };
  __rembricProcessStarted?: boolean;
};

const globalForTest = globalThis as MutableGlobal;

function resetBootGlobals(): void {
  try {
    globalForTest.__rembricDb?.close();
  } catch {}
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
    expect(projects).toBeGreaterThanOrEqual(1);
    expect(sessions).toBe(0);
    expect(prompts).toBe(0);
    expect(tokens).toBe(0);
  });

  it('marks a fresh data directory as a first boot, before the counts banner', () => {
    const lines = boot(dataDir);

    expect(lines).toContain('[bootstrap] no prior state marker; treating as first boot');
    const marker = lines.findIndex((l) => l.includes('no prior state marker'));
    expect(marker).toBeLessThan(lines.findIndex((l) => l.startsWith('[bootstrap] counts: ')));
  });

  it('reports the persisted row counts on a later boot, not zeroes', () => {
    boot(dataDir);
    const second = boot(dataDir);

    const match = COUNTS_RE.exec(countsLine(second) ?? '');
    expect(match).not.toBeNull();
    expect(Number(match?.[4])).toBe(1);
    expect(second).toContain(
      '[process] admin token present (1 token row(s)) → bootstrap is a no-op',
    );
  });

  it('boots the admin token from the environment and says where it came from', () => {
    const lines = boot(dataDir);
    expect(lines).toContain('[process] admin token bootstrapped from REMBRIC_ADMIN_TOKEN');
    const banner = lines.findIndex((l) => l.startsWith('[bootstrap] counts: '));
    expect(banner).toBeLessThan(
      lines.indexOf('[process] admin token bootstrapped from REMBRIC_ADMIN_TOKEN'),
    );
  });

  it('absorbs a second call in the same process instead of booting twice', () => {
    const lines = boot(dataDir);
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
