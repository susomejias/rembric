import { UpdateCheckService, type UpdateInfo } from '@rembric/core';

import { REMBRIC_VERSION } from '@/lib/version';

export type UpdateChecker = Pick<
  UpdateCheckService,
  'enabled' | 'lastCheckedAt' | 'peek' | 'checkNow'
>;

const globalForUpdates = globalThis as typeof globalThis & {
  __rembricUpdates?: UpdateCheckService;
};

const PREVIEW_VERSION_ENV = 'REMBRIC_UPDATE_PREVIEW_VERSION';
const PREVIEW_PUBLISHED_AT = new Date('2026-09-22T10:15:00.000Z');
const PREVIEW_CHANGELOG = [
  '### Features',
  '',
  '* **dashboard:** restore the one-click self-update flow',
  '* **memory:** keep the review state visible on the list rows',
  '',
  '### Bug Fixes',
  '',
  '* **mcp:** resolve project scope through the session pins',
].join('\n');

export function getUpdates(): UpdateChecker {
  const real = realUpdates();
  const preview = updatePreviewVersion();
  return preview === null ? real : previewChecker(real, preview);
}

export function updatePreviewVersion(): string | null {
  const value = process.env[PREVIEW_VERSION_ENV]?.trim();
  if (value === undefined || value === '') return null;
  return value;
}

function realUpdates(): UpdateCheckService {
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

function previewChecker(real: UpdateCheckService, latestVersion: string): UpdateChecker {
  const info: UpdateInfo = {
    currentVersion: REMBRIC_VERSION,
    latestVersion,
    publishedAt: PREVIEW_PUBLISHED_AT,
    changelog: PREVIEW_CHANGELOG,
    releaseUrl: `https://github.com/susomejias/rembric/releases/tag/server-v${latestVersion}`,
  };

  return {
    enabled: true,
    get lastCheckedAt() {
      return real.lastCheckedAt;
    },
    peek: () => info,
    checkNow: () => real.checkNow(),
  };
}
