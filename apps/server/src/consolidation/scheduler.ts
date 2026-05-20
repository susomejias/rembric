import { Cron } from 'croner';

import type { ConsolidationRunner } from './runner.js';

/**
 * Wraps the runner in a cron schedule. Honors the CONSOLIDATION_ENABLED and
 * CONSOLIDATION_CRON env vars (parsed upstream into config).
 *
 * The scheduler is idempotent: invoking `start()` twice is a no-op.
 * `stop()` cancels the next firing.
 */

export interface SchedulerOptions {
  cron: string;
  runner: ConsolidationRunner;
  enabled: boolean;
  onError?: (err: unknown) => void;
}

export class ConsolidationScheduler {
  private job: Cron | null = null;

  constructor(private readonly opts: SchedulerOptions) {}

  start(): void {
    if (!this.opts.enabled || this.job) return;
    this.job = new Cron(this.opts.cron, async () => {
      try {
        await this.opts.runner.runAll();
      } catch (err) {
        if (this.opts.onError) this.opts.onError(err);
        else console.error('consolidation run failed:', err);
      }
    });
  }

  stop(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
  }

  /** Trigger an out-of-cycle run; used by `POST /admin/consolidation/run`. */
  async triggerNow(): Promise<void> {
    await this.opts.runner.runAll();
  }
}
