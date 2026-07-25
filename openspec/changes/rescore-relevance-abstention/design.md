## Context

`improve-recall-relevance` shipped the abstention mechanism disabled on purpose and made the eval harness the precondition for enabling it. The harness landed. What did not land is a quantity either gate can be calibrated against: the floor reads a logistic over raw bm25 that is always ≥ 0.5 and saturates within a few IDF units, and the gap ratio reads fused RRF scores whose consecutive ratios are fixed by `RANK_CONSTANT` at 0.984–0.996 within a branch-membership class and exactly 0.500 across the class boundary. Neither is a relevance measure. See `proposal.md` for the measured figures (one machine, 200-row corpus) and the RRF arithmetic.

The repo has already solved this problem once, one module away. `fix-retrieval-ranking-math` removed an absolute bm25 gate from `findSaveTimeCandidates` — "BM25 is unbounded and corpus-relative, so _no_ absolute floor on it is stable" — and replaced the reported similarity with `tokenContainment`, bounded `[0,1]` by construction and explicitly documented as "comparable enough to cosine for the `max(vec, fts)` merge". That is the shape this change reuses on the search path.

Constraints that bound the design: `memory.search` is a hot path with a perf change in flight (`tune-hot-query-paths`); SQL stays under `db/`; the gates must remain `null` until a committed sweep can justify a value; there is no operator configuration, so the values are compile-time constants named in `memory/spec.md`.

## Goals / Non-Goals

**Goals:**

- Give both gates a bounded, corpus-size-independent quantity with real dynamic range, so a swept value means the same thing on a 40-row eval corpus and a 5,000-row production one.
- Collapse the two score spaces into one evaluation point, so the two constants are comparable and one sweep covers both.
- Make the harness able to _decide_ the value: two error axes, enough abstention queries to resolve a threshold, and a reproducible sweep command.
- Make `memory/spec.md` and the code agree on the filter semantics, in the direction the spec already specified.
- Keep the disabled path free: with both gates `null`, no extra query and byte-identical results.

**Non-Goals:**

- Re-enabling `DIVERSITY_CAP`. Different failure, different fix, needs a session-labelled fixture (`proposal.md`).
- Changing the retrievers. The lexical branch keeps its pure-OR `sanitizeFtsQuery` semantics and the dense branch keeps its kNN with no distance cutoff. Making the OR into a minimum-should-match would arguably make the candidate set itself the relevance gate, but it removes recall unmeasured and is a larger retrieval change than this one.
- Changing fusion or the ranking boost. Both stay exactly as they are; the gates simply stop reading their output.
- Any MCP schema change. `abstained` / `abstainReason` already exist on the `memory.search` response, so no plugin work in the four clients.
- Gating `avgTokensReturned`. That belongs to `reconcile-specs-with-shipped-behaviour`.

## Decisions

**D1 — The gated quantity is a per-row relevance level, `level = max(lexicalCoverage, denseCosine)`, bounded `[0,1]`.**
`lexicalCoverage` is `tokenContainment(queryTokens, tokenSet(title + content))` — the fraction of the query's distinct lowercased tokens present in the row. It is corpus-size independent (it reads only the query and the row), monotone in match quality, and 1.0 by construction for a row containing every query token. `denseCosine` is the dense branch's existing `1 - distance`, already bounded and already model-pinned (the eval baseline records `embeddingModelId`). `max()` follows the shipped precedent in `findSaveTimeCandidates`.

Alternatives considered:

- _Min-max normalisation over the branch's own rank window_ — **rejected, and it is worth being explicit about why, because it is the obvious first suggestion.** Min-max maps the window's best row to exactly 1.0 by construction. An absolute floor on that quantity can therefore never reject anything except an empty window, which `hasCandidates` already handles. The same argument kills _rank-percentile over the window_ (leader is always percentile 1.0) and _z-score over the window_ (leader's z depends only on the window's shape). A window-relative quantity can express **shape** and never **level**; a floor is a statement about level.
- _Per-branch floors as two independent constants_ — rejected as the primary mechanism. Rejecting a branch's candidates changes what fusion sees, so the two thresholds interact and neither can be swept in isolation; the sweep grid becomes two-dimensional over interacting axes. One number in one place is calibratable. The sweep still **reports** each branch's leader level separately, so if it shows one unit dominating the `max()`, a follow-up change can split them on evidence rather than on taste.
- _Keeping bm25 but normalising by corpus size_ (e.g. dividing by `log(N)`) — rejected. It makes the scale less unstable without making it bounded, and it does nothing about the saturation: the difference between a 3/200 term and a 150/200 term would still be the difference between 0.98 and 0.50000.

