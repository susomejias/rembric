/**
 * `@rembric/core` barrel — the package's public entry point, and the only
 * import surface consumers use (`apps/server` compiles and runs against
 * `dist/`, and type-checks and tests against `src/` — see the package README).
 *
 * The named `export *` list below is deliberate: consumers used to reach into
 * `services/<module>.js`, `services/self-update/<module>.js`,
 * `consolidation/<module>.js` and `embeddings/<module>.js` directly, so every
 * symbol those modules export is part of the contract this move has to keep.
 * Keep it that way — an ambiguity here fails loudly as TS2308 rather than
 * silently dropping an export.
 */

export * from './consolidation/index.js';
// The consolidation module barrel curates its surface and omits these four, but
// dashboard and test consumers imported them from the module directly before
// the move — so the public contract still carries them.
export {
  NotUndoableError,
  PurgedRowMissingError,
  REACTIVATE_UNDO_OP_TYPES,
  TERMINAL_OP_TYPES,
} from './consolidation/operations.js';
export * from './embeddings/embedder.js';
export * from './embeddings/state.js';
// Shared request/tool-call context. App-agnostic infrastructure that both the
// application's HTTP layer and `@rembric/mcp` consume, so it lives here rather
// than inside either — one `AsyncLocalStorage` instance per process, or the
// store reads as empty with no type error (see the single-instance invariant).
export * from './server-context/request-context.js';
export * from './server-context/session-router.js';
export * from './server-context/tool-call-context.js';
export * from './services/index.js';
export * from './services/agent-sessions.js';
export * from './services/embedding-worker.js';
export * from './services/entities.js';
export * from './services/entity-backfill-worker.js';
export * from './services/entity-relevance.js';
export * from './services/entity-state.js';
export * from './services/errors.js';
export * from './services/extractor-rules.js';
export * from './services/hybrid-search.js';
export * from './services/memory.js';
export * from './services/oauth-areq.js';
export * from './services/oauth.js';
export * from './services/projects.js';
export * from './services/prompts.js';
export * from './services/relations.js';
export * from './services/review.js';
export * from './services/save-time-candidates.js';
export * from './services/self-update/capability.js';
export * from './services/self-update/engine-api.js';
export * from './services/self-update/orchestrator.js';
export * from './services/session-nudge.js';
export * from './services/sessions.js';
export * from './services/strings.js';
export * from './services/summary-sections.js';
export * from './services/tokens.js';
export * from './services/update-check.js';
export * from './services/usage-counters.js';
export * from './summary-rubric.js';
