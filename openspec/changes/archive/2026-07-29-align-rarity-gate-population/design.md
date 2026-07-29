## Context

The rarity gate is a single comparison at `services/save-time-candidates.ts:183`:

```
if (linkCount / scopeMemoryCount > ENTITY_RARITY_THRESHOLD) continue;
```

`scopeMemoryCount` comes from `EntitiesRepository.scopeActiveMemoryCount` (once per save, `:168`), `linkCount` from `entityLinkCount` (once per extracted entity, `:176`). Both count `status != 'archived'`. The candidate rows themselves come from `findOtherMemoriesForEntity`, which counts `status = 'active'`.

So numerator and denominator are consistent _with each other_ and inconsistent with the set they are supposed to describe. That is why the defect is invisible to inspection of either read in isolation, and why the compliance pass that fixed `findOtherMemoriesForEntity` left these two alone: on the only published scenario ("a very common entity generates no candidates") non-archived counting still gives the right answer, because active rows appear on both sides of the ratio.

Two structural facts make the mismatch grow rather than stay bounded:

1. **Superseded rows are permanent.** `memory/spec.md:625-631` permits physical purge only for `status = 'archived'` rows with no `memory_replaces` row naming them as `predecessor_id`. A superseded row always has such a row — its successor. So the superseded population only grows.
2. **`topic_key` convergence concentrates superseded links onto single entities.** `saveWithTopicKey` supersedes the prior active row in the slot; the extractor then links the new row to the same path/error code the topic has always been about. `n` saves on one topic produce `n-1` superseded links on the same entity value.

Together: the inflation of `linkCount` relative to `Lₐ` is worst precisely for the entity that identifies a long-lived topic.

## Goals / Non-Goals

**Goals:**

- Make the rarity gate's proportion measure the population candidates are drawn from, on both sides of the ratio.
- State that population normatively in `memory-entities`, with a scenario covering the direction nothing published covers, so a future predicate cannot re-drift while still satisfying the existing scenario.
- Measure the behavioural delta in both directions on an instrument that can move the number, with denominators reported.

**Non-Goals:**

- Recalibrating `ENTITY_RARITY_THRESHOLD` (D3).
- Changing `findMemoriesByEntity` (`entities-repository.ts:164`), the entity _retrieval_ path. It keeps `!= 'archived'` because `memory-entities/spec.md:293` specifies retrieval as complete within scope: a caller supplying an exact key wants the superseded history too. Different contract, different requirement.
- Changing `CANDIDATES_PER_SAVE_MAX`, the pool size, or the entity-leads precedence rule.
- Anything about `scopeActiveMemoryCount`'s cost. That is `tune-hot-query-paths` 4.5 (D4).
- Purging or pruning superseded rows, or pruning their entity links. The gate must cope with the accumulation, not wish it away (D5).

## Decisions

**D1 — The gate allocates slots; it does not bound volume. Adopt that framing in the spec.**

`2026-07-25-add-entity-index/design.md` D6 gave two reasons for the gate: it "would flood the per-save candidate budget, starving the lexical and dense channels". The first half is now false and the second half is now the whole job:

- Volume is bounded by `CANDIDATES_PER_SAVE_MAX = 5` at `save-time-candidates.ts:234` (`all.slice(0, opts.perSaveMax)`), unconditionally, gate or no gate. `surface-save-candidate-total` measured the cap binding on 38 of 38 saves.
- Composition is bounded by nothing else. `:230-233` sorts `Number(b.source === 'entity') - Number(a.source === 'entity')` first, so entity candidates lead unconditionally — five of them fill the whole budget and the lexical and dense channels return zero. The gate is the only mechanism standing between a ubiquitous path and the entire budget.

That framing settles the population question directly: only a row that can **occupy** a slot can distort the allocation, and only `active` rows can occupy one (`findOtherMemoriesForEntity` filters `= 'active'`). Counting superseded links measures a starvation risk with rows structurally incapable of causing starvation.

The second reading — the gate is a **signal-quality** filter, "don't spend a slot on an address that appears everywhere" — converges on the same population for the same reason: "everywhere" can only mean "among the rows you could retrieve". Both readings are recorded, and the spec adopts the slot-allocation one, because it is the one that is still literally true and because it is the reading under which the population is _derivable_ rather than asserted. Rejected: keeping the published "would flood the per-save candidate budget" wording. It is refuted by the cap, and leaving a refuted rationale in place is what let the population drift look defensible.

**D2 — `eq(memory.status, 'active')` on both reads, not a widened candidate set.**

