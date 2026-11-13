export type { ScopeKey } from './candidates.js';

export { findDecayCandidates, DEFAULT_DECAY } from './decay.js';
export type { DecayThresholds } from './decay.js';

export {
  applyDecay,
  orphanPendingOnProjectArchive,
  orphanPendingOnRetirement,
  PROJECT_ARCHIVE_ORPHAN_REASON,
  PROJECT_ARCHIVE_ORPHANING_PREFIX,
  PROJECT_ARCHIVE_RUN_KIND,
  restoreProjectArchiveOrphanings,
  RETIREMENT_ORPHAN_REASON,
  undoOp,
  undoRun,
} from './operations.js';
export type {
  KeptOrphaned,
  KeptVerdict,
  ProjectArchiveOrphanInput,
  ProjectArchiveRestoreResult,
  RetirementCause,
  RetirementInput,
  SkippedRow,
  UndoResult,
  UndoRunResult,
} from './operations.js';
export type { DecayOpInput, ConsolidationOpType } from './operations.js';

export { ARCHIVE_RECONCILE_BATCH, reconcileArchivedProjectJudgments } from './archived-projects.js';
export type { ArchivedProjectReconcileResult } from './archived-projects.js';

export {
  ConsolidationRunner,
  DEFAULT_MIN_INTERVAL_MS,
  DRAIN_BUDGET_MS,
  DRAIN_LOW_BAND_REASON,
  DRAIN_RETIRED_REASON,
  DRAIN_ROW_CAP,
  DRAIN_RULES_REASON,
  drainDisposition,
} from './runner.js';
export type {
  ConsolidationRunnerOptions,
  ConsolidationRunSummary,
  DrainCursor,
  DrainDisposition,
  DrainSummary,
  ScopeRunResult,
} from './runner.js';
