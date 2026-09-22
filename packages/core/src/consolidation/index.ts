export type { ScopeKey } from './candidates.js';

export { findDecayCandidates, DEFAULT_DECAY } from './decay.js';
export type { DecayThresholds } from './decay.js';

export { applyDecay, undoOp, undoRun } from './operations.js';
export type { SkippedRow, UndoResult } from './operations.js';
export type { DecayOpInput, ConsolidationOpType } from './operations.js';

export { ConsolidationRunner, DEFAULT_MIN_INTERVAL_MS } from './runner.js';
export type {
  ConsolidationRunnerOptions,
  ConsolidationRunSummary,
  ScopeRunResult,
} from './runner.js';