**D2 — The lexical level has exactly one implementation.**
`tokenSet` and `tokenContainment` move from `save-time-candidates.ts` into `hybrid-search.ts`, beside `tokenizeWords`, and `save-time-candidates.ts` imports them back. That is the existing direction of dependency (it already imports `sanitizeFtsQuery` and `tokenizeWords` from there) and it means save-time candidate similarity and search-time lexical level cannot drift into two different definitions of "how much of the query is in this row".

**D3 — One evaluation point: immediately after fusion, before the ranking boost.**
Both gates read `level` on the fused, ordered pool, before `applyRankingBoost`. Post-fusion because the page only exists after fusion. Pre-boost because the boost is a ranking multiplier over recency, type and confirmation count with a reachable spread of 1.5× — it is not a relevance measure, and letting it move a relevance gate means a fresh, thrice-confirmed, irrelevant row can clear an abstention check while a stale relevant one cannot.

Alternatives considered: _keep today's split_ (floor pre-fusion on branch scores, gap post-boost on RRF) — rejected; it is the arrangement that needed two paragraphs of spec to explain, and its stated justification (RRF measures list shape, not match quality) is answered by not scoring either gate on RRF. _Both post-boost_ — rejected per the 1.5× smear above, which is measurable: 0.984 × 1.5 = 1.476 and 0.984 / 1.5 = 0.656, so the within-class band overlaps the 0.500 cross-class cliff and the two regimes stop being separable.

**D4 — The floor's reference is the maximum level in a bounded gate window, not the level of the fusion leader.**
The gate window is the first `min(offset + limit + GATE_WINDOW_MARGIN, rankWindowSize)` fused rows. `leaderLevel = max(level)` over that window. Using the fusion leader's own level instead would make the floor decision depend on fusion order, and fusion order is rank-based — the top fused row is not necessarily the highest-coverage row. Taking the max over a bounded prefix is well-defined, order-independent, and costs the same read.

**D5 — The relative filter is per-row against `leaderLevel`, not consecutive-pair truncation.**
`applyGapRatioFilter`'s consecutive form is replaced by: keep row iff `level >= ratio × leaderLevel`, preserving fused order. Two reasons.

First, the consecutive form cannot cut a gradually decaying tail at all. Levels `0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3` pass every consecutive test at `ratio = 0.5` (each step is ≥ 0.75), so a row at 33% of the leader survives; the per-row test drops everything under 0.45. Second, `level` in fused order is not monotone, and truncate-at-first-offender over a non-monotone sequence is order-dependent — one weak row at position 2 discards every better row behind it. A per-row test is order-independent and idempotent.

This **corrects** the justification `reconcile-specs-with-shipped-behaviour` recorded when it documented the consecutive form ("a per-best test would keep a long flat tail whose every member is individually far from the leader, which is the case the filter exists to cut"). That is inverted: a flat tail far below the leader is exactly what a per-best test cuts and a consecutive test keeps. The delta spec here restores the original "relative to that best score" wording, so code and spec agree in the direction the spec already specified.

**D6 — Levels are computed only when a gate is enabled, over a bounded window, from one by-ids read.**
`level` needs the row's `title` + `content`. With both constants `null` — the shipped state — the gate block is skipped entirely: no extra query, byte-identical results, no measurable cost. When enabled, one scoped by-ids repository read supplies the gate window's text (default page: ≤ 8 + `GATE_WINDOW_MARGIN` rows, not the 64–400 row rank window). Alternative considered: _per-token FTS probes to derive coverage without reading content_ — rejected, it is one FTS scan per query token against a posting list, strictly more expensive than one indexed by-ids read of a bounded row set. The read's cost at 1k/20k/50k rows is a measured task, not an assumption (`tasks.md` §5); a hot-path read that is not measured is how `tune-hot-query-paths` came to exist.

**D7 — The constants are renamed where the mechanism changed, and the spec names them.**
`ABSTENTION_FLOOR` keeps its name — same knob, new quantity. `GAP_RATIO_THRESHOLD` becomes `RELATIVE_LEVEL_RATIO`, because "gap ratio" describes a consecutive-pair test that no longer exists and a stale name is how code comes to silently disagree with its contract. `GATE_WINDOW_MARGIN` is new. `normalizeLexicalScore` is deleted rather than kept "just in case" — nothing else reads it, and leaving a discredited normalisation in the module invites its reuse.

