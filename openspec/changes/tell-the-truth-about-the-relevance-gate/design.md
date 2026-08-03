# Design — tell the truth about the relevance gate

## Context

`hybridSearch` (`apps/server/src/services/hybrid-search.ts:117-152`) has two gates over the fused pool and reports exactly one bit about them, `abstained`. Three facts about the shipped state, each verified in source:

1. `export const ABSTENTION_FLOOR: number | null = null` (`hybrid-search.ts:47`). The only `abstained: true` return is guarded by `if (abstentionFloor !== null && (leveled.length === 0 || leader.level < abstentionFloor))` (`:145`). No production caller supplies an override — `MemoryService.searchWithAbstention` takes an optional `gates?: GateOverrides` (`memory.ts:445`) and the only non-test caller, `handleSearch` at `memory-tools.ts:961`, omits it. So `abstained` is a constant `false` in production.
2. `export const RELATIVE_LEVEL_RATIO: number | null = 0.4` (`hybrid-search.ts:58`) ships **enabled**, and `applyRelativeLevelFilter` runs on every text query. It shortens 18 of 24 committed eval queries at `k=8`.
3. `const ABSTAIN_REASON = 'no candidate cleared the relevance floor'` (`hybrid-search.ts:102`) is the single reason string, and it names the floor specifically.

The measured consequence, through the real MCP boundary rather than by reading: `zzqqwx vvbbnm ppllkk xhtqrv` → 8 of 8 rows, `abstained:false`. Control: the same path with `abstentionFloor: 0.99` → `abstained:true` with the floor's reason. The flag mechanism is sound; it has no trigger.

### The published contradiction

Two in-force requirements cannot both stand. Verbatim, with `file:line`:

`openspec/specs/memory/spec.md:372`

> A page shortened by the relative filter SHALL NOT be padded to the requested limit, and SHALL report `abstained: false` — abstention is the floor's verdict, and a caller MUST be able to tell "nothing relevant exists" from "fewer than `limit` rows were relevant".

`openspec/specs/retrieval-evaluation/spec.md:179-182`

> #### Scenario: An abstention flag that disagrees with the result set fails the run
>
> - **GIVEN** a retriever that reports an explicit abstention flag
> - **WHEN** it reports `abstained: true` while returning results, or `abstained: false` while returning none
> - **THEN** the evaluation job SHALL fail

The relative filter runs before the page slice, so it can legitimately produce an empty page (`memory/spec.md:301`: "an `offset` beyond the fused pool SHALL yield an empty page rather than an error"), which `memory/spec.md:372` then requires to report `abstained: false` — precisely the combination `retrieval-evaluation/spec.md:181` says must fail the job.

Both trace to one change, `openspec/changes/archive/2026-07-28-rescore-relevance-abstention/design.md`. Its D9 (`:84`) set the cross-retriever definition:

> The cross-retriever definition of abstention stays "returned nothing" — that is what a caller observes […] The `hybrid` retriever additionally drives `searchWithAbstention` and asserts its `abstained` flag agrees with emptiness, so a divergence between the flag and the behaviour fails the run.

while its own Risks section (`:95`) accepted the opposite as specified:

> [Risk] Filtering before the page slice means a requested page can come back short, or empty at a high `offset` → Accepted, and it is the specified behaviour ("SHALL NOT be padded to the requested limit"). Called out explicitly so a caller paginating to exhaustion is not surprised: an empty page under a relative filter does not mean the scope is exhausted. A scenario pins it.

It was safe only because both gates were `null` when it landed, so neither branch of the contradiction was reachable. `RELATIVE_LEVEL_RATIO` was later enabled (`archive/2026-08-03-weight-relevance-levels-by-idf`) without revisiting it.

### Constraints

