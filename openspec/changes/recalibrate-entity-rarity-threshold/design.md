## Context

`align-rarity-gate-population` corrected both sides of the entity rarity gate to `eq(memory.status, 'active')` and deferred two questions with the measurement each would need (its `tasks.md` 8.1 and 8.2, `design.md` D3 and Open Question 2). Both predicates were re-verified on disk before this proposal was written: `entities-repository.ts` `scopeActiveMemoryCount` (predicate `:254`) and `entityLinkCount` (predicate `:278`) are both `eq(memory.status, 'active')`, `findOtherMemoriesForEntity` (`:310`) likewise, and `findMemoriesByEntity` (`:164`) still carries `!= 'archived'` deliberately. `tune-hot-query-paths` task 4.5 is still `- [ ]`, so the archived D4 ordering constraint is intact and inherited unchanged.

The gate is one line (`save-time-candidates.ts:203`):

```
if (linkCount / scopeMemoryCount > ENTITY_RARITY_THRESHOLD) continue;
```

Writing `Lₐ` for the entity's active link count, `A` for the scope's active count excluding the just-saved row, and `T` for the threshold, that comparison has two closed-form consequences neither of which needs a corpus:

- **It blocks whenever `A < Lₐ/T`.** At `T = 0.15`: `Lₐ = 1` blocks for `A ≤ 6`; `Lₐ = 2` for `A ≤ 13`; `Lₐ = 3` for `A ≤ 19`; `Lₐ = 4` for `A ≤ 26`; `Lₐ = 5` for `A ≤ 33`.
- **An admitted entity may carry `⌊T·A⌋` links.** Since entity candidates lead the merged list and the response is `all.slice(0, perSaveMax)`, one admitted entity fills the whole budget once `⌊T·A⌋ ≥ perSaveMax` — from `A ≥ 34` at the default of 5, rising to 216 permitted links at `A = 1443`.

Re-measured on the resident dev corpus (a copy, read-only; 1443 active / 601 superseded / 11 archived, 2441 entity links split 1711/708/22, 32 distinct entities, one project partition — every figure from the archived `measurements.md` reproduced):

```
gate evaluations taken: 32/32 (0 skipped for an empty denominator)
blocked at T=0.15:       0/32
admitted with Lₐ ≥ 5:   31/32       ← each can fill the whole 5-slot budget alone
entities with Lₐ < 5:     1/32       ← already admitted
ratio percentiles:  p50 0.0132  p75 0.0194  p90 0.1428  p95 0.1483  max 0.1490
identical decisions for every T ∈ [0.0194, 0.1303):  6 blocked / 26 admitted
```

One correction to the archived record, since re-verification was not ceremonial: the top entity is **two** active links from the gate biting, not one — `215/1443 = 0.14899` admits, `216/1443 = 0.14969` still admits, `217/1443 = 0.15038` blocks.

## Goals / Non-Goals

**Goals:**

- Answer both questions the archived change deferred, with evidence, and close them so neither is deferred a third time.
- Remove the small-`A` dead zone, where the channel is off on exactly the young scopes convergence help matters most on.
- Make the gate's published description true: what it does bound, what it does not, and under what precondition it applies.
- Leave behind an instrument that can drive the gate in BOTH directions, which neither available corpus can.

**Non-Goals:**

- Restoring the composition guarantee at large `A` (D5). Named as a follow-up, seeded with the 31/32 figure.
- Changing `ENTITY_RARITY_THRESHOLD`'s value (D1).
- Changing `CANDIDATES_PER_SAVE_MAX`, `CANDIDATE_POOL_SIZE`, the entity-leads precedence rule, or the merge/dedup step.
- Any repository change. Both predicates are already correct; no SQL is added anywhere by this change.
- `scopeActiveMemoryCount`'s cost — still `tune-hot-query-paths` 4.5.
- Pruning superseded rows or their entity links.

## Decisions

