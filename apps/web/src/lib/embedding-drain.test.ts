import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMBED_DRAIN_DELAY_MS, EMBED_TICK_MS, startEmbeddingDrain } from './process';

describe('embedding drain pacing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fakeServices(backlogBatches: number) {
    let remaining = backlogBatches;
    const processBatch = vi.fn(() => {
      if (remaining > 0) remaining--;
      return Promise.resolve({ processed: 1, failed: 0 });
    });
    return {
      processBatch,
      services: {
        hasEmbeddingBacklog: () => remaining > 0,
        embeddingWorker: () => Promise.resolve({ processBatch } as never),
      },
    };
  }

  it('drains a backlog one batch per EMBED_DRAIN_DELAY_MS, then idles', async () => {
    const { processBatch, services } = fakeServices(5);
    startEmbeddingDrain(services);
    await vi.advanceTimersByTimeAsync(0);
    expect(processBatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(EMBED_DRAIN_DELAY_MS * 4);
    expect(processBatch).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(EMBED_DRAIN_DELAY_MS * 20);
    expect(processBatch).toHaveBeenCalledTimes(5);
  });

  it('rests at least as long as the last batch took, so the drain holds the CPU at most half the time', async () => {
    let clock = 0;
    let remaining = 3;
    const starts: number[] = [];
    const processBatch = vi.fn(() => {
      starts.push(clock);
      clock += 5_000;
      remaining--;
      return Promise.resolve({ processed: 1, failed: 0 });
    });
    startEmbeddingDrain(
      {
        hasEmbeddingBacklog: () => remaining > 0,
        embeddingWorker: () => Promise.resolve({ processBatch } as never),
      },
      () => clock,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(processBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(processBatch).toHaveBeenCalledTimes(2);
  });

  it('keeps its schedule when the backlog check throws, e.g. after the database closed', async () => {
    const processBatch = vi.fn(() => Promise.resolve({ processed: 0, failed: 0 }));
    let closed = false;
    let checks = 0;
    startEmbeddingDrain({
      hasEmbeddingBacklog: () => {
        checks++;
        if (closed) throw new Error('The database connection is not open');
        return true;
      },
      embeddingWorker: () => {
        closed = true;
        return Promise.resolve({ processBatch } as never);
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(processBatch).toHaveBeenCalledTimes(1);
    const before = checks;
    await vi.advanceTimersByTimeAsync(EMBED_TICK_MS);
    expect(checks).toBeGreaterThan(before);
  });

  it('does not run a batch while there is no backlog', async () => {
    const { processBatch, services } = fakeServices(0);
    startEmbeddingDrain(services);
    await vi.advanceTimersByTimeAsync(EMBED_DRAIN_DELAY_MS * 60);
    expect(processBatch).not.toHaveBeenCalled();
  });
});
