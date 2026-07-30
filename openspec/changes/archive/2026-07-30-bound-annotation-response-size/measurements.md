# Measurements

Measured through the real annotation projection (`RelationsService.listForMemories`, the exact call
`memory.search` and batch `memory.get` make) against a purpose-built pathological corpus. Both
copies `mcp/result.ts::ok()` emits are counted — a one-copy figure understates the transported size
by roughly half.

The fixture is a test, not a script (`apps/server/src/mcp/annotation-payload.measure.test.ts`), so it
stays re-runnable and reviewed.

## The corpus (task 1.1)

200 active memories in one scope, each carrying 50 judged `related` annotations whose stored `reason`
is **exactly 2 000 characters** — the `memory.judge` / `memory.compare` schema cap, so `reason` sits
at its legal maximum. 10 000 annotations in the page, 10 200 memories in the scope. Memory `content`
lengths cycle `[420, 855, 1400, 2530, 4100]` characters, the distribution a `memory.session_summary`
produces, so the row scaffolding is not understated by minimal fixtures.

**Deviation from the task, recorded.** Task 1.1 asked for a row mixing `pending` and `judged`
annotations. That cannot be built with `compare`: `pending_conflict` is a derived annotation KIND
produced by save-time detection, not a relation a caller can record. The pending shape is measured
separately, per annotation, in the third measurement below.

## The worst legal request today: `limit: 200` × `relations_limit: 50` (tasks 1.2, 1.3)

| figure                               | measured                                | proposal's hypothesis |
| ------------------------------------ | --------------------------------------- | --------------------- |
| annotations projected                | **10 000**                              | 200 × 50              |
| verbatim `reason`, pretty / compact  | **20.44 MB / 20.09 MB**                 | ~20 MB                |
| verbatim `reason`, **transported**   | **40.53 MB**                            | ~40 MB                |
| per judged annotation, pretty        | **2.1 KB**                              | ~2.1 KB               |
| `reason` removed — scaffolding alone | **1.38 MB** pretty, 2.42 MB transported | ~1.3 MB               |
| `reason` bounded at 350              | 4.70 MB pretty, 9.06 MB transported     | —                     |

**The hypothesis is confirmed on all four figures it named.** The constants therefore follow the
proposal rather than being revised, and `design.md` needs no amendment on this point.

Per-annotation cost by shape, which is what makes the scaffolding figure legible:

| shape                                  | pretty chars |
| -------------------------------------- | ------------ |
| judged, verbatim 2 000-char `reason`   | **2 127**    |
| judged, `reason` removed               | **129**      |
| pending (no `reason`, no `confidence`) | **90**       |

So `reason` is 94% of a judged annotation, and the residual 129 characters × 10 000 is the 1.38 MB
that survives removing it entirely — the proposal's "both terms have to be addressed" claim, measured.

## The post-change worst case, and the decision it forces (task 1.4)

The aggregate budget is pinned to shipped behaviour — 200 rows (the `limit` maximum) × 10 (the
multi-row annotation default) = **2 000 annotations** — so it is not the knob that moves (design D3).
That size is also, exactly, what the server already serves when a caller passes `limit: 200` and no
`relations_limit`. Measured at that size:

| `reason` bound         | pretty      | transported | ≈ tokens |
| ---------------------- | ----------- | ----------- | -------- |
| verbatim (shipped)     | **4.09 MB** | **8.11 MB** | ~2 000 k |
| 2 000 (the schema cap) | 4.09 MB     | 8.11 MB     | ~2 000 k |
| 700                    | 1.61 MB     | 3.15 MB     | ~790 k   |
| **350 (chosen)**       | **0.94 MB** | **1.81 MB** | ~450 k   |
| 200                    | 0.65 MB     | 1.24 MB     | ~310 k   |
| 100                    | 0.46 MB     | 0.86 MB     | ~215 k   |
| 0 (scaffolding floor)  | 0.27 MB     | **0.48 MB** | ~120 k   |

**Decision: `ANNOTATION_REASON_CHARS = 350`**, the value `CONTEXT_SNIPPET_CHARS` already ships for
every other multi-item text projection, so no new number is invented. It takes the worst legal
request from **40.53 MB to 1.81 MB transported — a 22× reduction** — and the default request from
8.11 MB to 1.81 MB.

**And a finding the task's framing did not anticipate, stated rather than smoothed over.** Task 1.4
says that if 350 leaves the worst case above what a conservative agent context window can hold, a
smaller value should be landed. 350 does leave it above: 1.81 MB is roughly 450 k tokens, over a
200 k-token window. But **no value of this constant gets under that window**, because the scaffolding
floor at the budget is 0.48 MB (~120 k tokens) with `reason` removed _entirely_, and 100 characters
of reason already costs 0.86 MB. Choosing 200 or 100 would trade real diagnostic text for a worst
case that is still over the line.

