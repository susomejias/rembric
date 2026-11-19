import { RERANK_WINDOW } from '@rembric/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { warmReranker } from './process';

function fake(
  scores: (number[] | null)[],
  opts: { ready?: boolean; backlog?: () => boolean } = {},
) {
  const score = vi.fn((_q: string, docs: readonly string[]) => {
    expect(docs).toHaveLength(RERANK_WINDOW);
    return Promise.resolve(scores.length > 0 ? scores.shift()! : null);
  });
  return {
    services: {
      reranker: { start: () => Promise.resolve(opts.ready ?? true), score } as never,
      hasEmbeddingBacklog: opts.backlog ?? (() => false),
    },
    score,
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
    const { services, score } = fake([[0.1], [0.2], [0.2], [0.2]]);
    await warmReranker(services);
    expect(score).toHaveBeenCalledTimes(4);
    expect(logged(log)).toMatch(/reranker full window \d+ ms \(deadline \d+ ms\)/);
  });

  it('warns when most timed windows miss the deadline', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { services } = fake([[0.1], null, null, [0.2]]);
    await warmReranker(services);
    expect(logged(log)).toMatch(/missed its \d+ ms deadline.*unreranked order/);
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

  it('does not time anything when the model failed to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { services, score } = fake([], { ready: false });
    await warmReranker(services);
    expect(score).not.toHaveBeenCalled();
  });
});
