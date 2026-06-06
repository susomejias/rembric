/**
 * Self-update capability detection — the four-quadrant contract.
 *
 * Detection is strictly runtime and side-effect free: no socket on disk
 * means the Docker code path is never entered (zero-action compatibility).
 * A socket that exists but cannot be used degrades to `manual` with a
 * single informational log line, never an error.
 */

import { existsSync } from 'node:fs';
import { hostname } from 'node:os';

import { DEFAULT_DOCKER_SOCKET, DockerEngineApi } from './engine-api.js';

export type SelfUpdateState = 'available' | 'pinned' | 'manual';

export type SelfUpdateReason =
  | 'ok'
  | 'no-socket'
  | 'socket-unusable'
  | 'self-not-found'
  | 'pinned-tag';

export interface SelfUpdateCapability {
  state: SelfUpdateState;
  reason: SelfUpdateReason;
  /** Resolved own container id (when inspection succeeded). */
  containerId?: string;
  /** Image repo without tag, e.g. `ghcr.io/susomejias/rembric`. */
  imageRepo?: string;
  imageTag?: string;
}

export interface CapabilityDetectorOptions {
  socketPath?: string;
  engineFactory?: (socketPath: string) => Pick<DockerEngineApi, 'ping' | 'inspectContainer'>;
  env?: NodeJS.ProcessEnv;
  hostnameFn?: () => string;
  /** Container name fallback when the hostname is not the container id. */
  containerName?: string;
  log?: (line: string) => void;
  /** Cache TTL for `detectCached()`; capability is consulted per page render. */
  cacheTtlMs?: number;
  now?: () => number;
}

export function splitImageRef(ref: string): { repo: string; tag: string } {
  // The tag separator is the last ':' AFTER the last '/' (registries carry ports).
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) return { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { repo: ref, tag: 'latest' };
}

export function isPinnedTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+$/.test(tag);
}

export class CapabilityDetector {
  private readonly socketPath: string;
  private readonly engineFactory: NonNullable<CapabilityDetectorOptions['engineFactory']>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly hostnameFn: () => string;
  private readonly containerName: string;
  private readonly log: (line: string) => void;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;

  private warned = false;
  private cached: SelfUpdateCapability | null = null;
  private cachedAt = 0;
  private inflight: Promise<SelfUpdateCapability> | null = null;

  constructor(opts: CapabilityDetectorOptions = {}) {
    this.socketPath = opts.socketPath ?? DEFAULT_DOCKER_SOCKET;
    this.engineFactory = opts.engineFactory ?? ((p) => new DockerEngineApi(p));
    this.env = opts.env ?? process.env;
    this.hostnameFn = opts.hostnameFn ?? hostname;
    this.containerName = opts.containerName ?? 'rembric';
    this.log = opts.log ?? ((line) => console.error(line));
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  async detect(): Promise<SelfUpdateCapability> {
    if (!existsSync(this.socketPath)) {
      return { state: 'manual', reason: 'no-socket' };
    }

    const engine = this.engineFactory(this.socketPath);
    if (!(await engine.ping())) {
      if (!this.warned) {
        this.warned = true;
        this.log(
          `  ℹ docker socket at ${this.socketPath} is mounted but not usable (check group_add); one-click updates disabled`,
        );
      }
      return { state: 'manual', reason: 'socket-unusable' };
    }

    let inspect: Awaited<ReturnType<typeof engine.inspectContainer>> | null = null;
    for (const candidate of [this.hostnameFn(), this.containerName]) {
      try {
        inspect = await engine.inspectContainer(candidate);
        break;
      } catch {
        /* try the next candidate */
      }
    }
    if (!inspect) {
      return { state: 'manual', reason: 'self-not-found' };
    }

    const { repo, tag } = splitImageRef(inspect.Config.Image);
    // Ground truth is the tag the container was created from; the
    // REMBRIC_VERSION env var (compose pin via env_file) is a cross-check.
    if (isPinnedTag(tag) || (tag === 'latest' && isPinnedTag(this.env['REMBRIC_VERSION'] ?? ''))) {
      return {
        state: 'pinned',
        reason: 'pinned-tag',
        containerId: inspect.Id,
        imageRepo: repo,
        imageTag: isPinnedTag(tag) ? tag : (this.env['REMBRIC_VERSION'] ?? tag),
      };
    }

    return {
      state: 'available',
      reason: 'ok',
      containerId: inspect.Id,
      imageRepo: repo,
      imageTag: tag,
    };
  }

  /** TTL-cached detection — consulted on every dashboard page render. */
  async detectCached(): Promise<SelfUpdateCapability> {
    if (this.cached && this.now() - this.cachedAt < this.cacheTtlMs) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = this.detect()
      .then((cap) => {
        this.cached = cap;
        this.cachedAt = this.now();
        return cap;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}