So the reason bound is not the lever that closes the remaining gap, and pretending otherwise by
picking a smaller number would be a false resolution. The residual is scaffolding-dominated and its
lever is the BUDGET, which design D3 deliberately pins to shipped behaviour so this change introduces
no payload regime that is not already shipping. Lowering the budget below what the server already
serves is a separate, breaking decision with its own evidence to gather — named as a follow-up, with
these figures as its seed, rather than smuggled in here.

What this change therefore does and does not claim: it removes a 5× regression and a 22× worst case,
and it makes the remaining ceiling a named, CI-asserted number instead of an unexamined one. It does
**not** claim the worst case fits a conservative context window.

## RESOLVED: the budget was bypassed on the entity branch, and how it was fixed

Found by review, verified in code, fixed. Recorded in full because the fix changed this change's
central number.

**The defect.** The budget's row term was the DECLARED `limit`, but `services/memory.ts` sets the
entity branch's page size to `RANK_WINDOW_CEILING = 400` when the caller names no `limit` (that
branch is specified as complete within scope):

```ts
const entityLimit = input.limit === undefined ? RANK_WINDOW_CEILING : limit;
```

So the check computed `8 x 50 = 400`, admitted, and the server served `400 x 50`:

| request                                 | rows | annotations | transported  |
| --------------------------------------- | ---- | ----------- | ------------ |
| `search({entity, relations_limit: 50})` | 400  | **20 000**  | **19.75 MB** |
| `search({entity})` — pure defaults      | 400  | **4 000**   | 4.64 MB      |

Twice the 10 000 annotations the proposal names as the regression, after the change. And the delta's
derivation was false: the true default worst case is `400 x 10 = 4 000`, not `200 x 10 = 2 000`.

**The fix, two halves.** The budget is re-derived from the largest row count ANY branch serves for an
omitted `limit` — `RANK_WINDOW_CEILING x MULTI_ROW_ANNOTATION_DEFAULT = 4 000` — and the check is
applied to the EFFECTIVE row count rather than the declared one. This corrects D3's arithmetic
without reopening its principle: the budget is still pinned to shipped behaviour, computed correctly.
Both delta specs now state both halves, since the first version asserted the false derivation.

Verified live at the handler, all five cases:

| request                             | before fix | after fix    |
| ----------------------------------- | ---------- | ------------ |
| `{entity, relations_limit: 50}`     | served     | **REJECTED** |
| `{entity}`                          | served     | served       |
| `{limit: 200, relations_limit: 50}` | REJECTED   | REJECTED     |
| `{limit: 200}`                      | served     | served       |
| `{limit: 80, relations_limit: 50}`  | REJECTED   | served       |

The last row is the widened trade the doubled budget buys; the second is the constraint that forced
the budget up rather than the row count down.

**What it costs.** The post-change worst case doubles, from 2 000 to 4 000 annotations. Re-measured
at the new budget with `reason` bounded: **3 792 003 bytes** of annotation projection, so the
reduction from the true pre-change worst case (19.75 MB on the entity branch, 40.53 MB at
`limit: 200 x 50`) is **5.2x / 10.7x** rather than the 22x claimed before the bypass was known.

**The ceiling was re-derived too, and its basis corrected.** It now bounds the ANNOTATION projection
alone rather than the whole `CallToolResult`. The first version measured the result, which includes
`content` — deliberately unbounded by this change (design D8) — so the number was an artifact of the
guard fixture's 600-char bodies: a legal `search({limit: 200})` over 10 000-char memories transported
6.17 MB against a 3 MB ceiling. `ANNOTATION_PAYLOAD_CEILING_BYTES = 4_000_000` is now set from the
3 792 003 measurement and re-verified to bite: raising `ANNOTATION_REASON_CHARS` 350 -> 700 fails it
at 6 592 003, and raising `MULTI_ROW_ANNOTATION_DEFAULT` 10 -> 20 fails it at 7 584 003.

**The transferable lesson.** A budget that validates DECLARED parameters bounds nothing on a branch
that substitutes its own value for one of them. Before bounding `rows x anything`, find every place
the service decides the real row count — here `RANK_WINDOW_CEILING` doubling as a page size, which
the very requirement this delta re-publishes mentions in a sentence.

Everything above the STOP note is reproducible and was independently re-verified figure by figure.