The alternative direction is to make the numerator and denominator right by making the _candidates_ match them — i.e. revert `findOtherMemoriesForEntity` to `!= 'archived'` and let superseded rows surface as candidates. Rejected on three counts: it contradicts `memory-entities/spec.md:348` ("an existing **active** memory") outright; it would surface pairs whose target has already been replaced, which is judgement load with no decision behind it (the agent's answer is always "that one is superseded"); and it works against `topic_key` convergence, since a topic's own superseded ancestry would become its own candidate set on every save. The active-only direction also makes three docstrings and one method name true, which is the cheaper coherence.

**D3 — `ENTITY_RARITY_THRESHOLD` stays `0.15`; recalibration is a named follow-up.**

`0.15` has no provenance. `2026-07-25-add-entity-index/design.md` left "the rarity threshold for the candidate channel" as an open question, resolving only _proportion vs absolute count_, never the value; the constant has no covering test; `memory/spec.md:1119` names it without a number. So there is no calibrated value to preserve and nothing to recalibrate _from_ — the corrected population has to exist before a distribution over it can be measured.

The stronger reason is attribution. The population fix is bidirectional (D6), so its net effect on candidate composition is an empirical question. Moving the threshold in the same change makes every observed shift unattributable, and this change's only claim is that the population fix does what it says.

Rejected: a threshold expressed as an absolute link count (already rejected in the source design — absolute thresholds over corpus-relative quantities do not hold, the same lesson the inverted BM25 threshold taught). Rejected: shipping the corrected gate disabled behind a `null` in the style of the abstention floor. That machinery exists for gates whose _enabling_ removes recall; this gate already ships enabled and the change corrects its input, so a disabled variant would mean removing the gate, which reopens the starvation D1 describes.

**D4 — This change lands BEFORE `tune-hot-query-paths` 4.5, and 4.5 inherits a constraint from it.**

`tune-hot-query-paths` task 4.5 (unstarted; section 4 is entirely unchecked) reads: "`scopeActiveMemoryCount` counts the whole scope partition on every save (1.09ms at 50k, linear onward) purely as a rarity-gate denominator. Cache per `(scope, projectId)` for the request, or maintain a counter."

Order matters and is not symmetric:

- **This change first (chosen).** 4.5 then caches or maintains a counter over an already-correct population. One counter, one definition, no invalidation step.
- **4.5 first (rejected).** A maintained counter over `!= 'archived'` would need its _semantics_ redefined afterwards, and a persisted counter with the wrong definition has to be recomputed on upgrade — turning a two-line read change into a data-migration question for no reason.

The inherited constraint, stated here so 4.5's implementer does not have to rediscover it: **a counter over `active` must decrement on `active → superseded`, not only on `active → archived`.** Under `!= 'archived'` a `topic_key` upsert is counter-neutral (one row leaves `active`, stays non-archived); under `active` it is a decrement, and `saveWithTopicKey`'s supersede is the single hottest producer of that transition. A counter written to the old rule and reused under the new one drifts upward by one per topic re-save, permanently and silently — the exact failure mode `tune-hot-query-paths` design.md Q1 flags for `memory_entities.link_count` ("a denormalised counter that drifts is worse than a slow query"). The per-request _cache_ option carries no such hazard and is unaffected by this change.

`entityLinkCount` is not itself reworked by 4.5 — 4.5's entity items are 4.2 (`linkMemory`'s OR chain) and 4.8 (`findMemoriesByEntity` / `findOtherMemoriesForEntity` fan-out ordering). `entityLinkCount` appears in that change only as a _casualty measurement_ in the proposal (0.045 → 51.9ms under the undeclared-PK schema, fixed by its task 1.4, already landed). No overlap, no duplicated work; the two touch disjoint lines of the same file.

**D5 — Pin the population in the spec and in behavioural tests. No grep invariant.**

The evidence that a docstring is not a guard is direct: three docstrings said `active`, two predicates disagreed, and the one test covering these two methods (`entities-repository.test.ts:225-259`) is _titled_ "count active links and the scope total, excluding archived rows" over a fixture containing two active rows and one archived row — no superseded row in either case, so no assertion could fail. The test agreed with the docstrings and was equally powerless.

Three candidate pins were considered:

1. **A normative spec clause plus a converse scenario (chosen, primary).** The existing scenario is one-directional and non-archived counting satisfies it. The new scenario — a mostly-superseded entity SHALL still propose — fails under `!= 'archived'` for any fixture where the superseded links dominate, which is the reintroduction path.
2. **Behavioural tests at both layers (chosen, secondary).** A repository test asserting each count directly against a fixture containing active, superseded and archived rows, and a service test driving the gate end-to-end so the decision (not just the count) is asserted. These survive D4's rewrite: a counter maintained over the wrong population fails the service test.
3. **A grep invariant in `test/invariants.test.ts` (rejected).** It would have to match the SQL text of the two predicates, and D4's cached-count-or-counter rework replaces exactly that text. The invariant would then either go stale or forbid the optimisation — an invariant that blocks a measured performance fix it was never meant to govern. The invariants suite is sacred and is neither weakened nor touched by this change.

