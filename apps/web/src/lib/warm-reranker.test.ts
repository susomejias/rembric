import { RERANK_DEADLINE_MS, RERANK_WINDOW } from '@rembric/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { warmReranker } from './process';

function fake(
  scores: (number[] | null)[],
  opts: { ready?: boolean[]; backlog?: () => boolean } = {},
) {
  const readies = [...(opts.ready ?? [true])];
  const start = vi.fn(() => Promise.resolve(readies.shift() ?? false));
  const score = vi.fn((_q: string, docs: readonly string[]) => {
    expect(docs).toHaveLength(RERANK_WINDOW);
    return Promise.resolve(scores.length > 0 ? scores.shift()! : null);
  });
  const calibrate = vi.fn();
  return {
    services: {
      reranker: { start, score, calibrate } as never,
      hasEmbeddingBacklog: opts.backlog ?? (() => false),
    },
    score,
    calibrate,
    start,
  };
}

const logged = (log: { mock: { calls: unknown[][] } }) =>
  log.mock.calls.map((c) => String(c[0])).join('\n');

describe('warmReranker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('times a full window after the model is ready', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { services, score, calibrate } = fake([[0.1], [0.2], [0.2], [0.2]]);
    await warmReranker(services);
    expect(score).toHaveBeenCalledTimes(4);
    expect(logged(log)).toMatch(/reranker full window \d+ ms \(deadline \d+ ms\)/);
    expect(calibrate).toHaveBeenCalledOnce();
    expect(calibrate.mock.calls[0]![0]).toBeLessThan(RERANK_DEADLINE_MS);
  });

  it('stands the reranker down when most timed windows miss the deadline', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { services, calibrate } = fake([[0.1], null, null, [0.2]]);
    await warmReranker(services, 1_000, 0);
    expect(calibrate).toHaveBeenCalledWith(Number.POSITIVE_INFINITY);
    expect(logged(log)).toMatch(/missed its \d+ ms deadline.*stands down/);
  });

  it('re-times a stood-down reranker after the interval and keeps it once it fits', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { services, calibrate, start } = fake(
      [[0.1], null, null, [0.2], [0.1], null, null, null, [0.1], [0.2], [0.2], [0.2]],
      { ready: [true, true, true] },
    );
    const done = warmReranker(services, 1_000, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(calibrate).toHaveBeenLastCalledWith(Number.POSITIVE_INFINITY);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(start).toHaveBeenCalledTimes(2);
    expect(calibrate).toHaveBeenLastCalledWith(Number.POSITIVE_INFINITY);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(start).toHaveBeenCalledTimes(3);
    expect(calibrate).toHaveBeenCalledTimes(3);
    expect(calibrate.mock.calls[2]![0]).toBeLessThan(RERANK_DEADLINE_MS);
    expect(logged(log).match(/missed its/g)).toHaveLength(1);
  });

  it('stops re-timing once the reranker can no longer start', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { services, start } = fake([[0.1], null, null, null], { ready: [true, false] });
    const done = warmReranker(services, 1_000, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('waits for the embedding backlog to drain before timing', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let backlog = true;
    const { services, score } = fake([[0.1], [0.2], [0.2], [0.2]], { backlog: () => backlog });
    const done = warmReranker(services, 1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(score).not.toHaveBeenCalled();
    expect(logged(log)).toMatch(/timing deferred until the embedding backlog drains/);
    backlog = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(score).toHaveBeenCalledTimes(4);
  });

  it('does nothing but log when reranking is switched off', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await warmReranker({ reranker: null, hasEmbeddingBacklog: () => false });
    expect(logged(log)).toMatch(/reranking disabled \(REMBRIC_RERANK=off\)/);
  });

  it('does not time anything when the model failed to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { services, score, calibrate } = fake([], { ready: [false] });
    await warmReranker(services);
    expect(score).not.toHaveBeenCalled();
    expect(calibrate).not.toHaveBeenCalled();
  });
});
