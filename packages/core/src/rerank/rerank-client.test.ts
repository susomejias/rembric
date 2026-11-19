import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RerankClient, type RerankWorkerHandle } from '@rembric/core';

import type { RerankWorkerReply, RerankWorkerRequest } from './rerank-worker.js';

class FakeWorker extends EventEmitter implements RerankWorkerHandle {
  readonly requests: Extract<RerankWorkerRequest, { kind: 'score' }>[] = [];
  shutdown = false;

  postMessage(request: RerankWorkerRequest): void {
    if (request.kind === 'shutdown') this.shutdown = true;
    else this.requests.push(request);
  }

  reply(reply: RerankWorkerReply): void {
    this.emit('message', reply);
  }
}

const silent = () => {};

function harness(opts: { deadlineMs?: number; maxRestarts?: number } = {}) {
  const workers: FakeWorker[] = [];
  const client = new RerankClient({
    spawn: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    log: silent,
    ...opts,
  });
  return { client, workers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RerankClient', () => {
  it('returns the worker scores once the model is ready', async () => {
    const { client, workers } = harness();
    const ready = client.start();
    workers[0]!.reply({ kind: 'ready' });
    expect(await ready).toBe(true);

    const scored = client.score('q', ['a', 'b']);
    const req = workers[0]!.requests[0]!;
    expect(req).toMatchObject({ kind: 'score', query: 'q', documents: ['a', 'b'] });
    workers[0]!.reply({ kind: 'scores', id: req.id, scores: [0.9, 0.1] });
    expect(await scored).toEqual([0.9, 0.1]);
    expect(client.stats().reranked).toBe(1);
  });

  it('falls back before the model is ready, without posting anything', async () => {
    const { client, workers } = harness();
    void client.start();
    expect(await client.score('q', ['a'])).toBeNull();
    expect(workers[0]!.requests).toHaveLength(0);
    expect(client.stats().fallbacks['not-ready']).toBe(1);
  });

  it('falls back at the deadline and discards the late result', async () => {
    vi.useFakeTimers();
    const { client, workers } = harness({ deadlineMs: 300 });
    const ready = client.start();
    workers[0]!.reply({ kind: 'ready' });
    await ready;

    const scored = client.score('q', ['a']);
    await vi.advanceTimersByTimeAsync(300);
    expect(await scored).toBeNull();
    expect(client.stats().fallbacks.deadline).toBe(1);

    const late = workers[0]!.requests[0]!;
    workers[0]!.reply({ kind: 'scores', id: late.id, scores: [0.7] });
    expect(client.stats().reranked).toBe(0);
  });

  it('counts the queue wait against the deadline', async () => {
    vi.useFakeTimers();
    const { client, workers } = harness({ deadlineMs: 300 });
    const ready = client.start();
    workers[0]!.reply({ kind: 'ready' });
    await ready;

    const first = client.score('q', ['a']);
    const second = client.score('q', ['b']);
    await vi.advanceTimersByTimeAsync(250);
    workers[0]!.reply({ kind: 'scores', id: workers[0]!.requests[0]!.id, scores: [0.5] });
    expect(await first).toEqual([0.5]);
    await vi.advanceTimersByTimeAsync(50);
    expect(await second).toBeNull();
  });

  it('stands down when a full window cannot meet the deadline, freeing the worker', async () => {
    const { client, workers } = harness({ deadlineMs: 300 });
    const ready = client.start();
    workers[0]!.reply({ kind: 'ready' });
    await ready;

    client.calibrate(300);
    expect(workers[0]!.shutdown).toBe(true);
    expect(await client.score('q', ['a'])).toBeNull();
    expect(workers[0]!.requests).toHaveLength(0);
    expect(client.stats().fallbacks['too-slow']).toBe(1);
  });

  it('can be started again after standing down, and serves once it is calibrated to fit', async () => {
    const { client, workers } = harness({ deadlineMs: 300 });
    const first = client.start();
    workers[0]!.reply({ kind: 'ready' });
    await first;
    client.calibrate(400);

    const again = client.start();
    expect(workers).toHaveLength(2);
    expect(await client.score('q', ['a'])).toBeNull();
    expect(client.stats().fallbacks['too-slow']).toBe(1);
    workers[1]!.reply({ kind: 'ready' });
    expect(await again).toBe(true);

    client.calibrate(100);
    const scored = client.score('q', ['b']);
    workers[1]!.reply({ kind: 'scores', id: workers[1]!.requests[0]!.id, scores: [0.4] });
    expect(await scored).toEqual([0.4]);
  });

  it('stays closed: close wins over a later start', async () => {
    const { client, workers } = harness();
    const ready = client.start();
    workers[0]!.reply({ kind: 'ready' });
    await ready;
    client.calibrate(Number.POSITIVE_INFINITY);
    client.close();
    expect(await client.start()).toBe(false);
    expect(workers).toHaveLength(1);
  });

  it('serves a search unreranked at once when the queue ahead cannot clear before the deadline', async () => {
    const { client, workers } = harness({ deadlineMs: 300 });
    const ready = client.start();
    workers[0]!.reply({ kind: 'ready' });
    await ready;

    client.calibrate(140);
    const first = client.score('q', ['a']);
    const second = client.score('q', ['b']);
    expect(await client.score('q', ['c'])).toBeNull();
    expect(workers[0]!.requests.map((r) => r.documents[0])).toEqual(['a', 'b']);
    expect(client.stats().fallbacks.busy).toBe(1);

    const [a, b] = workers[0]!.requests;
    workers[0]!.reply({ kind: 'scores', id: a!.id, scores: [0.1] });
    workers[0]!.reply({ kind: 'scores', id: b!.id, scores: [0.2] });
    expect(await first).toEqual([0.1]);
    expect(await second).toEqual([0.2]);
    const third = client.score('q', ['d']);
    expect(workers[0]!.requests).toHaveLength(3);
    workers[0]!.reply({ kind: 'scores', id: workers[0]!.requests[2]!.id, scores: [0.3] });
    expect(await third).toEqual([0.3]);
  });

  it('queues every search until it has been calibrated', async () => {
    const { client, workers } = harness({ deadlineMs: 300 });
    const ready = client.start();
    workers[0]!.reply({ kind: 'ready' });
    await ready;
    for (let i = 0; i < 5; i++) void client.score('q', [`${i}`]);
    expect(workers[0]!.requests).toHaveLength(5);
    expect(client.stats().fallbacks.busy).toBe(0);
    client.close();
  });

  it('stays off after the model fails to load, and does not respawn', async () => {
    const { client, workers } = harness();
    const ready = client.start();
    workers[0]!.reply({ kind: 'load-failed', message: 'missing artifact' });
    expect(await ready).toBe(false);
    expect(await client.score('q', ['a'])).toBeNull();
    expect(client.stats().fallbacks['load-failed']).toBe(1);
    expect(workers).toHaveLength(1);
  });

  it('stamps each request with its expiry, and treats an expired reply as a deadline fallback', async () => {
    let clock = 1_000;
    const workers: FakeWorker[] = [];
    const client = new RerankClient({
      spawn: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      log: silent,
      deadlineMs: 300,
      now: () => clock,
    });
    const ready = client.start();
    workers[0]!.reply({ kind: 'ready' });
    await ready;
    const scored = client.score('q', ['a']);
    const req = workers[0]!.requests[0]!;
    expect(req.expiresAt).toBe(1_300);
    clock = 1_400;
    workers[0]!.reply({ kind: 'expired', id: req.id });
    expect(await scored).toBeNull();
    expect(client.stats().fallbacks.deadline).toBe(1);
  });

  it('closes by asking the worker to shut down, never by terminating it', async () => {
    const { client, workers } = harness();
    const ready = client.start();
    workers[0]!.reply({ kind: 'ready' });
    await ready;
    const inFlight = client.score('q', ['a']);
    client.close();
    expect(await inFlight).toBeNull();
    expect(workers[0]!.shutdown).toBe(true);
    expect(await client.score('q', ['a'])).toBeNull();
  });

  it('falls back on an inference error', async () => {
    const { client, workers } = harness();
    const ready = client.start();
    workers[0]!.reply({ kind: 'ready' });
    await ready;
    const scored = client.score('q', ['a']);
    workers[0]!.reply({ kind: 'failed', id: workers[0]!.requests[0]!.id, message: 'boom' });
    expect(await scored).toBeNull();
    expect(client.stats().fallbacks['inference-failed']).toBe(1);
  });

  it('restarts an exited worker, falls back for its in-flight calls, and stops at the bound', async () => {
    const { client, workers } = harness({ maxRestarts: 2 });
    const ready = client.start();
    workers[0]!.reply({ kind: 'ready' });
    await ready;

    const inFlight = client.score('q', ['a']);
    workers[0]!.emit('exit', 1);
    expect(await inFlight).toBeNull();
    expect(client.stats().fallbacks['worker-exited']).toBe(1);
    expect(workers).toHaveLength(2);

    const again = client.start();
    workers[1]!.reply({ kind: 'ready' });
    expect(await again).toBe(true);

    workers[1]!.emit('exit', 1);
    expect(workers).toHaveLength(3);
    workers[2]!.emit('exit', 1);
    expect(workers).toHaveLength(3);
    expect(await client.start()).toBe(false);
  });

  it('bounds restarts per time window, not for the life of the process', async () => {
    let clock = 0;
    const workers: FakeWorker[] = [];
    const client = new RerankClient({
      spawn: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      log: silent,
      maxRestarts: 2,
      now: () => clock,
    });
    void client.start();
    for (let i = 0; i < 5; i++) {
      workers.at(-1)!.emit('exit', 1);
      clock += 11 * 60_000;
    }
    expect(workers).toHaveLength(6);
    workers.at(-1)!.reply({ kind: 'ready' });
    expect(await client.start()).toBe(true);
  });

  it('reports a worker that keeps exiting as worker-exited, not as a load failure', async () => {
    const { client, workers } = harness({ maxRestarts: 1 });
    void client.start();
    workers[0]!.emit('exit', 1);
    workers[1]!.emit('exit', 1);
    expect(await client.score('q', ['a'])).toBeNull();
    expect(client.stats().fallbacks['worker-exited']).toBeGreaterThan(0);
    expect(client.stats().fallbacks['load-failed']).toBe(0);
  });

  it('ignores messages from a worker it already replaced', async () => {
    const { client, workers } = harness();
    void client.start();
    workers[0]!.emit('exit', 1);
    workers[0]!.reply({ kind: 'ready' });
    expect(await client.score('q', ['a'])).toBeNull();
    expect(client.stats().fallbacks['not-ready']).toBe(1);
    expect(workers[1]!.requests).toHaveLength(0);
    workers[1]!.reply({ kind: 'ready' });
    expect(await client.start()).toBe(true);
  });
});