**D6 — The change is bidirectional, and the measurement must show both directions.**

With `A` active and `S` superseded rows in scope, and an entity carrying `Lₐ` active links and `Lₛ` superseded ones:

| entity shape             | current `(Lₐ+Lₛ)/(A+S)` | proposed `Lₐ/A`     | effect                     |
| ------------------------ | ----------------------- | ------------------- | -------------------------- |
| `Lₛ` large (topic chain) | inflated                | small               | **admitted** (was blocked) |
| `Lₛ = 0`                 | deflated by `S`         | larger by `(A+S)/A` | **blocked** (was admitted) |

The second row is the one easy to miss. The denominator shrinks for every entity, so an entity with no superseded links sees its ratio multiplied by `(A+S)/A`. On the production-shaped corpus this repo last smoked against (18 active / 17 superseded) that is **1.94×**; an entity on 20 of 99 active rows in a scope holding 99 superseded rows goes `20/198 = 0.101` (passes) → `20/99 = 0.202` (blocked).

That tightening is correct, not collateral: an address appearing on a fifth of the retrievable corpus is common by any reading of D1. But it means "more entities pass" is not the claim. The claim is "the proportion is measured over the right population", and the measurement therefore has to report **both** the newly-admitted and the newly-blocked counts, each with its denominator. A one-sided measurement would look like a win while hiding a possible net reduction in entity candidates.

**D7 — Displacement, not addition, wherever the cap binds.**

Because entity candidates lead the merged list and the response is `all.slice(0, perSaveMax)`, an additional admitted entity candidate takes a slot rather than extending the list. Where the cap already binds — 38 of 38 saves on the eval corpus, mean 11.2 detected against 5 kept — pending-judgment volume per save is **unchanged**, so this change does not add to the attention budget that `surface-save-candidate-total` was written to address (queue observed at 52; `order-relation-annotations` measured 1154 of 1164 annotations `pending_conflict` on an undrained corpus).

Judged favourable, with the trade named: what enters is a pair sharing an exact identifier that neither text nor vector similarity connects — the case the channel exists for, and the case whose _fresh-context_ judgement is irreplaceable. What leaves is the fifth-ranked lexical or dense neighbour, which `memory.search` over the saved memory's own text re-derives at any later time (`surface-save-candidate-total`'s re-derivability argument applies verbatim). Only on a scope sparse enough to find fewer than five candidates does an admitted entity add a pending row, and that is the regime where an extra candidate costs least.

Consequence for the measurement: **candidate count alone cannot show this change working.** Total candidates per save may not move at all. The measurement must compare candidate _composition_ (per-`source` counts) and the gate's admit/block decisions, not just totals.

**D8 — No `memory` delta.**

`memory/spec.md:1119` already reads "the maximum share of a scope's **active** memories an entity may be linked to", whose plain reading pins the denominator ("share of active memories") and the numerator ("an entity may be linked to" — links from those memories). Verified by reading the requirement, not inferred. What is missing is not a statement but a _testable_ one, and the gate is specified in `memory-entities`, so that is where the clause and the scenario belong. Republishing `memory`'s forty-line named-constants requirement in full — as the archive sync demands — to add a clause it already implies would be churn carrying transcription risk against a requirement nine other constants depend on. `memory/spec.md:505` ("gated by a rarity threshold so a common entity contributes nothing") stays a cross-reference and remains true.

## Risks / Trade-offs

