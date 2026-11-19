import { RERANK_WINDOW } from '@rembric/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { warmReranker } from './process';

function fake(scores: (number[] | null)[], ready = true) {
  const score = vi.fn((_q: string, docs: readonly string[]) => {
    expect(docs).toHaveLength(RERANK_WINDOW);
    return Promise.resolve(scores.shift() ?? null);
  });
  return { reranker: { start: () => Promise.resolve(ready), score } as never, score };
}

describe('warmReranker', () => {
  afterEach(() => vi.restoreAllMocks());

  it('times a full window after the model is ready', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { reranker, score } = fake([[0.1], [0.2]]);
    await warmReranker({ reranker });
    expect(score).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /reranker full window \d+ ms \(deadline \d+ ms\)/,
    );
  });

  it('warns when a full window misses the deadline on this CPU', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { reranker } = fake([[0.1], null]);
    await warmReranker({ reranker });
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /missed its \d+ ms deadline.*unreranked order/,
    );
  });

  it('does not time anything when the model failed to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { reranker, score } = fake([], false);
    await warmReranker({ reranker });
    expect(score).not.toHaveBeenCalled();
  });
});