**D8 — The spec's guarantee becomes a calibration bar, not an assertion about a constant's current value.**
`memory/spec.md` currently says these gates ship `null` and that "their disabled state is part of the contract". That phrasing has to be edited every time the value changes, which is exactly the class of self-contradiction `reconcile-specs-with-shipped-behaviour` is cleaning up. The requirement is rewritten to state what a commit enabling a gate must demonstrate:

1. a committed sweep across a grid of values, emitted by `pnpm run eval --sweep-abstention`;
2. `overAbstentionRate = 0` at both `k = 5` and `k = 8` — no gold-bearing query returns nothing;
3. `abstentionFalsePositiveRate` at or below its committed cap;
4. `precisionAtK` / `recallAtK` / `mrr` at or above their committed floors at both `k`;
5. the chosen value in the **interior of a plateau at least two grid steps wide** on every criterion above — a value that only works at one grid point is a cliff edge, not a calibration.

Whether this change lands the gates enabled is therefore an outcome recorded in `tasks.md` §4, not a promise made here. If the sweep produces no value clearing all five, the gates stay `null`, the measured grid is committed, and `improve-recall-relevance`'s constraint holds unchanged — which is a successful outcome of this change, not a failure of it.

**D9 — The harness measures two error axes, gated as caps.**
`overAbstentionRate` = share of gold-bearing queries that returned nothing, added to `AggregateMetrics` and the report line. Today such a query scores recall 0, indistinguishable from a confidently wrong answer, so the harness cannot tell "the floor is too high" from "ranking is bad" — which is the single most important distinction when sweeping a floor. Both abstention metrics are gated in `checkFloors` as **caps** (lower is better), stored in a new `caps` block in the baseline JSON, because a floor comparison on a lower-is-better metric is backwards. `abstentionFalsePositiveRate` and `overAbstentionRate` are gated here; `avgTokensReturned` is left to `reconcile-specs-with-shipped-behaviour`.

The cross-retriever definition of abstention stays "returned nothing" — that is what a caller observes, and `grep` / `memory-md-dump` have no flag to report. The `hybrid` retriever additionally drives `searchWithAbstention` and asserts its `abstained` flag agrees with emptiness, so a divergence between the flag and the behaviour fails the run.

**D10 — The abstention query set grows from 2 to at least 8, and P/R/MRR baselines are unaffected.**
Two queries give the metric three attainable values (0, 0.5, 1) — it cannot resolve a threshold, let alone a plateau. At least eight, drawn adversarially so the pure-OR lexical branch has vocabulary to latch onto (the two existing ones already do: "what GraphQL schema versioning strategy does atlas use" ORs `does`, `use`, `atlas` against the whole project). Adding them does **not** move `precisionAtK` / `recallAtK` / `mrr`: `aggregate` computes those means over `scored = metrics.filter(m => m.precisionAtK !== null)`, and an empty-gold query yields `null`, so it is already excluded. `avgTokensReturned` and the latency percentiles do move, since they are computed over all queries — that is a baseline regeneration, and it is why `writeBaseline`'s missing ratchet is called out as a hazard rather than relied on.

**D11 — The two existing abstention unit tests are replaced, not extended.**
`hybrid-search.test.ts`'s "an unrelated query abstains once a floor is enabled" abstains because the candidate set is empty, not because the gate discriminated; and "a sharp exact-phrase query does not abstain" passes trivially, because it uses `abstentionFloor: 0.5` and the old lexical score is always ≥ 0.5. Neither test can fail if the gate is wired to a constant. The replacements must have a non-empty candidate set on both sides of the decision, so the assertion is about the gate and not about `hasCandidates`.

## Risks / Trade-offs

