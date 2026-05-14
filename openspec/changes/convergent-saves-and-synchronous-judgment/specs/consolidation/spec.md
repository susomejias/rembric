## MODIFIED Requirements

### Requirement: The consolidation MUST target redundancy, drift, contradiction, and decay

The consolidation SHALL perform exactly two passes per run in v0.5: (1) decay (deterministic, no LLM), and (2) orphan promotion of pending relations older than `JUDGMENT_ORPHAN_AFTER_MS`. The LLM-driven detection of redundancy / drift / contradiction over the full corpus is REMOVED — that work moves to save-time as `memory.save` candidate detection.

#### Scenario: A memory has not been seen for a long time

- **GIVEN** a memory whose `last_seen_at` is older than the decay threshold and whose `confidence` count is below the floor
- **WHEN** the consolidation runs
- **THEN** the memory SHALL transition from `active` to `archived` without an LLM call (decay path is unchanged)

#### Scenario: A pending relation is older than the orphan threshold

- **GIVEN** a `memory_relations` row with `status = 'pending'` and `created_at < (now - JUDGMENT_ORPHAN_AFTER_MS)` (default 24h)
- **WHEN** the consolidation runs
- **THEN** the existing LLM judge SHALL be invoked on the (source, target) pair; the verdict SHALL translate to a relation value and the row SHALL transition to `status = 'judged'` with `marked_by_kind = 'consolidator'`

#### Scenario: The LLM judge cannot decide an orphan

- **WHEN** the LLM judge errors, returns malformed output, or returns a verdict with confidence below the configured floor
- **THEN** the relation row SHALL transition to `status = 'orphaned'`; the orphaned status is final unless a future `memory.judge` or `memory.compare` call writes a fresh row

#### Scenario: Two near-duplicate memories save apart from each other

- **GIVEN** EMBEDDING_ENABLED is true and the second save's candidate detection found the first as a candidate
- **WHEN** that save returned `candidates: [{...}]` and the agent never called `memory.judge`
- **THEN** after `JUDGMENT_ORPHAN_AFTER_MS` the consolidator's orphan-promotion pass SHALL invoke the LLM judge on the pair (this is the only path that runs LLM detection in the new pipeline)

### Requirement: The consolidation MUST be idempotent on stable input

Running the consolidation twice with no intervening writes SHALL produce zero new operations beyond noops. Specifically: the decay pass SHALL be a no-op if no row crossed the threshold since the previous run; the orphan-promotion pass SHALL be a no-op if no pending relation crossed `JUDGMENT_ORPHAN_AFTER_MS` since the previous run.

#### Scenario: Back-to-back consolidation runs with no intervening saves

- **WHEN** the consolidation runs twice in immediate succession
- **THEN** the second run's `consolidation_runs.summary` SHALL show zero new decay archives and zero new orphan promotions

## REMOVED Requirements

### Requirement: The consolidation MUST detect candidate redundancy / drift / contradiction over the full corpus

**Reason for removal**: this work is moved to save-time. The agent that produces a memory is the same agent that sees its candidates and judges them with fresh context. The nightly sweep over the entire corpus is no longer the primary detection path; the `memory.save` response is. The orphan-promotion pass in the modified consolidation requirement above handles the long-tail case (agent ignored the candidates), so the safety net is preserved without paying the full-corpus scan cost every night.

**Migration**: the candidate-detection functions (`findRedundancyCandidates`, `findDriftCandidates`, `findContradictionCandidates`) are deleted from the consolidation module. Their unit tests are removed. The new save-time detection (specified in `memory` capability) is the canonical path; orphan promotion picks up unjudged remainders.

### Requirement: Consolidation operations MUST be atomic per operation

**This requirement is retained** in spirit but consolidated into the existing journaling and atomicity requirements that remain valid. The orphan-promotion path uses the same per-op transaction discipline as the prior code.

(The duplicated text is left under the unchanged requirements to satisfy the spec-driven workflow; this note records that no behavioral removal occurred — only the surrounding context shrank.)
