import type { TransactionRunner } from '../db/client.js';
import type { Repositories } from '../db/repositories/index.js';

import { extractEntities } from './entities.js';
import { resetEntityIndex } from './entity-state.js';

export interface EntityBackfillWorkerOptions {
  repos: Pick<Repositories, 'entities'>;
  tx: TransactionRunner;
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

  /**
   * Atomically empty the derived index so the drain re-scans the whole corpus.
   * Resets `possiblyPending` too, so a caller that forgets `force` on the next
   * batch still drains rather than trusting a flag from before the wipe.
   */
  resetIndex(): void {
    resetEntityIndex(this.opts.repos, this.opts.tx);
    this.possiblyPending = true;
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
        // Without this the row never leaves the queue and the drain hot-loops forever.
        try {
          this.opts.repos.entities.markScanned(row.id, this.now());
        } catch {
          /* the row will be retried next drain — better than a hot loop */
        }
      }
    }
    return { processed, failed };
  }
}
