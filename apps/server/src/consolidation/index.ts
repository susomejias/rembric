/**
 * Consolidation engine module barrel. The server wires `ConsolidationRunner` and
 * `ConsolidationScheduler` together at boot; the dashboard reads the journal
 * (consolidation_runs / consolidation_ops) directly via Drizzle.
 */

// Note: findRedundancyCandidates / findDriftCandidates /
// findContradictionCandidates were removed in v0.5. Save-time candidate
// detection in `memory.save` + `RelationsService` superseded them; the
// orphan-promotion pass in `ConsolidationRunner` handles the long tail.
export type { ScopeKey } from './candidates.js';

export { findDecayCandidates, DEFAULT_DECAY } from './decay.js';
export type { DecayThresholds } from './decay.js';

export { judge, judgeDecisionSchema } from './judge.js';
export type { JudgeDecision, RunJudgeOptions } from './judge.js';

export {
  applyMerge,
  applySupersede,
  applyDecay,
  recordNoop,
  recordFailed,
  undoOp,
  undoRun,
} from './operations.js';
export type {
  MergeOpInput,
  SupersedeOpInput,
  DecayOpInput,
  ConsolidationOpType,
} from './operations.js';

export { ConsolidationRunner } from './runner.js';
export type {
  ConsolidationRunnerOptions,
  ConsolidationRunSummary,
  ScopeRunResult,
} from './runner.js';

export { ConsolidationScheduler } from './scheduler.js';
export type { SchedulerOptions } from './scheduler.js';
