import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RerankClient } from '@rembric/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getServices } from '../lib/services';

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { raw: { close: () => void }; close: () => void };
};

const globalForApp = globalThis as MutableGlobal;

function resetAppGlobals(): void {
  try {
    globalForApp.__rembricDb?.close();
  } catch {}
  delete globalForApp.__rembricServices;
  delete globalForApp.__rembricDb;
}

let dataDir: string;

beforeEach(() => {
  resetAppGlobals();
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-rerank-switch-'));
  process.env['REMBRIC_DATA_DIR'] = dataDir;
});

afterEach(() => {
  resetAppGlobals();
  delete process.env['REMBRIC_DATA_DIR'];
  delete process.env['REMBRIC_RERANK'];
  rmSync(dataDir, { recursive: true, force: true });
});

describe('REMBRIC_RERANK', () => {
  it('builds no reranker when set to off', () => {
    process.env['REMBRIC_RERANK'] = 'off';
    expect(getServices().reranker).toBeNull();
  });

  it('builds the reranker when unset or set to anything else', () => {
    expect(getServices().reranker).toBeInstanceOf(RerankClient);
    resetAppGlobals();
    process.env['REMBRIC_RERANK'] = 'on';
    expect(getServices().reranker).toBeInstanceOf(RerankClient);
  });
});
