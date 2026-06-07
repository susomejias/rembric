/**
 * Release update check against the GitHub Releases API.
 *
 * Lazy: nothing runs at boot. `peek()` returns the cached result
 * synchronously and kicks a background refresh when the cache is stale.
 * Failures are silent by contract (air-gapped hosts must see zero noise);
 * see openspec/specs/self-update/spec.md.
 */

import { REMBRIC_VERSION } from '../version.js';

const DEFAULT_RELEASES_URL = 'https://api.github.com/repos/susomejias/rembric/releases?per_page=30';
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Server releases are tagged `server-v<semver>` (release-please multi-component). */
const SERVER_TAG_PREFIX = 'server-v';

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  publishedAt: Date | null;
  /** Markdown body of the GitHub release (release-please changelog). */
  changelog: string;
  releaseUrl: string;
}

interface GithubRelease {
  tag_name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
}

export interface UpdateCheckOptions {
  currentVersion?: string;
  /** `false` disables the check entirely (REMBRIC_UPDATE_CHECK=off). */
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  releasesUrl?: string;
  intervalMs?: number;
  now?: () => number;
}

export type ManualCheckOutcome = 'update' | 'none' | 'error';

export function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}

export class UpdateCheckService {
  private readonly currentVersion: string;
  private readonly checkEnabled: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly releasesUrl: string;
  private readonly intervalMs: number;
  private readonly now: () => number;

  private cache: UpdateInfo | null = null;
  private lastCheckedAtMs = 0;
  private lastFetchFailed = false;
  private etag: string | null = null;
  private inflight: Promise<UpdateInfo | null> | null = null;

  constructor(opts: UpdateCheckOptions = {}) {
    this.currentVersion = opts.currentVersion ?? REMBRIC_VERSION;
    this.checkEnabled = opts.enabled ?? process.env['REMBRIC_UPDATE_CHECK'] !== 'off';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.releasesUrl = opts.releasesUrl ?? DEFAULT_RELEASES_URL;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.checkEnabled;
  }

  /** Most recent check (manual or automatic) this process lifetime. */
  get lastCheckedAt(): Date | null {
    return this.lastCheckedAtMs ? new Date(this.lastCheckedAtMs) : null;
  }

  /**
   * Cached update info, refreshing in the background when stale. Returns
   * `null` until a refresh has found a strictly newer version.
   */
  peek(): UpdateInfo | null {
    if (!this.checkEnabled) return null;
    if (this.now() - this.lastCheckedAtMs >= this.intervalMs && !this.inflight) {
      // Background kick; silent-failure contract means errors are dropped.
      void this.refresh().catch(() => {});
    }
    return this.cache;
  }

  /** Refresh now (awaitable; used by tests and the update view). */
  async refresh(): Promise<UpdateInfo | null> {
    if (!this.checkEnabled) return null;
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Operator-initiated check: bypasses the 24h window and, unlike the
   * automatic path, reports whether GitHub was actually reached.
   */
  async checkNow(): Promise<{ outcome: ManualCheckOutcome; info: UpdateInfo | null }> {
    if (!this.checkEnabled) return { outcome: 'none', info: null };
    const info = await this.refresh();
    if (this.lastFetchFailed) return { outcome: 'error', info };
    return { outcome: info ? 'update' : 'none', info };
  }

  private async doRefresh(): Promise<UpdateInfo | null> {
    this.lastCheckedAtMs = this.now();
    try {
      const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
      if (this.etag) headers['if-none-match'] = this.etag;
      const res = await this.fetchImpl(this.releasesUrl, { headers });
      if (res.status === 304) {
        this.lastFetchFailed = false;
        return this.cache;
      }
      if (!res.ok) {
        this.lastFetchFailed = true;
        return this.cache;
      }
      this.etag = res.headers.get('etag');
      const releases = (await res.json()) as GithubRelease[];
      if (!Array.isArray(releases)) {
        this.lastFetchFailed = true;
        return this.cache;
      }
      this.lastFetchFailed = false;
      const latest = releases.find(
        (r) =>
          !r.draft &&
          !r.prerelease &&
          typeof r.tag_name === 'string' &&
          r.tag_name.startsWith(SERVER_TAG_PREFIX) &&
          parseSemver(r.tag_name.slice(SERVER_TAG_PREFIX.length)) !== null,
      );
      if (!latest?.tag_name) return this.cache;
      const version = latest.tag_name.slice(SERVER_TAG_PREFIX.length);
      this.cache = semverGt(version, this.currentVersion)
        ? {
            currentVersion: this.currentVersion,
            latestVersion: version,
            publishedAt: latest.published_at ? new Date(latest.published_at) : null,
            changelog: latest.body ?? '',
            releaseUrl: latest.html_url ?? '',
          }
        : null;
      return this.cache;
    } catch {
      this.lastFetchFailed = true;
      return this.cache;
    }
  }
}
