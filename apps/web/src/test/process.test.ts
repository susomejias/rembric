import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataLossGuardError } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startProcess } from '../lib/process';

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { close?: () => void };
  __rembricProcessStarted?: boolean;
};

const globalForTest = globalThis as MutableGlobal;
const MARKER = '.rembric-state.json';

function resetProcessGlobals(): void {
  try {
    globalForTest.__rembricDb?.close?.();
  } catch {}
  delete globalForTest.__rembricServices;
  delete globalForTest.__rembricDb;
  delete globalForTest.__rembricProcessStarted;
}

function seedMarker(counts: Record<string, number>): void {
  writeFileSync(
    join(dataDir, MARKER),
    JSON.stringify({ version: 1, last_seen_at: Date.now(), counts }),
  );
}

function readMarker(): { version: number; counts: Record<string, number> } {
  return JSON.parse(readFileSync(join(dataDir, MARKER), 'utf8')) as {
    version: number;
    counts: Record<string, number>;
  };
}

function captureErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    lines.push(args.map(String).join(' '));
  });
  return { lines, restore: () => spy.mockRestore() };
}

let dataDir: string;

beforeEach(() => {
  resetProcessGlobals();
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-process-'));
  process.env['REMBRIC_DATA_DIR'] = dataDir;
  delete process.env['REMBRIC_ALLOW_DATA_SHRINKAGE'];
  delete process.env['REMBRIC_SESSION_SECRET'];
  delete process.env['REMBRIC_ADMIN_TOKEN'];
});

afterEach(() => {
  resetProcessGlobals();
  delete process.env['REMBRIC_DATA_DIR'];
  delete process.env['REMBRIC_ALLOW_DATA_SHRINKAGE'];
  delete process.env['REMBRIC_SESSION_SECRET'];
  delete process.env['REMBRIC_ADMIN_TOKEN'];
  rmSync(dataDir, { recursive: true, force: true });
});

describe('startProcess data-loss guard', () => {
  it('refuses to start (exit 78) when operator-visible tables shrank by >= 50%', () => {
    seedMarker({ memory: 80, projects: 5, sessions: 30, tokens: 4, prompts: 1 });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errors = captureErrors();

    try {
      let thrown: unknown;
      try {
        startProcess();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(DataLossGuardError);
      expect(exitSpy).toHaveBeenCalledWith(78);
    } finally {
      errors.restore();
      exitSpy.mockRestore();
    }
  });

  it('proceeds and rewrites the marker when REMBRIC_ALLOW_DATA_SHRINKAGE=1', () => {
    seedMarker({ memory: 80, projects: 5, sessions: 30, tokens: 4, prompts: 1 });
    process.env['REMBRIC_ALLOW_DATA_SHRINKAGE'] = '1';
    const errors = captureErrors();

    try {
      expect(() => startProcess()).not.toThrow();
    } finally {
      errors.restore();
    }

    expect(errors.lines.some((l) => l.includes('data-loss guard bypassed'))).toBe(true);
    expect(readMarker().counts['memory']).toBe(0);
  });

  it('writes the first-boot marker and logs the counts banner', () => {
    const errors = captureErrors();

    try {
      expect(() => startProcess()).not.toThrow();
    } finally {
      errors.restore();
    }

    expect(errors.lines).toContain(
      '[bootstrap] counts: memory=0 projects=1 sessions=0 tokens=0 prompts=0',
    );
    const marker = readMarker();
    expect(marker.version).toBe(1);
    expect(marker.counts['projects']).toBe(1);
  });
});
