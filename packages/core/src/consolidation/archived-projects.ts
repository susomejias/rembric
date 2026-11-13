import type { Repositories, TransactionRunner } from '@rembric/db';

import { RelationsService } from '../services/relations.js';

import { orphanPendingOnProjectArchive, type ConsolidationDeps } from './operations.js';

export const ARCHIVE_RECONCILE_BATCH = 400;

export interface ArchivedProjectReconcileResult {
  closed: number;
  projects: number;
}

/** Idempotent: a converged store has no pending judgment in an archived project and writes nothing. */
export async function reconcileArchivedProjectJudgments(
  repos: ConsolidationDeps & Pick<Repositories, 'projects'>,
  tx: TransactionRunner,
  opts: { batchSize?: number } = {},
): Promise<ArchivedProjectReconcileResult> {
  const batchSize = opts.batchSize ?? ARCHIVE_RECONCILE_BATCH;
  const relations = new RelationsService(repos, tx);
  let closed = 0;
  let projects = 0;
  for (const projectId of repos.projects.listArchivedIds()) {
    let closedHere = 0;
    for (;;) {
      const batch = tx.transaction(() =>
        orphanPendingOnProjectArchive(repos, relations, {
          projectId,
          at: new Date(),
          origin: 'reconcile',
          limit: batchSize,
        }),
      );
      closedHere += batch;
      if (batch < batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (closedHere > 0) {
      closed += closedHere;
      projects += 1;
    }
  }
  return { closed, projects };
}
