import { UpdateCheckService } from '@rembric/core';

import { REMBRIC_VERSION } from '@/lib/version';

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
