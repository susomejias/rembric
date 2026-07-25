## 0. Prerequisites

- [x] 0.1 Confirm `add-retrieval-eval-harness` has landed; record the current scorecard as the before-picture.
- [x] 0.2 Confirm `fix-audited-defects` has landed, so decay undo is durable before the sweep starts firing in earnest.
- [x] 0.3 **Resolve the four open questions in `design.md`** — see "Open question resolutions" below.

## 1. Fix the touch-set bug (independent of the open questions)

- [x] 1.1 Moot by construction: search touches nothing at all now (2.1), so there is no touch-set to get wrong.
- [x] 1.2 Test: `memory.test.ts` asserts search never advances `last_seen_at` across repeated calls in both branches.

## 2. Apply the decided touch policy

- [x] 2.1 `search`/`searchWithAbstention` no longer touch; the `touch` option is removed from both signatures.
- [x] 2.2 `memory.get` still touches.
- [x] 2.3 Re-examined: decay windows left unchanged. The escalation branch (section 4) is what makes a sparser signal safe — a never-dereferenced row is now archivable via escalation regardless of `last_seen_at`, so shortening the recency windows would have been a second, unmeasured lever on the same outcome.
- [x] 2.4 Re-examined `hybrid-search.ts`: the ±0.1 recency term is left unchanged. It is a bounded tiebreaker on `lastSeenAt`, and with search no longer touching, its 7-day/90-day buckets now key on save time plus genuine dereferences — a sharper signal than before, not a degraded one.
- [x] 2.5 Consolidation tests reworked deliberately, not adjusted to fit: `operations.test.ts`'s reactivation-durability test moved to `reference` (no TTL, so escalation can never apply) to keep it testing the recency path it was written for.
- [x] 2.6 Covered by 1.2 plus the escalation tests: a returned-but-undereferenced row keeps its old `last_seen_at` and stays decay-eligible.

## 3. Add refutation as an append-only event

- [x] 3.1 Migration `0024_confirmation_verdict.sql` adds `verdict` (`'affirm'|'refute'`, default `'affirm'`) and nullable `reason` — two `ALTER TABLE ADD COLUMN`, no rebuild.
- [x] 3.2 Recorded with the agent's reason; `MemoryService.confirm` only calls `touchLastSeen` on `affirm`. Asserted in `memory.test.ts` and again live against seeded Docker data.
- [x] 3.3 `deriveReviewState` takes `lastRefutedAt`; a refutation newer than the affirmation baseline forces `needs_review` immediately, including for no-TTL types.
- [x] 3.4 Implemented as an argument on the existing `memory.confirm` (open question 3), with a description that gates refutation on having concretely verified the memory wrong and requires a `reason`.
- [x] 3.5 Test: `memory.test.ts` covers the flip, the untouched access signal/content/title/status, and a later affirmation clearing it.