- **83 chars of description headroom.** `SEARCH_DESCRIPTION` measures 1817 (`String.length`) against `DESCRIPTION_MAX_LENGTH = 1900` (`server.ts:124`), asserted over a real `tools/list` response at `mcp-integration.test.ts:379`. `mcp-api/spec.md:2001` records that truncation is a tail cut and that the abstention sentence IS the tail. A sentence cannot be appended; text must be swapped.
- **`mcp-api/spec.md:413`** mandates description content that must survive any reword: the "Call this WHEN …" recall trigger, the hybrid-ranking clause (vector similarity combined with FTS5), and the page-widening affordance (larger `limit`, or `offset` paging).
- **`memory/spec.md:376`**: "While BOTH gates are disabled the branch SHALL perform no gate-related work at all: it SHALL issue the same queries and return the same result ids as if the gates did not exist." Any new state must not add a query or a level computation on the both-`null` path.
- **`mcp-api/spec.md:1484`**: every tool advertises an `outputSchema` and returns conforming `structuredContent`. A new response field must be added to `memorySearchOutput` and to the context output schema, not just to the body.

## Goals / Non-Goals

**Goals**

- Make `abstained: true` reachable on a state that actually occurs, with a reason that names the mechanism that spoke.
- Give a caller a way to distinguish "the gate shortened this page" from "the corpus ran out", on both surfaces that serve ranked relevance.
- Stop the tool description from naming a disabled mechanism, without losing the anti-confabulation instruction or exceeding the CI-enforced cap.
- Resolve the published contradiction in one direction, on the record.

**Non-Goals**

