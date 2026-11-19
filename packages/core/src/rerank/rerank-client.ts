import { Worker } from 'node:worker_threads';

import type { RerankWorkerReply, RerankWorkerRequest } from './rerank-worker.js';
import { RERANK_DEADLINE_MS } from './reranker.js';

export interface RerankWorkerHandle {
  postMessage(request: RerankWorkerRequest): void;
  on(event: 'message', listener: (reply: RerankWorkerReply) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

export const RERANK_FALLBACK_CAUSES = [
  'not-ready',
  'load-failed',
  'deadline',
  'inference-failed',
  'worker-exited',
] as const;
export type RerankFallbackCause = (typeof RERANK_FALLBACK_CAUSES)[number];

export interface RerankStats {
  reranked: number;
  fallbacks: Record<RerankFallbackCause, number>;
}

export interface RerankClientOptions {
  spawn: () => RerankWorkerHandle;
  deadlineMs?: number;
  maxRestarts?: number;
  log?: (line: string) => void;
  now?: () => number;
}

type State = 'idle' | 'loading' | 'ready' | 'failed';
type Pending = { resolve: (scores: number[] | null) => void; timer: NodeJS.Timeout };

const LOG_INTERVAL_MS = 60_000;

export function spawnRerankWorker(modelsDir: string | null): RerankWorkerHandle {
  return new Worker(new URL('./rerank-worker.js', import.meta.url), { workerData: { modelsDir } });
}

/** `score` resolves `null` instead of throwing; the caller then serves the unreranked order. */
export class RerankClient {
  private state: State = 'idle';
  private worker: RerankWorkerHandle | null = null;
  private restarts = 0;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly counts: RerankStats = {
    reranked: 0,
    fallbacks: Object.fromEntries(RERANK_FALLBACK_CAUSES.map((c) => [c, 0])) as Record<
      RerankFallbackCause,
      number
    >,
  };
  private readonly lastLogged = new Map<RerankFallbackCause, number>();
  private readyWaiters: ((ready: boolean) => void)[] = [];
  private readonly deadlineMs: number;
  private readonly maxRestarts: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly opts: RerankClientOptions) {
    this.deadlineMs = opts.deadlineMs ?? RERANK_DEADLINE_MS;
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.log = opts.log ?? ((line) => console.error(line));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Resolves `true` once the model is loaded, `false` when it cannot be. */
  start(): Promise<boolean> {
    if (this.state === 'ready') return Promise.resolve(true);
    if (this.state === 'failed') return Promise.resolve(false);
    const settled = new Promise<boolean>((resolve) => this.readyWaiters.push(resolve));
    if (this.state === 'idle') this.spawn();
    return settled;
  }

  score(query: string, documents: readonly string[]): Promise<number[] | null> {
    if (documents.length === 0) return Promise.resolve([]);
    if (this.state !== 'ready' || !this.worker) {
      return Promise.resolve(this.fallback(this.state === 'failed' ? 'load-failed' : 'not-ready'));
    }
    const id = ++this.nextId;
    const worker = this.worker;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve(this.fallback('deadline'));
      }, this.deadlineMs);
      this.pending.set(id, { resolve, timer });
      worker.postMessage({
        kind: 'score',
        id,
        query,
        documents: [...documents],
        expiresAt: this.now() + this.deadlineMs,
      });
    });
  }

  stats(): RerankStats {
    return { reranked: this.counts.reranked, fallbacks: { ...this.counts.fallbacks } };
  }

  /** Lets the worker finish the inference it is running and exit: terminating mid-inference aborts the process. */
  close(): void {
    const worker = this.worker;
    this.state = 'failed';
    this.worker = null;
    this.settlePending('worker-exited');
    this.settleReady(false);
    worker?.postMessage({ kind: 'shutdown' });
  }

  private spawn(): void {
    this.state = 'loading';
    const worker = this.opts.spawn();
    this.worker = worker;
    worker.on('message', (reply) => {
      if (this.worker !== worker) return;
      this.onReply(reply);
    });
    worker.on('error', (err) => {
      if (this.worker !== worker) return;
      this.log(`[rerank] worker error: ${err.message}`);
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.settlePending('worker-exited');
      if (this.state === 'failed') return;
      if (this.restarts >= this.maxRestarts) {
        this.state = 'failed';
        this.log(
          `[rerank] worker exited (code ${code}); restart limit reached, reranking stays off`,
        );
        this.settleReady(false);
        return;
      }
      this.restarts++;
      this.log(
        `[rerank] worker exited (code ${code}); restarting (${this.restarts}/${this.maxRestarts})`,
      );
      this.spawn();
    });
  }

  private onReply(reply: RerankWorkerReply): void {
    switch (reply.kind) {
      case 'ready':
        this.state = 'ready';
        this.settleReady(true);
        return;
      case 'load-failed':
        this.state = 'failed';
        this.log(`[rerank] model failed to load; reranking stays off: ${reply.message}`);
        this.settleReady(false);
        this.worker = null;
        return;
      case 'scores': {
        const p = this.take(reply.id);
        if (!p) return;
        this.counts.reranked++;
        p.resolve(reply.scores);
        return;
      }
      case 'expired': {
        const p = this.take(reply.id);
        if (!p) return;
        p.resolve(this.fallback('deadline'));
        return;
      }
      case 'failed': {
        const p = this.take(reply.id);
        if (!p) return;
        p.resolve(this.fallback('inference-failed', reply.message));
        return;
      }
    }
  }

  private take(id: number): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    clearTimeout(p.timer);
    return p;
  }

  private settlePending(cause: RerankFallbackCause): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(this.fallback(cause));
    }
  }

  private settleReady(ready: boolean): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w(ready);
  }

  private fallback(cause: RerankFallbackCause, detail?: string): null {
    this.counts.fallbacks[cause]++;
    const at = this.now();
    const last = this.lastLogged.get(cause);
    if (last === undefined || at - last >= LOG_INTERVAL_MS) {
      this.lastLogged.set(cause, at);
      this.log(`[rerank] served the unreranked order (${cause})${detail ? `: ${detail}` : ''}`);
    }
    return null;
  }
}