**Every affirmation-baseline read now filters `verdict = 'affirm'`** — five call sites (`countConfirmations`, `confirmationCountsByIds` feeding the ranking boost, `reviewTimestampsByIds`, the decay confidence-floor subquery, and `needsReviewExprs`'s baseline). A refutation must never inflate a confidence count, a decay floor, or a review baseline.

## 4. Give the review queue a terminal state

- [x] 4.1 `ESCALATION_MULTIPLIER` in `review.ts`; derived at read/sweep time from `(created_at, confirmation events, type)`.
- [x] 4.2 No column and no extra sweep pass: escalation is an `OR` branch in the existing decay and needs-review SQL, and a `reviewEscalated` boolean computed in `deriveReviewState`.
- [x] 4.3 Test: `operations.test.ts` proves a memory read on every tick (so `last_seen_at` is always fresh) still becomes decay-eligible once long unaffirmed, and that a confirmation resets the window.

## 5. Surface queue depth

- [x] 5.1 `memory.context` gains `needsReviewTotal`.
- [x] 5.2 `memory.stats` gains scoped `needsReviewTotal` + `pendingJudgmentsTotal`. **Deviation:** the doctor's `review` field is server-wide, NOT scoped as written here — `memory.doctor` is built once at boot as a scope-agnostic closure, and its existing `sessions.active` is already server-wide while `memory.stats`'s equivalent is scoped. Threading a scope through that closure to break the precedent was not worth it; the asymmetry is deliberate and matches the spec exception already recorded for sessions.
- [x] 5.3 Test: `mcp-integration.test.ts` asserts the totals are scope-isolated across two fresh projects and consistent with the returned subset.

## 6. Measure

- [x] 6.1 `pnpm run eval` passes, above every committed floor and at the ceiling for P@8 (0.156) and R@8 (1.000); MRR@8 0.676. **Honest limitation:** the metrics did not move at all, and the corpus cannot detect the touch-policy difference — all 40 rows are ingested at once, so the recency boost's 7-day/90-day buckets never discriminate between them. The eval shows no regression in what it measures; it does not exercise the differential.
- [x] 6.2 **Headline number:** on the eval corpus with `last_seen_at` held fresh (the "read constantly, never re-affirmed" case), the pre-change rule could archive **0 of 40**; with escalation it archives **38** (26 `project`, 12 `user`). The 2 remaining are `reference`, which has no TTL and by design never escalates.
- [x] 6.3 Baselines re-run through `--write-baselines`: byte-identical, since the metrics were unchanged.

## 7. Verify

- [x] 7.1 `pnpm run typecheck && pnpm run lint && pnpm test` — clean, 99 files / 1458 tests.
- [x] 7.2 Smoked against the dev Docker stack on pre-existing seeded data: refutation rejected without a `reason`, accepted with one, `last_seen_at` byte-identical before and after (isolated from any `get`), `status`/`content` unchanged, affirmation count excluding the refutation, the refuted rows present in `memory.context.needsReview`, and `needsReviewTotal`/`pendingJudgmentsTotal`/`doctor.review` all populated.

## Open question resolutions

1. **Touch policy** — search stops touching entirely. "Touch only rank 1" and "keep touching but decay on a sparser signal" both keep two meanings in one column; stopping is the only reading of "one signal, one purpose" that holds.
2. **Terminal state** — escalation after `ESCALATION_MULTIPLIER` further multiples of the type's own TTL _spent in_ `needs_review`, ignoring `last_seen_at` and the confidence floor. Scoped to types that have a TTL, so `reference` never escalates.
3. **Verb shape** — an optional `verdict` argument on the existing `memory.confirm`, not a new `memory.flag_stale` tool. Consistent with every prior "argument over new tool" call in this repo, and it keeps the tool count flat.
4. **`memory.context` ordering** — unchanged. It inherits the fix from resolution 1: once search stops touching, `last_seen_at` comes to mean "recently dereferenced", which design.md argues was the correct meaning all along.

## Post-review corrections

An adversarial review after the initial implementation found two real defects, both fixed with regression tests:

- **A refuted memory was invisible in the queue.** `runNeedsReview` orders by the affirmation baseline, and refutation deliberately does not advance it, so a freshly-refuted row sorted last — behind `memory.context`'s 3-row cap the agent never saw back the memory it had just called wrong. Refuted rows now sort first.
- **Escalation fired one TTL early.** The predicate was `baseline + ttl * MULTIPLIER`, but `needs_review` begins at `baseline + ttl`, so a row had sat in the queue for only 1× its TTL. Now `ttl * (1 + MULTIPLIER)`.

Deliberately deferred, with evidence: `needsReviewExprs`'s `refutedExpr` embeds `baselineExpr`, so SQLite evaluates three correlated subqueries per active row on the needs-review paths. A `LEFT JOIN` over a grouped `confirmations` aggregate would collapse that to one, but it is a materially riskier rewrite of the predicate all four call sites share, and the paths are session-start/dashboard rather than per-turn. Worth measuring before rewriting.

Beyond the adds-only delta, two pre-existing statements in `openspec/specs/memory/spec.md` asserted that `memory.search` touches `last_seen_at` and were made false by this change (the hybrid-search requirement's result-shape sentence, and the "reading does not clear needs_review" scenario). Both were corrected during the merge rather than left contradicting the new requirement, since the spec is the authoritative contract.

Left open as a design question, not a defect: the escalation branch carries no confidence term, so `confidenceFloor` becomes a grace period rather than a floor — a `user` memory affirmed ten times but last affirmed past its escalation window is now archivable. That follows from "confidence must not make a memory un-archivable forever", but it is a real behaviour change worth revisiting if operators report surprise.
