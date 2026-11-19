import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMBED_DRAIN_DELAY_MS, startEmbeddingDrain } from './process';

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

  it('does not run a batch while there is no backlog', async () => {
    const { processBatch, services } = fakeServices(0);
    startEmbeddingDrain(services);
    await vi.advanceTimersByTimeAsync(EMBED_DRAIN_DELAY_MS * 60);
    expect(processBatch).not.toHaveBeenCalled();
  });
});
