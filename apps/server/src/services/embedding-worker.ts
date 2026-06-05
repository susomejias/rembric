import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import type { Embedder } from '../embeddings/embedder.js';

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
  db: Db;
  embedder: Embedder;
  /** How many memories to embed per call. Defaults to 25. */
  batchSize?: number;
  /** Fired once each time the queue drains after having had work. */
  onDrained?: () => void;
}

interface PendingRow {
  id: string;
  content: string;
}

export class EmbeddingWorker {
  private readonly batchSize: number;
  private hadWork = false;

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
  async embedNow(memoryId: string, content: string): Promise<boolean> {
    try {
      const vector = await this.opts.embedder.embed(content);
      this.opts.db.run(sql`
          INSERT INTO memory_vec (memory_id, embedding)
          VALUES (${memoryId}, ${Buffer.from(vector.buffer)})
        `);
      return true;
    } catch (err) {
      // Benign race with the drain (row already embedded) or an inference
      // failure — never break the save; the drain retries the row.
      console.error(
        'embedNow failed (drain will retry):',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  /**
   * Process up to `batchSize` memories without an embedding. Returns the
   * number of embeddings successfully inserted.
   */
  async processBatch(): Promise<{ processed: number; failed: number }> {
    const pending = this.opts.db.all<PendingRow>(sql`
      SELECT m.id AS id, m.content AS content
      FROM memory m
      LEFT JOIN memory_vec v ON v.memory_id = m.id
      WHERE v.memory_id IS NULL
        AND m.status != 'archived'
      ORDER BY m.created_at ASC
      LIMIT ${this.batchSize}
    `);
    if (pending.length === 0) {
      if (this.hadWork) {
        this.hadWork = false;
        this.opts.onDrained?.();
      }
      return { processed: 0, failed: 0 };
    }
    this.hadWork = true;

    let processed = 0;
    let failed = 0;

    for (const row of pending) {
      try {
        const vector = await this.opts.embedder.embed(row.content);
        this.opts.db.run(sql`
            INSERT INTO memory_vec (memory_id, embedding)
            VALUES (${row.id}, ${Buffer.from(vector.buffer)})
          `);
        processed++;
      } catch {
        // Skip this row for now; the worker retries it on the next call.
        failed++;
      }
    }

    return { processed, failed };
  }
}
