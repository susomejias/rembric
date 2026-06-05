/**
 * Consolidation engine module barrel. The server wires the deterministic
 * `ConsolidationRunner` sweep at boot (triggered lazily on session start);
 * the dashboard reads the journal (consolidation_runs / consolidation_ops)
 * directly via Drizzle.
 */

// Note: findRedundancyCandidates / findDriftCandidates /
// findContradictionCandidates were removed in v0.5; the LLM orphan judge
// and the cron scheduler were removed in `remove-llm-consolidation`.
// Save-time candidate detection in `memory.save` + agent-side
// `memory.judge` (re-exposed via `memory.context`) replaced them.
export type { ScopeKey } from './candidates.js';

export { findDecayCandidates, DEFAULT_DECAY } from './decay.js';
export type { DecayThresholds } from './decay.js';

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