- **[Risk] Net entity-candidate volume could fall, not rise, on scopes with few superseded rows** (D6, second row). A young scope with `S ≈ 0` sees the denominator barely change and no benefit, while a mature scope with `S ≈ A` sees a ~2× tightening for every superseded-free entity → **Mitigation**: the measurement reports newly-blocked alongside newly-admitted, each with denominators, on a corpus with a real superseded population. If newly-blocked dominates, D3's follow-up recalibration becomes required rather than optional, and the measurement is exactly the input it needs.
- **[Risk] Recalibration deferred means shipping a gate whose effective strictness has moved without a calibrated number behind it** → **Mitigation**: accepted knowingly, and the honest alternative does not exist — `0.15` had no calibration _before_ this change either (D3). The change makes the constant's meaning match its published description for the first time; the number's value was, and remains, uncalibrated. The follow-up is named with the measurement that seeds it, so it cannot be silently lost.
- **[Trade-off] A pair that would have been surfaced by the lexical or dense channel can now be displaced by an entity candidate, and displaced pairs lose fresh-context judgement** (D7) → **Accepted because** what displaces it is a shared exact identifier no other channel can find, the displaced pair is re-derivable via `memory.search` while the entity pair's fresh-context judgement is not, and the precedence rule that produces the displacement is already the published contract (`memory-entities/spec.md:354`) — this change does not create it.
- **[Trade-off] `entityLinkCount`'s cost does not improve and its predicate becomes marginally more selective** → **Accepted because** `= 'active'` is a narrower equality than `!= 'archived'` and cannot widen the scan; the join shape, indexes and row counts are unchanged. Cost is `tune-hot-query-paths`' subject, not this change's, and D4 keeps the two from colliding.
- **[Risk] A future reader "simplifies" the two predicates back to match `findMemoriesByEntity`'s `!= 'archived'`, which sits 70 lines above in the same file** → **Mitigation**: D5's converse scenario plus the two behavioural tests; and the deliberate divergence is stated in `## Non-Goals` with its reason, so the neighbouring predicate reads as a different contract rather than as an inconsistency to tidy.
- **[Risk] The eval corpus reports a vacuous zero and the change looks unverified** — it already did once: 40 memories, 2 entity links, 2 distinct entities each on 1 memory, 0 superseded rows carrying any link, so the prior pass measured "0 of 0" → **Mitigation**: the corpus is named a non-instrument in `tasks.md`, an instrument corpus is required instead, and every ratio must be reported with its denominator so a vacuous zero is visible as vacuous.

## Migration Plan

No migration, no schema change, no derived-data invalidation. The three entity tables (`memory_entities`, `memory_entity_links`, `memory_entity_scan`) are unchanged in content and shape — only a read predicate over `memory.status` moves — so no rebuild, no recipe-marker bump, no `memory_fts` / `memory_vec` touch.

- **Existing installations:** nothing happens at boot. The first `memory.save` after upgrade evaluates the gate over the corrected population; every prior row and every prior judgment is untouched. Instances with a large superseded population (`topic_key`-heavy corpora) see the largest behavioural shift, in both directions per D6.
- **Pending `memory_relations` rows created under the old population stay valid.** They were created from `findOtherMemoriesForEntity`, which already filtered `= 'active'`, so their targets were active at creation. Nothing is invalidated and nothing is re-derived.
- **Rollback** is a two-line revert of the two predicates. Nothing persisted records which population produced a given pending row, so a rollback leaves no inconsistent state. This holds only while 4.5 has not introduced a maintained counter — after that, rollback additionally has to consider the counter's definition, which is one more reason for the ordering in D4.

## Open Questions

1. **Should the corrected gate exclude a candidate's own superseded ancestry from `linkCount` as well?** An entity that appears only on the saved topic's own chain contributes `Lₐ = 1` (the just-saved row, already excluded via `excludeMemoryId`) and so scores `0/A` — admitted, then `findOtherMemoriesForEntity` returns nothing and the slot is not consumed. Harmless, and the arithmetic already handles it, so no clause is proposed. Left open only because it is the one case where the gate does work with no possible output, and if the cost measurement in `tune-hot-query-paths` ever makes a wasted `findOtherMemoriesForEntity` call matter, this is where the short-circuit goes. **Default: no change.**
2. **What does `Lₐ/A` mean when `A` is small?** At `A = 4`, one link is `0.25` and every entity is "common". The current code guards only `scopeMemoryCount === 0` (`:175`). Under the corrected population `A` is strictly smaller than before, so small-scope scopes reach that regime sooner — a fresh project with three memories now gates every entity it has. A floor ("no gating below `N` active memories") is plausible and is a **calibration** question, so it belongs to D3's follow-up together with the threshold itself rather than being guessed here. **Default: no floor in this change**; the measurement is required to report the smallest `A` at which a gate decision was taken, so the follow-up has the number.
3. **Should the follow-up recalibration be a spec change or a measured constant bump?** `memory/spec.md`'s named-constants requirement contracts that these values are compile-time and not operator-configurable but does not require a committed sweep for this constant (only the abstention floor and `RELATIVE_LEVEL_RATIO` carry that obligation). Moving `0.15` therefore does not strictly need a spec delta. Whether it _should_ — i.e. whether the rarity gate deserves the same evidence bar as the two disabled gates — is a real judgement call and is deliberately left to the follow-up, which will hold the distribution needed to argue it.
