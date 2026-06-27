# consolidation Specification

## MODIFIED Requirements

### Requirement: The consolidation MUST target redundancy, drift, contradiction, and decay

The consolidation sweep SHALL perform exactly two passes per run: (1) decay (deterministic, no LLM), and (2) deadline orphaning of pending relations older than `JUDGMENT_ORPHAN_DEADLINE_MS`. The LLM-driven detection of redundancy / drift / contradiction over the full corpus is REMOVED — that work moves to save-time as `memory.save` candidate detection. The LLM judging of aged pending relations is REMOVED — aged pendings are re-exposed to agents via `memory.context` and deterministically orphaned at the deadline.

The decay pass SHALL select candidates using a static per-type `last_seen_at` threshold: a memory of type `T` is a decay candidate when it is `active`, its confirmation count is below the confidence floor, and its `last_seen_at` is older than the threshold configured for `T`. The thresholds SHALL be a static in-code map keyed by `MemoryType` with a single default fallback threshold applied to any type lacking an explicit entry; the map SHALL NOT be operator-configurable and SHALL NOT be derived from the review axis. The decay axis SHALL remain keyed on `last_seen_at` plus the confidence floor only; it SHALL NOT read `created_at`, confirmation baselines, or `REVIEW_TTL_MS`. The decay and review axes SHALL remain orthogonal: making the decay threshold vary by type SHALL NOT couple the two axes. No LLM and no cron SHALL be involved in selecting decay candidates.

#### Scenario: A memory has not been seen for longer than its type's decay threshold

- **GIVEN** a memory whose `last_seen_at` is older than the decay threshold configured for its `type` and whose `confidence` count is below the floor
- **WHEN** the sweep runs
- **THEN** the memory SHALL transition from `active` to `archived` without an LLM call

#### Scenario: Two memories of different types pass the same last_seen_at point

- **GIVEN** two `active` memories with identical `last_seen_at` and confidence below the floor, one of a type with a SHORT decay threshold and one of a type with a LONGER decay threshold, and `now` such that only the short threshold has elapsed
- **WHEN** the sweep runs
- **THEN** the short-threshold memory SHALL be archived and the longer-threshold memory SHALL remain `active`

#### Scenario: A type without an explicit threshold uses the default fallback

- **GIVEN** a memory of a type that has no explicit entry in the per-type decay map
- **WHEN** the sweep evaluates it for decay
- **THEN** the default fallback threshold SHALL be applied to that memory, so its decay behavior is identical to the prior single global threshold

#### Scenario: Changing a type's decay threshold does not affect its review state

- **GIVEN** the per-type decay threshold for a type is changed in the static map
- **WHEN** review state is derived for a memory of that type
- **THEN** the derived `reviewState` / `reviewAfter` SHALL be unchanged, because review is keyed on `created_at` plus confirmation baseline plus `REVIEW_TTL_MS` and is orthogonal to the decay threshold

#### Scenario: Two near-duplicate memories save apart from each other

- **GIVEN** the second save's candidate detection found the first as a candidate
- **WHEN** that save returned `candidates: [{...}]` and the agent never called `memory.judge`
- **THEN** after `JUDGMENT_ORPHAN_AFTER_MS` the pending relation SHALL appear in `memory.context.pendingJudgments[]`, and after `JUDGMENT_ORPHAN_DEADLINE_MS` without judgment the sweep SHALL orphan it — no LLM is invoked at any point
