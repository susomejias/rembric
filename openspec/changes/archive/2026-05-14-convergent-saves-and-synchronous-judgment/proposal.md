## Why

Today there is an asymmetry in the lifecycle of a memory: the agent saves it now, but any relationship to other memories (redundancy, supersedence, contradiction) is discovered hours later by the nightly `ConsolidationRunner`. Three things break because of this gap:

1. **Stale context decisions.** When the consolidator's LLM judge fires at 03:00, the agent that produced the conflicting memories is gone. The judge has only the rows; the _why_ is lost. Engram surfaces conflicts at save-time so the judging agent is the _same_ agent that has the fresh context.
2. **Convergent topics fragment.** An agent that updates the same topic five times in five sessions produces five active memories with similar content, all competing in `memory.search` results. The consolidator eventually merges them, but until then the agent gets noise. Engram solves this with `topic_key`: an agent that asserts "this is the same topic as before" upserts atomically without waiting for a nightly run.
3. **The consolidator is doing two jobs.** The current pipeline (1) detects candidate pairs across the entire DB, (2) judges them with an LLM, (3) applies operations. Step (1) is expensive (vec kNN at scale), step (2) is the contextless LLM call we just complained about, step (3) is correct but unnecessary if the agent already judged. Moving (1) and (2) to save-time leaves the consolidator with one job: deterministic decay plus a fallback that picks up judgments the agent never made.

This change makes `memory.save` the place where conflict surfacing happens; the agent participates in keeping the store clean instead of relying on a nightly job to fix things behind its back.

## What Changes

Three intertwined shifts. They land together because they share a table (`memory_relations`) and a contract (the new `memory.save` response shape).

- **`topic_key` upsert on `memory.save`.** A new optional argument. When supplied, the save inserts a new memory row AND atomically transitions the previously-active row with the same `(scope, project_id, topic_key)` from `active` to `superseded`. No LLM, no consolidator round-trip. The mechanism uses the existing `replaces[]` append-only invariant.
- **Save-time conflict surfacing.** Every `memory.save` runs a candidate-detection step (FTS5 lexical + vec kNN when embeddings are enabled, FTS5-only otherwise) and, if matches are found above a configurable threshold, inserts `memory_relations` rows with `status = 'pending'` and returns them as `candidates[]` with `judgmentRequired: true` and a `judgmentId` per pair. The save itself always succeeds — candidates are metadata on top of the response.
- **`memory.judge` and `memory.compare` tools.** The agent calls `memory.judge({judgmentId, relation, reason?, confidence?})` to close a pending judgment surfaced by save. The agent calls `memory.compare({memoryIdA, memoryIdB, relation, reason?, confidence})` to record a verdict on two arbitrary memories proactively (not from a save). Both write to `memory_relations`.
- **Relation annotations on `memory.search`.** Each result row gains optional `relations` annotation lines: `supersedes: #<id>`, `superseded_by: #<id>`, `conflicts_with: #<id>`, plus `pending_conflict_with: #<id>` for unjudged pairs. The agent sees provenance at-a-glance.
- **Consolidator simplification.** The runner stops doing LLM-driven detection of redundancy / drift / contradiction. It keeps decay (deterministic, no LLM). It gains a new step: promote `pending` judgments older than `JUDGMENT_ORPHAN_AFTER_HOURS` (default 24h) by running the existing LLM judge on them, then writing the verdict. Pairs that the LLM also can't resolve are marked `orphaned`.

## Out of scope

- Changes to `memory.get`, `memory.confirm`, `memory.search` request shapes. Only `memory.search` _response_ is extended with annotations; the request is identical.
- Cross-scope judgments. The same scope-isolation rule applies to `memory_relations`: a single row's source and target SHALL share `(scope, project_id)`.
- Backfill of `topic_key` on pre-existing rows. Existing memories keep `topic_key = NULL` and are not retroactively grouped.
- Cross-actor reconciliation when two agents judge the same pair differently. Both rows persist; `memory.search` shows the most recent. Reconciliation is deferred to a future change (matching Engram's "Phase 2" note).
- Cloud sync of relations. Same scope as v0.1: local-first, no replication.

## Capabilities

### Modified Capabilities

- `memory`: adds `topic_key` column with upsert semantics on save; `memory.save` response includes `candidates[]` and `judgmentRequired`; search results carry relation annotations.
- `persistence`: adds `memory_relations` table for the judgment graph; adds `topic_key` column to `memory` with a partial index on `(scope, project_id, topic_key)` where `status = 'active'`.
- `consolidation`: removes LLM-driven detection of redundancy / drift / contradiction; keeps decay; adds an orphan-promotion step that LLM-judges pending relations older than the threshold.
- `mcp-api`: adds `topic_key?` to `memory.save` schema; adds `memory.suggest_topic_key`, `memory.judge`, `memory.compare` tools.

### New Capabilities

None — this change refactors existing capabilities, it does not add a new top-level domain.
