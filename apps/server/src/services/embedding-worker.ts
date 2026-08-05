import type { Repositories } from '../db/repositories/index.js';
import { partitionKeyFor } from '../db/repositories/scope-clause.js';
import { type Embedder, embeddingInput } from '../embeddings/embedder.js';

/**
 * Background worker that backfills `memory_vec` with embeddings for any
 * memory rows missing one. Designed to be re-entrant and idempotent: calls
 * are safe to repeat, and the worker can be invoked on a timer or right
 * after `memory.save`.
 *
 * The embedder is in-process and warm by construction (the model loads
 * at boot, before the server listens) — every call here is ms-scale
 * inference, never a model load.
 */

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
  // memory.save and memory.capture_passive both call embedNow inline via
  // the shared save-time curation path (saveMemoryWithCandidates) — but
  // ONLY when candidates.perSaveMax > 0 (the gate at
  // mcp/memory-tools.ts:saveMemoryWithCandidates); with perSaveMax=0 (a
  // documented setting for batch/automation paths) no save calls embedNow
  // at all, and newly-inserted rows sit unembedded until this worker's
  // periodic scan picks them up. So the backlog is NOT guaranteed empty in
  // steady state. True by default (covers first-boot backfill, crash
  // recovery, and the perSaveMax=0 case); flipped false once a scan
  // confirms zero pending, and back to true by embedNow's own failure path.
  // Lets processBatch skip the full-table scan once drained, instead of
  // re-running it every tick.
  private possiblyPending = true;

  constructor(private readonly opts: EmbeddingWorkerOptions) {
    this.batchSize = opts.batchSize ?? 25;
  }

  /**
   * Embed one memory inline — used by `memory.save` so the row has a
   * vector BEFORE candidate detection runs (otherwise vec candidates can
   * never fire: a brand-new row has no embedding yet). Returns whether a
   * vector is in place; on failure the save proceeds with FTS-only
   * detection and the drain retries the row.
   */
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
      // Benign race with the drain (row already embedded) or an inference
      // failure — never break the save; the drain retries the row.
      this.possiblyPending = true;
      console.error(
        'embedNow failed (drain will retry):',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  /**
   * Process up to `batchSize` memories without an embedding. Returns the
   * number of embeddings successfully inserted. Skips the backlog scan
   * entirely when a prior call already confirmed the queue is empty,
   * unless `force` is set (used by a slow periodic safety-net timer).
   */
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
