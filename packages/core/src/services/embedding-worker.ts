import { partitionKeyFor, type Repositories } from '@rembric/db';

import { type Embedder, embeddingInput } from '../embeddings/embedder.js';

export interface EmbeddingWorkerOptions {
  repos: Pick<Repositories, 'vectors'>;
  embedder: Embedder;
  /** How many memories to embed per call. Defaults to 25. */
  batchSize?: number;
  /** Fired once each time the queue drains after having had work. */
  onDrained?: () => void;
}

export class EmbeddingWorker {
  private readonly batchSize: number;
  private hadWork = false;
  private possiblyPending = true;

  constructor(private readonly opts: EmbeddingWorkerOptions) {
    this.batchSize = opts.batchSize ?? 25;
  }

  async embedNow(
    memoryId: string,
    title: string,
    content: string,
    projectId: string,
  ): Promise<boolean> {
    try {
      const vector = await this.opts.embedder.embed(embeddingInput(title, content));
      this.opts.repos.vectors.insertEmbedding(
        memoryId,
        Buffer.from(vector.buffer),
        partitionKeyFor(projectId),
      );
      return true;
    } catch (err) {
      this.possiblyPending = true;
      console.error(
        'embedNow failed (drain will retry):',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  async processBatch(
    opts: { force?: boolean } = {},
  ): Promise<{ processed: number; failed: number }> {
    if (!opts.force && !this.possiblyPending) {
      return { processed: 0, failed: 0 };
    }

    const pending = this.opts.repos.vectors.findMissingEmbeddings(this.batchSize);
    if (pending.length === 0) {
      this.possiblyPending = false;
      if (this.hadWork) {
        this.hadWork = false;
        this.opts.onDrained?.();
      }
      return { processed: 0, failed: 0 };
    }
    this.hadWork = true;
    this.possiblyPending = true; // more may remain past this batch

    let processed = 0;
    let failed = 0;

    for (const row of pending) {
      try {
        const vector = await this.opts.embedder.embed(embeddingInput(row.title, row.content));
        this.opts.repos.vectors.insertEmbedding(
          row.id,
          Buffer.from(vector.buffer),
          partitionKeyFor(row.projectId),
        );
        processed++;
      } catch {
        // Skip this row for now; the worker retries it on the next call.
        failed++;
      }
    }

    return { processed, failed };
  }
}
