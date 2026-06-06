/**
 * Minimal Docker Engine API client over the unix socket.
 *
 * Implemented with `node:http` (`socketPath`) on purpose: the self-update
 * feature is contractually zero-dependency (openspec/specs/self-update).
 * Only the handful of endpoints the updater needs are covered.
 */

import { request as httpRequest } from 'node:http';

export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';
/** Oldest Engine API version exposing everything we call (Docker 20.10+). */
export const ENGINE_API_VERSION = 'v1.41';

export class EngineApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null,
  ) {
    super(message);
    this.name = 'EngineApiError';
  }
}

export interface PullProgressEvent {
  status?: string;
  id?: string;
  progressDetail?: { current?: number; total?: number };
  error?: string;
}

/** Subset of `GET /containers/{id}/json` the updater relies on. */
export interface ContainerInspect {
  Id: string;
  /** Leading-slash container name, e.g. `/rembric`. */
  Name: string;
  State?: {
    Running?: boolean;
    Health?: { Status?: string };
  };
  Config: {
    Image: string;
    Env?: string[];
    Labels?: Record<string, string>;
    ExposedPorts?: Record<string, unknown>;
    Entrypoint?: string[] | string | null;
    Cmd?: string[] | string | null;
    User?: string;
    Hostname?: string;
    WorkingDir?: string;
    Healthcheck?: unknown;
  };
  HostConfig: Record<string, unknown>;
  NetworkSettings?: {
    Networks?: Record<string, { Aliases?: string[] | null; IPAddress?: string }>;
  };
}

interface EngineResponse {
  statusCode: number;
  body: string;
}

export class DockerEngineApi {
  constructor(private readonly socketPath: string = DEFAULT_DOCKER_SOCKET) {}

  async ping(): Promise<boolean> {
    try {
      const res = await this.request('GET', '/_ping');
      return res.statusCode === 200;
    } catch {
      return false;
    }
  }

  async inspectContainer(idOrName: string): Promise<ContainerInspect> {
    const res = await this.request('GET', `/containers/${encodeURIComponent(idOrName)}/json`);
    this.assertOk(res, `inspect ${idOrName}`);
    return JSON.parse(res.body) as ContainerInspect;
  }

  /**
   * Pull `repo:tag`, streaming the daemon's NDJSON progress events into
   * `onProgress`. Resolves when the stream ends; rejects on a stream-level
   * `error` event from the daemon.
   */
  async pullImage(
    repo: string,
    tag: string,
    onProgress?: (ev: PullProgressEvent) => void,
  ): Promise<void> {
    const path = `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`;
    const res = await this.requestStreaming('POST', path, (line) => {
      let ev: PullProgressEvent;
      try {
        ev = JSON.parse(line) as PullProgressEvent;
      } catch {
        return;
      }
      if (ev.error) throw new EngineApiError(`pull failed: ${ev.error}`, null);
      onProgress?.(ev);
    });
    if (res.statusCode !== 200) {
      throw new EngineApiError(`pull failed with HTTP ${res.statusCode}`, res.statusCode);
    }
  }

  async createContainer(name: string, payload: unknown): Promise<{ Id: string }> {
    const res = await this.request(
      'POST',
      `/containers/create?name=${encodeURIComponent(name)}`,
      payload,
    );
    this.assertOk(res, `create ${name}`);
    return JSON.parse(res.body) as { Id: string };
  }

  async startContainer(id: string): Promise<void> {
    const res = await this.request('POST', `/containers/${encodeURIComponent(id)}/start`);
    // 304 = already started.
    if (res.statusCode !== 204 && res.statusCode !== 304) this.assertOk(res, `start ${id}`);
  }

  async stopContainer(id: string, timeoutSec = 30): Promise<void> {
    const res = await this.request(
      'POST',
      `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSec}`,
    );
    // 304 = already stopped.
    if (res.statusCode !== 204 && res.statusCode !== 304) this.assertOk(res, `stop ${id}`);
  }

  async renameContainer(id: string, name: string): Promise<void> {
    const res = await this.request(
      'POST',
      `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`,
    );
    this.assertOk(res, `rename ${id} → ${name}`);
  }

  async removeContainer(id: string, force = false): Promise<void> {
    const res = await this.request(
      'DELETE',
      `/containers/${encodeURIComponent(id)}?force=${force ? 'true' : 'false'}&v=false`,
    );
    if (res.statusCode !== 204) this.assertOk(res, `remove ${id}`);
  }

  private assertOk(res: EngineResponse, what: string): void {
    if (res.statusCode >= 200 && res.statusCode < 300) return;
    let message = `engine API ${what} failed with HTTP ${res.statusCode}`;
    try {
      const parsed = JSON.parse(res.body) as { message?: string };
      if (parsed.message) message += `: ${parsed.message}`;
    } catch {
      /* non-JSON error body */
    }
    throw new EngineApiError(message, res.statusCode);
  }

  private request(method: string, path: string, body?: unknown): Promise<EngineResponse> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method,
          path: `/${ENGINE_API_VERSION}${path}`,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private requestStreaming(
    method: string,
    path: string,
    onLine: (line: string) => void,
  ): Promise<{ statusCode: number }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { socketPath: this.socketPath, method, path: `/${ENGINE_API_VERSION}${path}` },
        (res) => {
          let buffer = '';
          let failed: Error | null = null;
          res.on('data', (c: Buffer) => {
            if (failed) return;
            buffer += c.toString('utf8');
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (!line) continue;
              try {
                onLine(line);
              } catch (err) {
                failed = err instanceof Error ? err : new Error(String(err));
                res.destroy();
              }
            }
          });
          res.on('end', () => {
            if (failed) return reject(failed);
            const tail = buffer.trim();
            if (tail) {
              try {
                onLine(tail);
              } catch (err) {
                return reject(err instanceof Error ? err : new Error(String(err)));
              }
            }
            resolve({ statusCode: res.statusCode ?? 0 });
          });
          res.on('close', () => {
            if (failed) reject(failed);
          });
          res.on('error', (err) => reject(failed ?? err));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
}
