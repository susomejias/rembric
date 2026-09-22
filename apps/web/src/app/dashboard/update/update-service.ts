import { UpdateCheckService } from '@rembric/core';

import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The release-check service, one instance per process.
 *
 * The service is stateful in a way a per-render construction would destroy: it
 * memoizes the GitHub response, the ETag and the 24h window, and `peek()` both
 * reads that cache and kicks the refresh when it is stale. A fresh instance on
 * every request would therefore never see a cached result — every render would
 * start a check and show "up to date" while it ran.
 *
 * `globalThis` rather than a module-local is the same choice `lib/db.ts` makes
 * and for the same reason: Next re-evaluates modules on every HMR edit, and a
 * second instance over one release feed holds a second, disagreeing cache.
 *
 * `currentVersion` is injected, not resolved inside the service: the running
 * version lives in the application's manifest, and the domain package must not
 * know this app's filesystem layout. `REMBRIC_UPDATE_CHECK_URL` stays a smoke
 * seam.
 */

const globalForUpdates = globalThis as typeof globalThis & {
  __rembricUpdates?: UpdateCheckService;
};

export function getUpdates(): UpdateCheckService {
  const cached = globalForUpdates.__rembricUpdates;
  if (cached !== undefined) return cached;

  const built = new UpdateCheckService({
    currentVersion: REMBRIC_VERSION,
    enabled: process.env['REMBRIC_UPDATE_CHECK'] !== 'off',
    releasesUrl: process.env['REMBRIC_UPDATE_CHECK_URL'],
  });
  globalForUpdates.__rembricUpdates = built;
  return built;
}