- [Risk] The gate window's by-ids `title` + `content` read is on the search hot path → Mitigation: skipped entirely while both gates are `null` (D6), bounded to `offset + limit + GATE_WINDOW_MARGIN` rows rather than the rank window, and measured at 1k/20k/50k rows with `EXPLAIN QUERY PLAN` before any decision to enable (`tasks.md` §5). If the enabled path costs more than a stated budget, the gates stay `null` on cost grounds and that is recorded.
- [Risk] Filtering before the page slice means a requested page can come back short, or empty at a high `offset` → Accepted, and it is the specified behaviour ("SHALL NOT be padded to the requested limit"). Called out explicitly so a caller paginating to exhaustion is not surprised: an empty page under a relative filter does not mean the scope is exhausted. A scenario pins it.
- [Trade-off] `max(coverage, cosine)` compares two different units in one number → Accepted because the same merge is already shipped and documented in `findSaveTimeCandidates`, and because two interacting thresholds are strictly harder to calibrate than one imperfect one (D1). The sweep reports both components separately, so the decision to split is available on evidence.
- [Risk] Eight abstention queries over a 42-row corpus is a small sample; a value swept against it can overfit → Mitigation: the plateau-interior requirement (D8.5) rejects knife-edge values, and `overAbstentionRate = 0` at both `k` is a hard bar rather than a traded-off one. Residual risk accepted and stated: this calibrates against the committed corpus, and a corpus expansion may move the value. That is what the ratchet is for.
- [Risk] Enabling a floor removes recall silently — the exact failure `improve-recall-relevance` was built to avoid → Mitigation: `overAbstentionRate` makes the failure visible as its own number rather than as a recall dip, it is gated as a cap, and the bar is zero.
- [Risk] Ordering against `reconcile-specs-with-shipped-behaviour`, which edits the same two `memory` requirements and whose task 8.7 is this change's premise → Mitigation: stated as a dependency in `proposal.md`; the delta specs here are written against its post-merge text. If it lands second, its `memory` delta must be rebased, and its 8.7 struck as done here.
- [Risk] `writeBaseline` sets floors at `measured − 0.05` with no ratchet, so regenerating baselines for the new query set can silently lower a floor (`reconcile` task 8.8) → Mitigation: baselines are regenerated once, and the P/R/MRR floors are diffed and asserted unchanged before commit — which D10's arithmetic says they must be. Not fixing the ratchet here; that is 8.8's job.

## Migration Plan

None at the data layer. No schema change, no migration, no derived-data invalidation: `memory_fts`, `memory_vec` and the three entity tables are untouched, and nothing about their regeneration changes.

First boot after upgrade on a populated installation: identical behaviour to the previous version. Both gates ship `null` unless the sweep clears D8's bar, and even then the change is a search-ranking behaviour change, not a data change — no backfill, no rebuild, no first-boot work.

Rollback: safe and complete. The gates are compile-time constants and the only persistent artifacts touched are committed baseline JSON files. Downgrading the image reverts search behaviour with no state to unwind.

The one non-code artifact is the eval baselines. They are regenerated in this change for the enlarged query set; a reviewer should see `caps` appear and `avgTokensReturned` / latency move, and P/R/MRR floors byte-identical.

## Open Questions

- **Plain token coverage or IDF-weighted coverage?** Default: **plain**, because it is corpus-size independent by construction and already shipped. The concern is that `sanitizeFtsQuery` ORs stopwords, so "what GraphQL schema versioning strategy does atlas use" credits `what`, `does`, `use`. Plain coverage handles this better than it looks — those tokens are in the _denominator_ too, so a row matching only three of eight tokens scores 0.375, usefully below any plausible floor. Escalate to IDF-weighted coverage only if the sweep shows plain coverage does not separate the abstention queries from the gold-bearing ones; IDF re-introduces corpus dependence and is a step backwards unless the data demands it.
- **A stopword list for query tokens?** Default: **no.** The corpus is deliberately bilingual (there is a Spanish subset), so a list would need to be per-language and would become a second, invisible retrieval knob. If the sweep shows question-shaped queries systematically inflating coverage, the smaller fix is to require a higher floor, not to add a lexicon.
- **Should `memory.context`'s relevance channel inherit the gates?** Default: **yes**, automatically — it runs the same scoped hybrid search, and an empty relevance channel is already a specified, handled state. Worth naming because it means enabling a floor can silently empty a channel the agent reads at session start; the sweep does not cover that path, so a task asserts the channel behaves sanely under an enabled floor.
- **Should the floor's reference be the max level over the whole fused pool rather than the gate window?** Default: **the gate window** (D4). The two differ only at large `offset`, where a row outside the window could carry a higher level than anything in it. Deliberately left as the window, because a whole-pool max would need the whole pool's text — the cost D6 exists to avoid.