- Enabling or calibrating `ABSTENTION_FLOOR`. Unachievable on the committed corpus — the level distributions overlap on `[0.296, 0.307]`, so criteria 2 and 3 of `memory/spec.md:1361` cannot both be met at any value (see Open Question 3, and `proposal.md`'s out-of-scope list for the measurement).
- Adding a distance floor to the dense branch — the actual cure for the garbage-query result. Recall risk; needs its own sweep and baselines.
- Changing which rows any query returns, or their order. Every change here is a report about a decision already taken.
- Making the eval harness's abstention guard non-vacuous on the committed corpus. Not reachable without adding a corpus query (D7).

## Decisions

**D1 — The contradiction resolves in favour of retrieval, against the harness.**
`retrieval-evaluation/spec.md:179-182` is narrowed to fail only on `abstained: true` while returning results. The other direction is deleted, not weakened to a SHOULD.

Rationale: two `memory` requirements (`:301`, `:372`) mandate the empty-page-with-`abstained:false` response, and they are the retrieval contract — the harness observes the retriever, so where they disagree the harness is the side that is wrong. The surviving direction is the one that can catch a real defect: a retriever claiming it found nothing while handing rows back is incoherent under any reading, and it is exactly the failure mode a future floor could introduce (returning `ids` alongside `abstained: true`).

Alternative considered and rejected: keep the biconditional and fix it by adding the empty-pool abstention (D2), on the observation that at `offset: 0` — the only offset the harness uses — an empty page does imply an empty gated pool, which after D2 implies `abstained: true`. Verified: `applyRelativeLevelFilter` always keeps the pool leader (`level ≥ ratio × leaderLevel` holds for the leader at any `ratio ≤ 1`, pinned by the existing test at `hybrid-search.test.ts:865-874`, "even at ratio 1" → 1 row), so at `offset: 0` the biconditional is sound. Rejected anyway: the requirement is a **contract statement about a retriever**, not a description of the harness's call pattern, and leaving it in place would keep a spec-level contradiction alive for whoever next reads it in isolation. The narrowed version says something true at every offset.

**D2 — `abstained: true` means the fused POOL was empty, not that the PAGE was empty.**
The new state is `fused.length === 0` after `fuseRRFWithScores`, evaluated before the gate block so it holds with both gates `null` (satisfying `memory/spec.md:376` — a length check on an array already in hand costs no query and no level computation).

This narrows `memory/spec.md:372` rather than reversing it. The shortened-page rule stays exactly as written: a short page reports `abstained: false`. What changes is that the case "the retriever had nothing to shorten" acquires its own verdict. And it reconciles with `:301`: a deep `offset` over a non-empty pool is an empty PAGE with a non-empty POOL, so it keeps reporting `abstained: false`. The spec delta states both sides in one requirement, because the distinction is the entire content of the decision and a reader who takes "empty response ⇒ abstained" away from it will implement the wrong thing.

The two states are provably disjoint, which is why the pool framing is safe: when the pool is empty the relative filter has nothing to remove, so `gateShortened` cannot fire; when the pool is non-empty the filter keeps at least the leader, so the gated pool is non-empty and D2 cannot fire.

Alternative rejected: `abstained: true` whenever the returned page is empty (the archived D9 reading, "abstention = returned nothing"). That is what creates the contradiction — it makes a deep `offset` an abstention, contradicting `memory/spec.md:301`, and makes the flag a function of the page requested, which `memory/spec.md:369` rules out for gate decisions in general ("the same query against the same corpus could abstain at one offset and not at the next").

Reachability of the new state, since a state nothing reaches would just be a second dead flag: an empty scope; a `type` or `status` filter that excludes every row (both are SQL predicates in **both** branches — `searchBm25Ids` at `hybrid-search.ts:427-437`, `knnByQueryVector` at `:473-479` — so the pool, not just the page, comes back empty); `status: 'archived'`, which skips the dense branch entirely (`:455`) leaving an FTS-only pool; and any deployment with no embedder wired whose query tokenises to nothing (`sanitizeFtsQuery` → `''` → `return []` at `:425`). The last is already exercised by a committed test: `queries.test.ts:59-62` calls a lexical-only retriever with `zzqqwx vvbbnm ppllkk` and asserts `ids` empty.

**D3 — The reason string is new, not reused.**
A second module constant beside `ABSTAIN_REASON`. Reusing `'no candidate cleared the relevance floor'` for an empty pool would attribute the verdict to a gate that is off and never ran — the same category of untruth this change exists to remove. The spec requires only that the two reasons be distinct and that the floor's be unchanged; the proposed wording is `'no candidate matched the query in this scope'`, which names the observable rather than a mechanism, so it stays true if the pool later empties for a different reason.

**D4 — The field is `gateShortened`, fires on cause-and-effect, and is omitted otherwise.**
Present and `true` iff **both**: the relative filter removed at least one row from the fused pool, AND the returned page holds fewer rows than the requested `limit`. Omitted in every other case.

Both conjuncts are load-bearing. Without the removal test, a page short because the pool was small would claim the gate shortened it. Without the shortness test, a full page 1 of a heavily-gated pool would carry a flag that tells the caller nothing (nothing was withheld from _this_ page). The conjunction is exactly the question the caller has: "is there more behind this short page?"

The deep-offset case discriminates the two candidate names. Consider pool 5, gate keeps 2, `limit: 2, offset: 2` → empty page, and the gate IS the cause (without it page 2 is full — the existing test at `hybrid-search.test.ts:898-905` proves precisely that with its `relativeLevelRatio: null` control). `gateShortened` fires: correct. Now pool 5, gate keeps 5, `limit: 2, offset: 4` → one row, short, gate removed nothing → flag absent: correct. The explorer's alternative `poolExhausted` inverts the framing and cannot express this: the second case _has_ exhausted the pool, so the name would demand `true` on the case that must stay silent. Rejected on that.

Optional-when-false rather than always-present-boolean, mirroring `viaEntity`, `entityIndexDraining` and `abstainReason` in the same response (`memory-tools.ts:1051-1054`). `abstained` stays always-present because it already is and removing it would be breaking.

**D5 — The description tail is swapped, and 43 characters are reclaimed to pay for it.**

Three edits, all in the shipped string at `server.ts:130`. Removed → added:

1. `(results are ranked by relevance over a bounded window, so a deep `offset` returns an empty page)` → `(ranked over a bounded window, so a deep `offset` returns an empty page)`. 97 → 72, **−25**. The clause is kept, not cut: after this change it is the documented control case for `gateShortened`.
2. `Returns a small default page (8); if every result looks relevant and you need more, prefer raising `limit` (up to 200).` → `Returns a small default page (8); need more? Prefer raising `limit` (up to 200).`. 119 → 80, **−39**. Still names the default page, the widen verb and the ceiling, so `mcp-api/spec.md:413`'s widen affordance survives.
3. The tail. Removed:

   > `abstained:true` means no memory cleared the relevance floor — treat as "nothing relevant found", not as a signal to invent or assume context.

   Added:

   > `abstained:true` means nothing matched — treat as "nothing relevant found", not as a signal to invent or assume context. `gateShortened:true` means a relevance gate cut weaker rows: a short page is not corpus exhaustion, and a full page is not proof of relevance.

   142 → 263, **+121**.

**Arithmetic: 1817 − 25 − 39 + 121 = 1874, leaving 26 chars of headroom under 1900.** Measured on the assembled string with `String.length`, not summed by hand; the applier re-measures against the real `tools/list` response, which is what `mcp-integration.test.ts:379` asserts over.

Content requirements confirmed to survive, each checked against the edited string rather than assumed:

- `mcp-api/spec.md:413` recall trigger — `Call this whenever the user references past work or asks "remember", "recall", "what did we do", "recuerda", "acuérdate".` untouched (edits are all downstream of it).
- `mcp-api/spec.md:413` hybrid ranking — `Ranks by hybrid semantic + keyword relevance (vector similarity ⊕ FTS5), so paraphrases and cross-lingual queries match.` untouched.
- `mcp-api/spec.md:413` widen affordance — larger `limit` and `offset` paging both still named (edits 1 and 2 preserve both).
- `mcp-api/spec.md:254` anti-confabulation — `not as a signal to invent or assume context` is carried through **verbatim**, deliberately: it is the clause the scenario is written against.
- The word "floor" is gone, which is the point of the reword.

`memory.context`'s description is NOT touched. It never mentioned abstention (`grep -rn abstain apps/server/src/mcp/` returns only `memory-tools.ts` code and `server.ts:130`), and adding a mention would be new mandated content in a second capped string for no measured benefit.

The 26-char margin is an accepted consequence, recorded rather than hidden: the next editor of this description will have to reclaim before adding, which is `mcp-api/spec.md:2001`'s stated intent ("the guard fires on an edit that APPROACHES the ceiling"). The next reclaim candidate, so it need not be rediscovered: `, without the noise a text query has on identifiers` (49 chars, entity-branch justification, not mandated by any requirement).

**D6 — `memory.context` reports the ranked pass, and only when the ranked pass ran.**
The relevance channel switches from `deps.memory.search` to `searchWithAbstention` and gains one sibling field:

```
rankedPass?: { abstained: boolean; reason?: string; gateShortened?: true }
```

Present only when the ranked pass actually executed. Two paths skip it: no derivable `focusText` (`memory-tools.ts:1370`), and an entity pre-pass that already filled the channel to `RELEVANCE_LIMIT` (`:1410`, `if (byId.size < RELEVANCE_LIMIT)`). Emitting `abstained: false` for a search that never ran would be a claim the server did not measure — the same defect class as the dead flag.

One nested object rather than three flat siblings (`relevanceAbstained`, `relevanceAbstainReason`, `relevanceGateShortened`): the caller's first question is "did the ranked pass run at all", which is one presence check on an object versus three correlated absences, and inside the object the field names stay identical to `memory.search`'s so the two surfaces read the same. `rankedPass` over `relevanceGate` because `via: 'ranked'` already establishes "the ranked pass" as this response's vocabulary (`mcp-api/spec.md:701`).

Subtlety the spec delta must state: `gateShortened` here describes the **ranked pass's own page against the limit that pass requested** (`RELEVANCE_LIMIT`, unconditionally, regardless of how many rows the entity pre-pass already contributed). So the channel can be full while `rankedPass.gateShortened` is `true`. Left as-is rather than "fixed" by passing a reduced limit: the pass's limit is existing behaviour and changing it would change which rows the channel returns, which this change is not doing.

**D7 — The eval harness's abstention guard is given a test, not a corpus query; the `abstentionFalsePositiveRate` cap is recorded as known-inert and left alone.**

Measured: replacing `checkAbstentionFlags`' predicate (`run-eval.ts:77-79`) with `if (false)` leaves `pnpm run eval` output and exit code identical. The correct reading — and the one the tasks must verify against, because the naive reading is wrong — is _not_ "the check is broken". A guard against a defect passes when there is no defect; `if (false)` is undetectable by construction unless some outcome violates the predicate. What the measurement actually shows is that **no committed outcome exercises the check in either direction**: nothing abstains and nothing returns empty. The archived sweep states the structural reason in one line, `archive/2026-08-03-weight-relevance-levels-by-idf/measurements/sweep-after-amendment.txt:56` — "fused pool per query: min 10, max 26" — and D2's reachability analysis says why that cannot change without a new query: the dense branch has no distance floor, so a non-empty scope always yields a non-empty pool.

This change therefore does **not** make the eval guard fire on the committed corpus, and says so rather than implying otherwise. Coverage moves to where it can exist:

- `checkAbstentionFlags` gets a direct test over synthetic `RawOutcome`s covering both the surviving direction (must fail) and the narrowed-away one (must now pass). That is what makes the narrowing a verified behaviour change rather than a text edit.
- `queries.test.ts:59-62`'s existing empty-pool probe gains the `abstained: true` + reason assertion it was one line short of.
- The mutation the tasks require on the harness is the **inverted predicate** (`!==` → `===`), which must make `pnpm run eval` FAIL naming ≥1 query. That proves the check evaluates 24 live outcomes. The `if (false)` run is still required, with the expectation recorded here that it passes unchanged, so the result is interpreted rather than mistaken for a regression.

Same area, same shape, deliberately untouched: all three committed baselines carry `"abstentionFalsePositiveRate": 1` as a cap (`baselines/{hybrid,grep,memory-md-dump}.json:31,35`) while the measured value is `1.000`. Since it is a rate, `measured > cap` is arithmetically unreachable, and `ratchetCaps` cannot tighten it either — it clamps every proposal with `Math.min(1, measured + headroom)` (`floor-ratchet.ts:136`). It is an inert gate. Not specified here and not fixed here: it becomes fireable only when the corpus contains a query that correctly abstains (an empty-gold query returning nothing), which is the same deferred corpus work, and it would move committed baselines. Writing a requirement this change does not implement is the overclaim the change exists to remove. Recorded in `tasks.md` §7 as deferred so it is not lost.

**D8 — Existing `abstained === false` assertions are re-verified, not assumed.**
Six committed assertions could interact with D2. Predicted outcomes, each with the reason, to be confirmed by running rather than by reading (a test green on both sides of the change proves nothing):

| Site                            | Corpus at that point             | Prediction                                                                                                                                                        |
| ------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hybrid-search.test.ts:658-674` | 1 row saved, embedder wired      | green — dense branch returns it, pool non-empty. **Name is now an overclaim** ("never abstains" with gates disabled) and should be tightened to "non-empty pool". |
| `hybrid-search.test.ts:840-862` | 4 rows                           | green — pool non-empty                                                                                                                                            |
| `hybrid-search.test.ts:865-874` | 4 rows, `ratio: 1`               | green — filter keeps the leader, pool non-empty                                                                                                                   |
| `hybrid-search.test.ts:898-905` | 5 rows, empty **page 2**         | green — pool non-empty; this is the control for D2's pool framing and MUST stay green                                                                             |
| `memory.test.ts:282`            | entity branch                    | green — entity branch never reaches `hybridSearch`                                                                                                                |
| `queries.test.ts:55`            | abstention queries, lexical-only | green — asserted `ids.length > 0`, so pool non-empty                                                                                                              |

`queries.test.ts:59-62` is the one site whose behaviour changes, and it currently asserts only `ids` — so it stays green either way, which is why it needs the added assertion rather than being cited as evidence.

## Risks / Trade-offs

- [Risk] An agent reads `abstained: true` on a filter-empty pool as "this scope has no memories" and stops recalling → Mitigation: the reason string names the query, not the scope's emptiness (`'no candidate matched the query in this scope'`), and the description's replacement tail keeps the instruction to treat it as "nothing relevant found" rather than as a broken search. The state is genuinely "your query plus your filters matched nothing here", which is what an agent should act on.
- [Risk] `gateShortened` teaches agents to page on, raising `limit` and token cost against a corpus the gate already judged irrelevant → Accepted, and shaped against it: the description says a short page is not corpus exhaustion but does NOT suggest raising `limit` in response. The widen affordance survives D5's edit 2 in its shortened form ("need more? Prefer raising `limit`"), which is what pays for 39 of the reclaimed characters — the "if every result looks relevant" qualifier it used to carry is gone, so the affordance is no longer conditioned on the caller judging the page good. The flag is diagnostic; the remedy is the caller's judgement.
- [Trade-off] 26 characters of description headroom after the reword → Accepted because the alternative is cutting entity-branch teaching that `mcp-api/spec.md:1779-1788` spends four paragraphs justifying. The named next reclaim (D5) makes the next edit cheap, and the CI cap fails loudly rather than truncating silently, which is `mcp-api/spec.md:2001`'s stated design.
- [Risk] The headline claim is a regenerated number (18 of 24 shortened at `k=8`), so it can drift with the corpus, the embedder or the ratio and make the proposal read as stale → Mitigation: the task asserts on the distribution via `pnpm run eval`, not on a single query, and records the figure with the commit it was measured at. It is a motivating measurement, not a contract; no spec text depends on it.
- [Risk] Two new optional fields on two tools, and a third surface (`rankedPass`) whose presence is itself meaningful, is more response shape for an agent to misread than one flag would be → Accepted because the alternative — one flag conflating "nothing matched", "gate shortened this" and "you paged past the end" — is the defect being fixed. Each field answers exactly one question and D2's disjointness proof means they never contradict each other.
- [Risk] The change is a report-only change, so nothing about it forces the underlying confabulation risk to be fixed; a future reader may take "the relevance gate now tells the truth" as meaning the garbage query is handled → Mitigation: the proposal's out-of-scope section names the dense distance floor as the actual cure and says why it is not attempted here, and the description's "a full page is not proof of relevance" is the only mitigation this change can honestly claim.

## Migration Plan

None at the data layer. No schema change, no migration, no index, no derived-data invalidation: `memory_fts`, `memory_vec` and the three entity tables are untouched, no row is written or re-scoped, and their regeneration is unchanged.

First boot after upgrade on a populated installation: no work, and identical behaviour for every query whose fused pool is non-empty — on a populated corpus, nearly all of them. Two responses gain additive fields (an empty-pool search gains `abstained: true` + `abstainReason`; a gate-shortened page gains `gateShortened: true`). No error code, result set or ordering changes.

Rollback is a plain image downgrade with no data step. A client that had started reading `gateShortened` simply stops seeing an optional field; the older server's responses validate against the older output schema. No plugin coordination is needed — `grep -rl abstain apps/plugin/` matches zero files, and the four clients read the description from `tools/list` at connect time.

## Open Questions

1. **Should `gateShortened` also be emitted when the gate removed rows but the page is still full?** Decided against for now (D4): it would answer a different question ("was anything filtered anywhere in the pool") and no caller has been shown to need it. Left open because a future retrieval-quality investigation might want exactly that as an observability signal, at which point it should be a second field with its own name rather than a widened meaning for this one.
2. **Does the entity branch deserve an abstention verdict of its own?** An `entity` lookup that matches nothing is a real "found nothing" state, and it currently reports `abstained: false` with `entityIndexDraining` covering only the index-lag ambiguity (`memory.ts:505-512`). Deliberately not decided here: the entity branch is exact-address retrieval with no gate and no relevance level, so "abstention" may be the wrong word for it, and `mcp-api/spec.md:1788` already governs its empty-result contract. Default taken: leave it reporting `false`, and state that in the delta so the silence is a decision rather than an oversight.
3. **Where does the empty-gold abstention query belong?** Adding one to the committed query set would make both the eval guard (D7) and the `abstentionFalsePositiveRate` cap fireable at once, which is a strictly better end state — but it moves committed baselines and belongs with the corpus-expansion work that `ABSTENTION_FLOOR` calibration also waits on. Deferred, with the coupling recorded so the three are done together rather than in three passes.
