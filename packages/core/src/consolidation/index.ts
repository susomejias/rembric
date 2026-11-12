export type { ScopeKey } from './candidates.js';

export { findDecayCandidates, DEFAULT_DECAY } from './decay.js';
export type { DecayThresholds } from './decay.js';

export {
  applyDecay,
  orphanPendingOnRetirement,
  RETIREMENT_ORPHAN_REASON,
  undoOp,
  undoRun,
} from './operations.js';
export type {
  KeptOrphaned,
  KeptVerdict,
  RetirementCause,
  RetirementInput,
  SkippedRow,
  UndoResult,
  UndoRunResult,
} from './operations.js';
export type { DecayOpInput, ConsolidationOpType } from './operations.js';

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
