import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET } from '../app/healthz/route';
import { REMBRIC_VERSION } from '../lib/version';

/**
 * `app/healthz/route.ts` — the container health probe. `Dockerfile`'s
 * HEALTHCHECK (and both compose files) fetch this URL, so a route that answered
 * from a cache or from a dead connection would report a healthy process forever.
 *
 * The probe opens the live database through `lib/db.ts`, which caches its handle
 * on `globalThis` (Next re-evaluates modules on HMR), so each case resets that
 * slot and owns a fresh temp data dir.
 *
 * DIVERGENCE FROM `apps/server`'s `createHealthzHandler`, asserted below rather
 * than hidden: that handler refused an unauthenticated caller with
 * `missing_token` (401) and answered `db_unavailable` (503) when the database
 * could not be read. This route carries neither gate nor catch — the probe is
 * unauthenticated and a dead database throws instead of returning a body. See
 * the batch report.
 */

type MutableGlobal = typeof globalThis & {
  __rembricDb?: { raw: { close: () => void }; close: () => void };
};

const globalForDb = globalThis as MutableGlobal;

function resetDbGlobal(): void {
  try {
    globalForDb.__rembricDb?.close();
  } catch {
    // ignore double-close of a fixture the process already closed
  }
  delete globalForDb.__rembricDb;
}

let dataDir: string;

beforeEach(() => {
  resetDbGlobal();
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-healthz-'));
  process.env['REMBRIC_DATA_DIR'] = dataDir;
});

afterEach(() => {
  resetDbGlobal();
  delete process.env['REMBRIC_DATA_DIR'];
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /healthz', () => {
  it('answers 200 with the running release identity', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: REMBRIC_VERSION });
  });

  it('reports a version that parses as a release, never the 0.0.0 sentinel', () => {
    // `lib/version.ts` reads `apps/web/package.json` — the release identity
    // release-please bumps — so a checkout always resolves the real number.
    expect(REMBRIC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(REMBRIC_VERSION).not.toBe('0.0.0');
  });

  it('opens the resolved data dir, applying migrations', () => {
    expect(existsSync(join(dataDir, 'data.db'))).toBe(false);
    expect(GET().status).toBe(200);
    expect(existsSync(join(dataDir, 'data.db'))).toBe(true);
  });

  it('serves without an Authorization header (the port dropped the bearer gate)', async () => {
    // `apps/server` answered `missing_token` here. The assertion records the
    // behaviour this route actually has, so a future change back to a
    // token-gated probe shows up as a failing test rather than as silence.
    const response = GET();
    const payload = (await response.json()) as { ok?: boolean };
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
  });

  it('reads the database on every call — a closed connection is not answered from a cache', () => {
    expect(GET().status).toBe(200);
    const handle = globalForDb.__rembricDb;
    if (!handle) throw new Error('fixture: GET /healthz did not open the database');
    handle.raw.close(); // the cached handle survives; only its connection dies

    expect(() => GET()).toThrow();
  });
});
