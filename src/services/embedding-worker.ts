import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { embed, type LlmClient, LlmError } from '../llm/index.js';

/**
 * Background worker that backfills `memory_vec` with embeddings for any
 * memory rows missing one. Designed to be re-entrant and idempotent: calls
 * are safe to repeat, and the worker can be invoked on a timer or right
 * after `memory.save`.
 *
 * When `EMBEDDING_ENABLED=false`, the runtime skips this worker entirely
 * and consolidation candidate detection falls back to FTS5-only similarity.
 */

export interface EmbeddingWorkerOptions {
  db: Db;
  client: LlmClient;
  model: string;
  /** How many memories to embed per call. Defaults to 25. */
  batchSize?: number;
}

interface PendingRow {
  id: string;
  content: string;
}

export class EmbeddingWorker {
  private readonly batchSize: number;

  constructor(private readonly opts: EmbeddingWorkerOptions) {
    this.batchSize = opts.batchSize ?? 25;
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

    let processed = 0;
    let failed = 0;

    for (const row of pending) {
      try {
        const vector = await embed(this.opts.client, this.opts.model, row.content);
        this.opts.db.run(sql`
            INSERT INTO memory_vec (memory_id, embedding)
            VALUES (${row.id}, ${Buffer.from(vector.buffer)})
          `);
        processed++;
      } catch (err) {
        failed++;
        if (err instanceof LlmError && (err.code === 'auth' || err.code === 'rate_limited')) {
          // Surface immediately; transient errors will retry next call.
          throw err;
        }
        // Other failures: skip this row for now, the worker will retry it
        // on the next call.
      }
    }

    return { processed, failed };
  }
}