**D1 — `ENTITY_RARITY_THRESHOLD` stays `0.15`, and the question "is `0.15` right?" is RETIRED rather than deferred again.**

This is the substantive difference from the archived D3. That deferral was conditional: measure the corrected population first, then calibrate. The measurement has now been taken and its verdict is that no calibration is constructible. Three independent reasons:

1. **No gold signal.** The gate is on the save path; `pnpm run eval` enters retrieval through `searchWithAbstention` and never reaches it. The archived pass verified this empirically — changing BOTH gate predicates left `hybrid P@8 / R@8 / MRR@8` identical. So the sweep-plus-plateau discipline `memory/spec.md:1212-1218` contracts for the abstention floor and `RELATIVE_LEVEL_RATIO` cannot be transplanted: over `ENTITY_RARITY_THRESHOLD` it would report an unmoved baseline at every grid point, which discriminates nothing while looking like a calibration. This is now stated normatively in the `memory` delta, with a scenario rejecting exactly that evidence, so the next reader does not spend the effort discovering it.
2. **The available instrument cannot discriminate.** Every `T ∈ [0.0194, 0.1303)` takes the identical 32 decisions on the dev corpus. That looks like a plateau 0.11 wide whose interior is `≈ 0.075` — the very shape `memory/spec.md:1218` accepts as a calibration for the other gates — but it is an artifact of the seed's bimodal entity assignment (26 entities at `≤ 0.0194`, 6 at `0.1303–0.1490`, nothing between). A plateau produced by a generator is evidence about the generator. The 42-item eval corpus carries 2 entity links and cannot take a decision at all.
3. **No `T` fixes either regime.** Lowering it widens the dead zone (`A < Lₐ/T`); at `0.075` a single link would block every scope with `A ≤ 13` instead of `A ≤ 6`. Raising it widens saturation. Escaping saturation at `A = 1443` needs `T < 5/1443 = 0.0035`, which blocks essentially everything. The two failures are not opposite ends of a tuning range with a good middle; they are both consequences of comparing a proportion against a fixed-size shared budget.

