## Context

Ten defects from a multi-agent audit, grouped into one change because they share a property: none of them alters retrieval ranking, so each can be validated by a targeted test without a measurement harness. Four were reproduced empirically (the telemetry freeze twice, independently). The three ranking-affecting defects the audit also confirmed are deferred to changes that build measurement first — recorded in `proposal.md` under Deferred.

Two audit claims were **downgraded by adversarial verification** and are deliberately absent from this change, so their absence is not read as an oversight:

- The MCP transport session map is not keyed by token, but the claimed harm (poisoning a victim's project scope) is impossible — the derived slug lands in the *attacker's* token-namespaced router entry, because every router read and write derives its key from the authenticated caller's token id. Exploitation additionally requires both a second valid token and a 122-bit session UUID that is never persisted or logged. Worth doing as defence in depth; not a defect this change must carry.
- The `needsReview` query plan is genuinely a per-row correlated subquery with a temp B-tree, and it costs **1.3 ms** at 20k active memories on the agent-facing path. Measured, not worth the change budget.

## Goals

- Remove the only known stop-the-world stall in the server.
- Make the two invariants that agents are asked to uphold — convergent topics, and reversible consolidation — actually upholdable and actually honest.
- Make failure legible: no success response for work that did not happen, and no opaque `internal_error` for a rejectable input.

## Non-Goals

- Any change to ranking, fusion constants, decay windows, or what `last_seen_at` means.
- Relaxing append-only. `last_activity_at` is a new mutable *session* column, in the same class as `summary` and `deleted_at`; memory `content`/`title` remain frozen and nothing is deleted.
- Introducing an operator CLI or a non-Docker distribution path.

## Decisions

**Decision 1 — Delete the similarity telemetry rather than optimise it.**
The measured alternative (200 anchors through the existing partition-pruned kNN) is ~2.3 s instead of ~57 s. That is 25× better and still unacceptable inside a drain callback on the single thread. The statistic exists to calibrate a constant that is already shipped and compile-time fixed; it has no operational consumer, appears on no dashboard, and is written with bare `console.error` so it cannot even be suppressed by log level. Deleting the call removes the whole class. If calibration is wanted again later it belongs in the eval harness that the deferred changes introduce, run offline against a fixture corpus — not in the serving process.

**Decision 2 — Fix the trigger, not just the symptom.**
The freeze is reached because `capture_passive` inserts rows without embedding them, so they sit invisible to the 30-second drain until the hourly force tick sweeps them up and the following tick reports a drain. Routing `capture_passive` through the shared save-time helper closes the freeze trigger *and* the "captured memories are invisible to vector search for up to an hour" defect with one change. The comment asserting that `memory.save` always embeds is false in two ways — the call is inside a conditional, and it is skipped entirely when the per-save candidate cap is zero — and is corrected rather than deleted, because the false invariant is what let the gap persist.

**Decision 3 — Predecessors become a projection, not a page.**
Capping depth alone would still return full bodies for the rows inside the cap. The token cost is the defect (measured 17.2k tokens at 52 saves, ~910k at depth 5,000), and it is amplified by pretty-printed JSON duplicated into `structuredContent`. Since `title` is immutable and fixed at insert — a guarantee the memory spec already makes — a `{id, title, status, createdAt}` projection is a faithful history listing. An agent that genuinely wants a predecessor's body already has the batch read. `truncated` + `predecessorCount` keep the omission visible instead of silent.

**Decision 4 — Staleness, not recency, resolves session ambiguity.**
The refusal to pick among concurrent active sessions is correct and specified; the bug is that nothing makes ambiguity transient. Adding `last_activity_at` and excluding stale rows removes the zombie from consideration *without* introducing the recency tiebreak the sessions spec forbids — genuinely concurrent sessions still refuse to guess. A periodic retirement pass is the second half; boot-only retirement is useless on a server that runs for weeks. This is an additive `ALTER TABLE ADD COLUMN`, so it needs no table rebuild and no FK dance.

**Decision 5 — Enforce scope with the type system, not with a naming convention.**
The unscoped session count evaded the confinement grep gate because the gate matches `admin*`/`unsafe*` prefixes and this method had neither. Renaming it is necessary but not sufficient: the durable fix is that the scoped variant *requires* a `Scope` argument, so a future scope-less call is a compile error. The same pass corrects the `memory.stats` output contract, which is stale in a second direction — it documents three counters the handler has never returned.

**Decision 6 — Classify op types exhaustively in one place.**
`prompt_purge` fell through because terminality is decided by two independent literal comparisons. Deriving both from one exported set fixes today's case; the invariant test asserting every op type falls in exactly one category is what prevents the next one. The test is the deliverable, not the two literals.

**Decision 7 — Reactivation is an access event, deliberately not an affirmation.**
Stamping `last_seen_at` on undo is what makes undo durable, and it is semantically right: an operator reviving a memory has touched it. It must *not* insert a confirmation, because that would advance the review baseline and collapse the two orthogonal staleness axes the memory spec keeps separate. This is the narrow reading, and the regression test pins it: decay → undo → force sweep → still active, with the review baseline unchanged.

**Decision 8 — Reject NUL bytes at the service boundary, don't sanitise them.**
A NUL in a title passes both JS length and `trim()` but drives SQLite's `length()` to 0, tripping the column `CHECK` and surfacing as an opaque `internal_error` with the memory lost. The guard already exists for `topic_key`; generalising it to `title`, `content`, `tags[]`, and the session `title`/`summary` is the consistent fix. Rejecting beats stripping: silently mutating agent-supplied content is worse than telling the agent its input was invalid.

## Risks

- **`capture_passive` gets slower.** Per-item embedding plus candidate detection adds latency proportional to item count. Detection is already best-effort on the save path and degrades rather than failing; the item count should stay bounded. Accepted: a bulk tool that produces uncurated, unembedded rows is worse than a slower one.
- **`topic_key` exposure widens the read surface.** It is scope-filtered like every other field, and the prefix scan behind `suggest_topic_key` must be scoped — a cross-scope leak here would be a genuine regression, so the scenario is spec'd explicitly.
- **The predecessor projection is a response-shape change.** Any direct MCP consumer reading `predecessors[].content` breaks. Given the measured token cost this is the right break; it is called out in `proposal.md`.
- **Correcting the `memory.stats` contract reduces numbers non-admin tokens see.** Deliberate, and the spec already promised the smaller number.

## Migration

One additive migration adds `last_activity_at` to the session table, backfilled from `started_at` so existing rows are immediately classifiable. No table rebuild, so the FK-off/`foreign_key_check` wrapper in the migration runner is not exercised beyond its normal path.

Removing `similaritySample` deletes a repository method and its only consumer; `memory_vec` is derived data and no stored value changes.

## Open Questions

- The staleness window for excluding a zombie from transport resolution. Long enough not to fight a slow turn, short enough that a killed client stops blocking attach within one working session. ~30 minutes is the starting proposal; it is a compile-time constant, not a tunable.
- Whether the predecessor depth cap should be the 64 that head resolution already uses, or something much smaller like 10. 64 still permits ~64 titles in one response, which is cheap; 10 is friendlier to context. Leaning 10, with `truncated` making the rest reachable.
