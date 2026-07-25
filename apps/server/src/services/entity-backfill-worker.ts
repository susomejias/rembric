import type { Repositories } from '../db/repositories/index.js';

import { extractEntities } from './entities.js';

export interface EntityBackfillWorkerOptions {
  repos: Pick<Repositories, 'entities'>;
  batchSize?: number;
  now?: () => Date;
}

/**
 * Resumable batched backfill over existing memories, in the shape of
 * `EmbeddingWorker`: "done" is derived from `findMissingScans` (a LEFT JOIN
 * against `memory_entity_scan`) rather than a separate cursor, so a process
 * restart mid-backfill just resumes from whatever is still missing.
 * Extraction is pure/synchronous (no model, no network), so unlike the
 * embedding worker this never needs to be awaited mid-batch.
 */
export class EntityBackfillWorker {
  private readonly batchSize: number;
  private readonly now: () => Date;
  private possiblyPending = true;

  constructor(private readonly opts: EntityBackfillWorkerOptions) {
    // ~1.7ms/memory, so a batch costs ~170ms — no model inference to pace for.
    this.batchSize = opts.batchSize ?? 100;
    this.now = opts.now ?? (() => new Date());
  }

  /** True while `findMissingScans` last returned work — drives drain cadence. */
  get hasPendingWork(): boolean {
    return this.possiblyPending;
  }

  processBatch(opts: { force?: boolean } = {}): { processed: number; failed: number } {
    if (!opts.force && !this.possiblyPending) return { processed: 0, failed: 0 };
    const pending = this.opts.repos.entities.findMissingScans(this.batchSize);
    if (pending.length === 0) {
      this.possiblyPending = false;
      return { processed: 0, failed: 0 };
    }
    this.possiblyPending = true;

    let processed = 0;
    let failed = 0;
    for (const row of pending) {
      try {
        const entities = extractEntities(row.title, row.content);
        this.opts.repos.entities.linkMemory(row.id, row.scope, row.projectId, entities, this.now());
        processed++;
      } catch {
        failed++;
      }
    }
    return { processed, failed };
  }
}
