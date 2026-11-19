import { parentPort, workerData } from 'node:worker_threads';

import { loadRerankScorer } from './reranker.js';

export type RerankWorkerRequest =
  | { kind: 'score'; id: number; query: string; documents: string[]; expiresAt: number }
  | { kind: 'shutdown' };
export type RerankWorkerReply =
  | { kind: 'ready' }
  | { kind: 'load-failed'; message: string }
  | { kind: 'scores'; id: number; scores: number[] }
  | { kind: 'expired'; id: number }
  | { kind: 'failed'; id: number; message: string };

const port = parentPort;
if (port) {
  const modelsDir = (workerData as { modelsDir: string | null }).modelsDir;
  const send = (reply: RerankWorkerReply) => port.postMessage(reply);
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
  loadRerankScorer(modelsDir).then(
    (score) => {
      let chain = Promise.resolve();
      port.on('message', (req: RerankWorkerRequest) => {
        chain = chain.then(async () => {
          if (req.kind === 'shutdown') {
            port.close();
            return;
          }
          if (Date.now() >= req.expiresAt) {
            send({ kind: 'expired', id: req.id });
            return;
          }
          try {
            send({ kind: 'scores', id: req.id, scores: await score(req.query, req.documents) });
          } catch (err) {
            send({ kind: 'failed', id: req.id, message: message(err) });
          }
        });
      });
      send({ kind: 'ready' });
    },
    (err: unknown) => {
      send({ kind: 'load-failed', message: message(err) });
      port.close();
    },
  );
}
