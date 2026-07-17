import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DockerEngineApi,
  EngineApiError,
  ENGINE_API_VERSION,
  type PruneFilters,
} from './engine-api.js';

interface Seen {
  method: string;
  url: string;
  body: string;
}

describe('DockerEngineApi', () => {
  let dir: string;
  let socketPath: string;
  let server: Server;
  const seen: Seen[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rembric-engine-'));
    socketPath = join(dir, 'docker.sock');
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const url = req.url ?? '';
        if (url.endsWith('/_ping')) {
          res.writeHead(200).end('OK');
        } else if (url.includes('/containers/self123/json')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              Id: 'self123',
              Name: '/rembric',
              Config: { Image: 'ghcr.io/susomejias/rembric:latest' },
              HostConfig: {},
            }),
          );
        } else if (url.includes('/containers/missing/json')) {
          res
            .writeHead(404, { 'content-type': 'application/json' })
            .end(JSON.stringify({ message: 'No such container' }));
        } else if (url.includes('/images/create')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write(JSON.stringify({ status: 'Pulling fs layer', id: 'aaa' }) + '\n');
          res.write(
            JSON.stringify({
              status: 'Downloading',
              id: 'aaa',
              progressDetail: { current: 5, total: 10 },
            }) + '\n',
          );
          res.end(JSON.stringify({ status: 'Status: Downloaded newer image' }) + '\n');
        } else if (url.includes('/containers/prune')) {
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ContainersDeleted: ['dead1'], SpaceReclaimed: 2048 }));
        } else if (url.includes('/images/prune')) {
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ImagesDeleted: null, SpaceReclaimed: 0 }));
        } else if (url.includes('/containers/create')) {
          res
            .writeHead(201, { 'content-type': 'application/json' })
            .end(JSON.stringify({ Id: 'new456' }));
        } else if (/\/(start|stop)/.test(url)) {
          res.writeHead(204).end();
        } else if (url.includes('/rename')) {
          res.writeHead(204).end();
        } else if (req.method === 'DELETE') {
          res.writeHead(204).end();
        } else {
          res.writeHead(500).end('unexpected');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('pings', async () => {
    const api = new DockerEngineApi(socketPath);
    expect(await api.ping()).toBe(true);
  });

  it('ping returns false when the socket does not exist', async () => {
    const api = new DockerEngineApi(join(dir, 'nope.sock'));
    expect(await api.ping()).toBe(false);
  });

  it('prefixes every path with the pinned API version', async () => {
    const api = new DockerEngineApi(socketPath);
    await api.ping();
    expect(seen.at(-1)?.url).toBe(`/${ENGINE_API_VERSION}/_ping`);
  });

  it('inspects a container', async () => {
    const api = new DockerEngineApi(socketPath);
    const c = await api.inspectContainer('self123');
    expect(c.Name).toBe('/rembric');
    expect(c.Config.Image).toBe('ghcr.io/susomejias/rembric:latest');
  });

  it('throws EngineApiError with the daemon message on 404', async () => {
    const api = new DockerEngineApi(socketPath);
    await expect(api.inspectContainer('missing')).rejects.toThrowError(EngineApiError);
    await expect(api.inspectContainer('missing')).rejects.toThrow(/No such container/);
  });

  it('streams pull progress events', async () => {
    const api = new DockerEngineApi(socketPath);
    const events: string[] = [];
    await api.pullImage('ghcr.io/susomejias/rembric', '0.22.0', (ev) => {
      if (ev.status) events.push(ev.status);
    });
    expect(events).toContain('Downloading');
    expect(seen.at(-1)?.url).toContain('fromImage=ghcr.io%2Fsusomejias%2Frembric');
    expect(seen.at(-1)?.url).toContain('tag=0.22.0');
  });

  it('prunes containers with the exact label-scoped filter string', async () => {
    const api = new DockerEngineApi(socketPath);
    const r = await api.pruneContainers({ label: ['rembric.upgrader=1'] });
    expect(r.ContainersDeleted).toEqual(['dead1']);
    expect(r.SpaceReclaimed).toBe(2048);
    expect(seen.at(-1)?.url).toBe(
      `/${ENGINE_API_VERSION}/containers/prune?filters=${encodeURIComponent('{"label":["rembric.upgrader=1"]}')}`,
    );
  });

  it('prunes images and tolerates a null ImagesDeleted', async () => {
    const api = new DockerEngineApi(socketPath);
    const r = await api.pruneImages({ dangling: ['true'], label: ['rembric.stage=runtime'] });
    expect(r.ImagesDeleted).toBeNull();
    const url = decodeURIComponent(seen.at(-1)?.url ?? '');
    expect(url).toContain('/images/prune?filters=');
    expect(url).toContain('"dangling":["true"]');
    expect(url).toContain('"label":["rembric.stage=runtime"]');
  });

  it('refuses an unscoped prune before any socket I/O', async () => {
    const api = new DockerEngineApi(socketPath);
    const before = seen.length;
    // The PruneFilters type already rejects these shapes at compile time; the
    // casts exist to exercise the runtime guard that protects JS callers.
    const unscoped = {} as PruneFilters;
    const noLabel = { dangling: ['true'] } as unknown as PruneFilters;
    const emptyLabel = { label: [] } as unknown as PruneFilters;
    const stringLabel = { label: 'rembric.upgrader=1' } as unknown as PruneFilters;
    await expect(api.pruneContainers(unscoped)).rejects.toThrow(/label/);
    await expect(api.pruneImages(noLabel)).rejects.toThrow(/label/);
    await expect(api.pruneContainers(emptyLabel)).rejects.toThrow(/label/);
    await expect(api.pruneImages({ label: [' '] })).rejects.toThrow(/label/);
    // A string label from an untyped caller must hit the guard's
    // EngineApiError, not a raw TypeError from labels.some().
    await expect(api.pruneContainers(stringLabel)).rejects.toThrow(EngineApiError);
    expect(seen.length).toBe(before);
  });

  it('creates, starts, stops, renames, removes', async () => {
    const api = new DockerEngineApi(socketPath);
    const created = await api.createContainer('rembric-upgrader-1', { Image: 'x' });
    expect(created.Id).toBe('new456');
    expect(seen.at(-1)?.body).toContain('"Image":"x"');
    await api.startContainer('new456');
    await api.stopContainer('self123', 10);
    expect(seen.at(-1)?.url).toContain('t=10');
    await api.renameContainer('self123', 'rembric-old');
    expect(seen.at(-1)?.url).toContain('name=rembric-old');
    await api.removeContainer('self123', true);
    expect(seen.at(-1)?.url).toContain('force=true');
  });
});