Rejected: **bump to `0.075`** (the synthetic plateau's interior) — traceable only to the seed, and it doubles the dead zone. Rejected: **an absolute link-count threshold replacing the proportion** — already rejected twice upstream, and the signal-quality reading genuinely needs a proportion (3 links out of 1443 is informative, 3 out of 20 is not; an absolute cut cannot tell them apart). Rejected: **shipping the gate disabled behind a `null`** — re-rejected for the archived D3's reason: that machinery exists for gates whose _enabling_ removes recall, and disabling this one reopens the starvation it exists to prevent. Rejected: **generating a synthetic corpus with a plausible entity distribution and calibrating against it** — the calibration would then be traceable to whatever distribution was chosen, which is the same defect as reason 2 with an extra step of laundering.

What would reopen this: a corpus whose entity distribution is observed rather than generated (a real installation's export), or a labelled save-time candidate fixture with judged pairs, at which point the abstention-floor discipline becomes transplantable. Both are recorded in the `memory` delta as the evidence bar.

**D2 — The floor is keyed on the NUMERATOR (`Lₐ < ENTITY_RARITY_MIN_LINKS`), not the denominator (`A < N`).**

The deferred question asked for "no gating below `N` active memories". That form is rejected on two counts. First, every `N` is a guess with no derivation, which reproduces `0.15`'s original defect one constant along. Second, it is the wrong shape: an `A`-keyed floor at, say, `N = 10` still blocks a two-link entity at `A = 13` and a four-link entity at `A = 26`, which are the young-project cases the floor exists for; and it exempts entities that genuinely should be blocked (`Lₐ = 8` of `A = 9` at `N = 10`).

The numerator form is _derived_ from the gate's own published charter rather than chosen. `memory-entities/spec.md:354` grounds the whole gate in "only a memory that can OCCUPY a slot can starve another channel" — the argument the archived change used to derive the `active` population. Applied to the numerator it yields the floor directly: an entity linked to fewer active memories than the per-save budget holds cannot occupy the budget, so blocking it defends against nothing the requirement names. The two facts fall out of the same sentence, which is what makes this a derivation rather than a second guess.

It also subsumes the small-`A` case completely, which the `A`-keyed form does not: at `A = 3, Lₐ = 1` the ratio is `0.33` and blocks today, and `1 < 5` admits.

**Blast radius, proved rather than hoped.** The floor changes a decision only where the gate would have blocked AND `Lₐ ≤ 4`, which requires `A < 4/0.15 = 26.7`, i.e. `A ≤ 26`. Enumerated exhaustively: `Lₐ=1, A ≤ 6` · `Lₐ=2, A ≤ 13` · `Lₐ=3, A ≤ 19` · `Lₐ=4, A ≤ 26`. Nothing else moves, at any corpus size. On the dev corpus it is a no-op: 31 of 32 entities carry `Lₐ ≥ 5` and the 32nd is already admitted. So this is a small-scope fix with provably zero effect at scale — which is precisely what makes it shippable without the calibration D1 says the threshold cannot have.

**D3 — The constant is `5`, derived ONCE from `CANDIDATES_PER_SAVE_MAX_DEFAULT`, and NOT read from the operator setting at runtime.**

`CANDIDATES_PER_SAVE_MAX` is environment-configurable (`config.ts:132-137`: `z.coerce.number().int().min(0).max(25).default(5)`) and the MCP tool description calls it "the operator cap". Reading it inside the gate would make an admission rule environment-settable — the exact reason `CANDIDATE_POOL_SIZE` is kept off the environment (`memory/spec.md:1203`) and the reason `memory/spec.md:505` requires the detection thresholds to be compile-time. Worse, `perSaveMax = 0` is a supported configuration (batch/automation paths disable surfacing) and would make `Lₐ < 0` unsatisfiable, inverting the floor into a gate that always applies. So the coupling is a documented derivation at authoring time, pinned as its own compile-time constant, with a scenario in the `memory` delta asserting that an operator changing the per-save maximum does not move it.

Rejected: **`Math.min(perSaveMax, 5)` or any runtime read** — see above. Rejected: **reusing `CANDIDATES_PER_SAVE_MAX_DEFAULT` directly at the call site instead of naming a new constant** — it would put a save-time admission rule's value in `config.ts` under a name that says "default for an operator knob", and the `memory` constants requirement demands each constant be declared in the module owning the behaviour. Rejected: **folding the floor into `ENTITY_RARITY_THRESHOLD` as a second field of one value** — two orthogonal decisions (does the gate apply; does it block) read more honestly as two constants, and the spec has to name them separately anyway.

The value's consequence at a non-default operator setting is named and accepted: with `perSaveMax = 2`, an entity carrying 3 or 4 links can still fill both slots. The operator who narrowed the budget chose that, and the alternative is an environment-settable admission rule.

**D4 — The instrument is an exhaustive enumeration of the decision function, not a corpus sample.**

The gate is `f(Lₐ, A) = Lₐ/A > T` over two integers. A decision table over a grid of `(Lₐ, A)` — reported before and after, every ratio with its denominator — is _complete_ over the region where the change can act, where a corpus is a sample of that region and the two corpora available sample it barely (the dev corpus takes all 32 of its decisions at `A = 1443`; the eval corpus takes none). It is also the only instrument that can drive the gate in both directions, which the requirements for this change demand and no corpus in the repo can do.

The corpus measurement is kept, demoted to a reality check with a stated limitation, because it answers a different question: whether the enumerated region is reachable in practice. Its answer is the 31/32 saturation figure, which is D5.

Rejected: **extending the eval corpus with entity-bearing `topic_key` chains as the primary instrument** (the archived tasks' 4.2 approach, itself substituted at apply time). It would take a corpus with 2 entity links and 42 items and grow it until the gate fires, at which point the reported distribution is authored, not observed — so it has the drawbacks of D1's rejected synthetic calibration while being more work than the decision table. The service-level fixtures already cover the end-to-end path with exact arithmetic.

**D5 — This change does NOT restore the composition guarantee at large `A`, and the spec says so instead of leaving the claim standing.**

`memory-entities/spec.md:354` currently asserts the gate bounds composition. On the only corpus in hand it blocks 0 of 32 entities while 31 of them can fill the whole budget alone. Saturation is possible from `A ≥ perSaveMax/T = 34`, so the guarantee has been unmet on any real corpus since the gate shipped; the archived change did not create this and did not claim to fix it.

It is not fixed here. It is a _mechanism_ defect: a per-entity proportion cannot bound a shared fixed-size resource, and the fix — bounding the entity channel's share of the merged list — sits at the merge step, contradicts nothing but does modify the published precedence prose at `:360`, and needs a different instrument (per-save composition over a real ingest, not a decision table). Bundling it would put two unrelated mechanisms and two instruments in one change and make the floor's effect unattributable, which is the same mistake the archived D3 avoided.

So the delta does the honest minimum: it states the residual gap normatively, attributes it to the proportion-versus-fixed-budget form rather than to the threshold's value, and names where the fix goes. A spec that keeps claiming a guarantee the code has never delivered is worse than one that records the gap.

**D6 — Two spec deltas, both republished in full; `memory/spec.md:505` deliberately left alone.**

- `memory-entities`' channel requirement changes substantively (the precondition is normative, and two of its existing statements become false without qualification), so it is republished whole per the archive-sync rule.
- `memory`' constants requirement must also be republished: `ENTITY_RARITY_THRESHOLD`'s bullet asserts an unconditional maximum share, which the precondition falsifies, and its "so it does not become inert as a corpus grows" clause is true of the blocking decision but false of the composition bound — the distinction D5 turns on. Plus the new constant joins the list. The archived D8 avoided republishing this requirement to add a clause it already implied; that reasoning does not cover a bullet that becomes wrong.
- **`memory/spec.md:505`'s parenthetical** ("gated by a rarity threshold so a common entity contributes nothing") is left unchanged. It delegates explicitly — "see `memory-entities`'s save-time conflict-detection requirement" — so the precise rule lives in the requirement being modified, and republishing a fifty-line save requirement to adjust a summary inside its own delegation is churn with transcription risk. Tasks carry a STOP condition: if on re-inspection that clause reads as normative rather than as a delegating summary, a third delta becomes required.

Two contradictions were found by grepping `openspec/specs/` for the terms being specified, and both are fixed in the `memory-entities` delta rather than left to be discovered:

1. `:350` "Common entities SHALL NOT generate candidates" is unconditional; under the floor a 4-of-5 entity is admitted. Qualified to "an entity common enough to occupy the whole per-save candidate budget".
2. The `"The gate measures the active population, not the non-archived one"` scenario (added by the archived change) says "an entity whose links are all on `active` memories and amount to a large share of them" with no link-count condition — at `Lₐ = 2` the floor now admits it, so the scenario as written would be violated by the intended behaviour. Qualified with "at or above the compile-time link minimum". Its fixture must be rescaled to match (D7).

**D7 — The archived blocked-direction test is RESCALED, not relaxed, and the boundary fixture is documented as the constant's accidental guard.**

`save-time-candidates.test.ts:772` (`"an entity concentrated on the active population is gated even where superseded rows dilute it"`) pins the blocked half of the archived population fix with `Lₐ = 2`. The floor admits `Lₐ = 2`, so the test would fail — and the tempting repair (delete it, or drop the assertion) would silently unpin the population fix, whose mutation check showed this test is the only thing that fails when `scopeActiveMemoryCount` alone is reverted.

It is rescaled instead, to a fixture satisfying all three constraints at once: `Lₐ ≥ 5` (floor does not apply), `Lₐ/A > 0.15` (blocked on the active population), `(Lₐ+Lₛ)/(A+S) ≤ 0.15` (admitted on the non-archived one, so the mutation still flips it). `Lₐ = 5, A = 20, S = 14` works: `5/20 = 0.25` blocks, `5/34 = 0.147` admits. One construction: 5 entity-linked saves + 14 plain fillers + a 15-save `topic_key` chain (1 active head, 14 superseded).

Separately, `"a very common entity surfaces nothing"` (`:583`) is `Lₐ = 5, A = 5`. It sits exactly ON the boundary: it survives at `ENTITY_RARITY_MIN_LINKS = 5` and would break at `6`. That is recorded because it means the test suite silently encodes an upper bound on the constant, and the failure mode of a future bump is "re-dilute the fixture until it passes" — which destroys the evidence rather than reconsidering the bump. The tasks make it a deliberate boundary assertion instead of an accident.

The whole suite was audited for this coupling, since several fixtures dilute a scope explicitly to sit under `0.15`. Ratios found: `10/130 = 0.077`, `1/11 = 0.091`, `5/5 = 1.0`, `3/23 = 0.130`, `1/20 = 0.05`, `1/11 = 0.091` (archived admitted-direction), `2/A` (archived blocked-direction). Only the last changes decision under the floor. Note the tightest admitted fixture is `3/23 = 0.130`: the suite as it stands would also break if `ENTITY_RARITY_THRESHOLD` were ever lowered below `0.13`, which is worth knowing before someone tries.

## Risks / Trade-offs

- **[Risk] On a sparse scope the floor ADDS pending judgments rather than displacing them.** The archived D7's displacement argument holds only where the per-save cap binds; below five found candidates an admitted entity adds a row. The floor acts only at `A ≤ 26`, which is exactly the sparse regime → **Mitigation**: bounded arithmetically, not by hope. Per save the total stays bounded by the pre-existing `CANDIDATES_PER_SAVE_MAX`, so the worst case is the maximum that has always been possible (5), reached on scopes where 0–2 were previously found. Per entity the floor admits at most 4 candidates by construction. The tasks require the added-pendings figure to be reported with its denominator (saves where the cap did NOT bind, out of all saves) rather than asserted as small.
- **[Risk] A 4-of-5-memory entity is now admitted, and by the signal-quality reading of the gate that entity carries no signal** → **Accepted because** the displacement cost is near zero there: a five-memory scope has at most four other candidates in total, so nothing is starved, and all four pairs share an exact identifier. The composition reading — the one `memory-entities/spec.md:354` adopts and the one the floor is derived from — gives no reason to block it at all.
- **[Risk] The floor makes `findOtherMemoriesForEntity` run where it previously short-circuited, on scopes that were blocking** → **Accepted because** it runs only at `A ≤ 26`, where the join reads at most 26 rows, and the query is already issued on every admitted entity at every scope size. The `scopeMemoryCount === 0` guard stays FIRST and stays a `continue`, so a scope with no other active memory still costs zero extra queries (`A = 0` implies `Lₐ = 0`).
- **[Risk] Retiring the "is `0.15` right?" question reads as giving up, and a future reader re-opens it and repeats the work** → **Mitigation**: the reason is recorded normatively, not just in this design — the `memory` delta states why a harness sweep is not evidence for this gate and has a scenario rejecting a change whose only evidence is one. The two observations that WOULD reopen it are named. The alternative, a third deferral, has a worse failure mode: the archived change already showed that a deferred calibration survives only as long as someone reads the archive.
- **[Trade-off] The change ships a gate whose stated purpose is still unmet at `A ≥ 34`** (D5) → **Accepted because** the alternative is bundling a merge-step mechanism change with a different instrument into a change whose two questions are about the threshold, making the floor's effect unattributable. The gap is stated in the spec rather than papered over, and the follow-up is seeded with the 31/32 figure — the same mechanism by which this change exists.
- **[Trade-off] Two long requirements are republished verbatim-except-for-the-edits, with real transcription risk** (D6) → **Accepted because** both contain statements that become false, and mitigated by a task that diffs each republished requirement against the published text and requires every differing line to be an intended edit.
- **[Risk] The `memory-entities` requirement now carries eleven scenarios and is getting long enough that a future editor splits it, losing the derivation that ties population and floor to one sentence** → **Mitigation**: the two derived clauses cite the same charter sentence explicitly, so a split has to carry it. Not otherwise guarded; noted as a known erosion path.
- **[Risk] `tune-hot-query-paths` 4.5 lands later and maintains a counter for `A`; a counter that drifts would now also move the floor's boundary** → **Mitigation**: the floor reads `entityLinkCount` (`Lₐ`), which 4.5 does not touch, so the floor is unaffected by any denominator rework. The archived D4 constraint (a counter over `active` MUST decrement on `active → superseded`) is inherited unchanged and restated in the tasks so it is not lost by being in an archived document.

## Migration Plan

No migration, no schema change, no derived-data invalidation. The three entity tables (`memory_entities`, `memory_entity_links`, `memory_entity_scan`) are unchanged in content and shape; nothing touches `memory_fts` or `memory_vec`; no recipe-marker bump. No SQL is added anywhere, so the data-access confinement invariant is untouched.

- **Existing installations:** nothing happens at boot. The first `memory.save` after upgrade evaluates the gate with the floor applied. Installations whose scopes are all large see no behavioural change at all (proved for the dev corpus: 31/32 entities at `Lₐ ≥ 5`, the 32nd already admitted). Installations with many small project scopes see the entity channel start proposing on those scopes, bounded per save by `CANDIDATES_PER_SAVE_MAX` and confined to `A ≤ 26`.
- **Pending `memory_relations` rows created before the upgrade stay valid.** Their targets came from `findOtherMemoriesForEntity`, which filters `= 'active'`, so they were active at creation. Nothing is invalidated, nothing is re-derived, no judgment is reopened.
- **Rollback** deletes one constant and one condition. Pending rows created under the floor remain valid for the same reason; nothing persisted records whether the floor was in effect when a pair was proposed, so no inconsistent state survives a revert. As with the archived change this holds only while `tune-hot-query-paths` 4.5 has not introduced a maintained counter.

## Open Questions

1. **Should `ENTITY_RARITY_MIN_LINKS` be `5` or `CANDIDATES_PER_SAVE_MAX`'s configured value when the operator has raised it?** Raising the budget to 10 means an entity with 5–9 links can fill it, and the floor no longer covers that. **Default: the compile-time `5`**, per D3 — an admission rule must not be environment-settable, and the operator raising the cap has asked for more candidates, not for stricter gating. Recorded rather than silently decided because it is the one place the derivation and the constant genuinely part company.
2. **Should the gate short-circuit `findOtherMemoriesForEntity` when `Lₐ = 0`?** Inherited from the archived Open Question 1. With the floor in place `Lₐ = 0` now reaches the query (it did not before, since `0/A ≤ T` also admitted — so nothing changes). **Default: no change**; it is one query returning nothing, and the place for the short-circuit is `tune-hot-query-paths` if a wasted call ever measures.
3. **Where does the deferred composition bound belong — the merge step or the entity pool?** Capping the entity channel's share of `all.slice(0, perSaveMax)` preserves the pool and the reported `detected` count; capping the pool per entity changes `detected` and therefore `candidatesDetected`, which `mcp-api` specifies as "the number of distinct candidate pairs the detection ranked BEFORE the cap". Genuinely open, and deliberately not settled here — it is the follow-up's first decision, and it needs the per-save composition measurement this change does not take.
