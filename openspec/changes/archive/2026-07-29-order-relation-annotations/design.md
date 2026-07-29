## Context

Every memory-returning MCP read projects a memory's judgment edges into a bounded `relations[]` annotation list, through one of two `RelationsService` methods:

| surface                     | call                                               | cap |
| --------------------------- | -------------------------------------------------- | --- |
| `memory.search` result rows | `listForMemories(ids, 10)` (`memory-tools.ts:873`) | 10  |
| `memory.get` batch (`ids`)  | `listForMemories(ids, 10)` (`memory-tools.ts:977`) | 10  |
| `memory.get` single (`id`)  | `listForMemory(id, 50)` (`memory-tools.ts:1047`)   | 50  |

The rows come from `RelationsRepository.listTouchingAny` / `listTouching`, neither of which has an `ORDER BY` or a `LIMIT`, and the cap is applied by taking the first N in arrival order (`appendCapped`, `slice`). Which annotations survive is therefore SQLite's scan order.

The benchmark that scoped this change (numbers in `proposal.md`) found the consequence is live, not theoretical: **23% of search result rows exhaust the cap**, and the graph is **82% `related`** once judged (99% `pending_conflict` before it is drained), so the annotation a memory loses is drawn overwhelmingly from one kind — and the kinds a caller cannot afford to lose (`conflicts_with`, `supersedes`, `superseded_by`) are 4% of the population. The same benchmark falsified the widening this change originally proposed, and that rejection is recorded here as D5 so it is not re-proposed without new evidence.

Constraints: all SQL stays under `db/`; the POV-dependent `superseded_by` derivation and the `RelationKind` enum live in the service layer; the MCP tool input schema must not change (four clients ship against it); the annotation cap is part of a published requirement and is not the defect.

## Goals / Non-Goals

**Goals:**

- A load-bearing edge (`conflicts_with`, `supersedes`, `superseded_by`) SHALL never be evicted from an annotation list by informational edges or by pending candidates.
- Two identical reads SHALL return the same annotations in the same order, on unchanged data.
- A caller SHALL be able to tell HOW MUCH was withheld, not merely that something was, and SHALL have a parameter to ask for it.
- Every annotation surface SHALL agree, so `memory.search` and `memory.get` cannot describe the same memory's relations differently.
- Default response payloads SHALL be byte-identical: a caller that passes nothing new gets exactly today's number of annotations.

**Non-Goals:**

- Widening `include_relations`, flipping its default, or changing its cap — measured and rejected (D5).
- Any eval-harness change: no metric, query type, corpus fixture, or baseline (D6).
- Raising the DEFAULT annotation bound for everyone (D2) — the maximum a caller may request is a separate mechanism and is in scope (D7).
- Paging annotations (`relations_offset`) — a third mechanism for a list bounded at 50 (D7).
- Converging `entitiesTruncated` on the same total-count idiom — the same defect, a different capability; follow-up (D4).
- Repairing `fields`-not-applied-to-`expanded`, or the two entity-extraction defects. Follow-ups.
- Multi-hop traversal, GraphRAG, entity co-occurrence graphs.

## Decisions

### D1. A total order in three tiers, with `pending_conflict` between them

The comparator, applied before the cap:

1. **Tier**, ascending: `conflicts_with` (0) > `supersedes` (1) > `superseded_by` (2) — load-bearing; `pending_conflict` (3); `scoped` (4) > `compatible` (5) > `related` (6) — informational.
2. **`created_at` descending** — the most recent judgment about a memory is the one most likely to reflect its current standing.
3. **`judgment_id`** — `memory_relations_judgment_id_unique` makes this key never tie, so the order is _total_, not merely stable. This matters concretely: a `memory.judge` batch closed inside one transaction shares a `created_at` millisecond, and a comparator that stopped at key 2 would leave those rows in scan order — the defect, surviving inside its own fix.

Tier order within the load-bearing group: a contradiction demands an action from the reader, a lifecycle edge tells them the row they are holding is not current, and `superseded_by` trails `supersedes` because it only ever attaches to a non-active row (see `proposal.md`), so it is the rarest thing a default search can surface.

**`pending_conflict` placement.** It sits below the judged load-bearing tier because the benchmark measured it at **1154 of 1164** annotations on an undrained corpus: ranked first it would evict every judged edge on any instance with a backlog, which is this bug again with a different dominant kind. It sits above the informational tier because a pending candidate carries a required action — the fresh-context-judgment invariant has the agent that produced the conflict close it — and because the pending queue's depth is separately surfaced by `memory.stats` / `memory.context.pendingJudgments[]` (`surface-pending-judgment-inventory`), so the annotation list is a reminder rather than the queue of record.

_Alternatives._ **`pending_conflict` first** — rejected on the 1154/1164 measurement. **`pending_conflict` last** — a pending conflict would then be evicted by `related` tags, which inverts the decision value and would let a backlog become invisible on exactly the memories that have one. **Alphabetical or `created_at` only** — deterministic, and would still drop a `conflicts_with` in 23% of rows; determinism alone is not the goal.

### D2. Do not raise the fixed constant; let the caller ask instead

Two mechanisms hide behind "raise the cap", and they deserve opposite answers.

**Raising the constant is rejected.** A larger default makes truncation rarer without making it honest — the measured pending flood settles it, since a memory with 40 pending candidates truncates at any default a response can afford and the survivors are still an arbitrary sample. And the cost falls on every row of every response whether the caller wanted the annotations or not, on the one axis `retrieval-evaluation` explicitly records CI does not protect.

**Letting the caller ask is accepted**, and is D7. The ordering makes the bound a _policy_ ("the N most decision-relevant"); `relationsTotal` (D4) makes the bound's effect visible; the parameter makes it answerable. Any two of those three leave the feature half-built: a policy nobody can see, a signal nobody can act on, or a knob with no way to know whether to turn it.

_Alternatives._ **Default 10 → 25/50 for everyone** — cost on every row, defect unfixed. **Unbounded** — a response-size cliff on the busiest memories, and `reason` is 2000 chars, so the cliff is real. **A per-kind reservation (always keep every `conflicts_with`, cap the rest)** — a second policy on top of a global bound, and the measured 82% skew is already handled by tiering; kept as Open question 1 in case a row's load-bearing edges alone are ever seen to exceed the bound.

### D3. The comparator lives in `RelationsService`, not in SQL

`listTouchingAny` already returns every touching row unbounded, so no `ORDER BY` and no repository change is needed. Sorting in the service also keeps the tier list beside the two things it depends on: the `RelationKind` enum and the POV-dependent `supersedes` → `superseded_by` derivation, which does not exist in a table column and therefore cannot be expressed in an `ORDER BY` without duplicating the derivation in SQL.

One exported comparator is applied in both `listForMemories` and `listForMemory`, so the three surfaces cannot drift. The unbounded fetch itself is a pre-existing hot-path concern owned by the active `tune-hot-query-paths` change, untouched here.

### D4. The truncation signal is `relationsTotal` — a true count, not a boolean

Every row carrying `relations` also carries `relationsTotal`: the number of annotations that exist for that memory after the `not_conflict` and `orphaned` exclusions and **before** the bound. Present whether or not anything was cut, so a caller never has to distinguish "complete" from "field omitted".

**Why a count and not a flag.** A boolean tells the reader information is missing and gives it nothing to decide with — an agent that learns "there is more" without learning "how much more" has no basis for spending a second call, so it will keep the default. A total is actionable: 11 versus 10 is noise, 40 versus 10 is worth a follow-up ask. And the boolean is derivable (`relationsTotal > relations.length`), so shipping both is duplicated state.

**Why it costs nothing.** `listTouchingAny` and `listTouching` have no `LIMIT`; the cap is applied afterwards in the service. The complete per-memory count is therefore already in hand at the moment of truncation — the same fact that keeps the comparator out of SQL (D3). Zero extra queries, no repository change.

**Which of the repo's two idioms to follow.** `pendingJudgmentsTotal` (`surface-pending-judgment-inventory`, published at `mcp-api/spec.md:483-503`) is a true scoped total, explicitly "never the returned list's length, which is the page size and therefore exactly the misleading number the field exists to correct", with no companion boolean. That is the one. `predecessorCount` (`memory/spec.md:950`) is the counter-example: its scenario says it "SHALL report the bound that was applied", i.e. the number returned, which the array length already states — a count that carries no information the caller did not have.

**The divergence from `entitiesTruncated`** — the in-file precedent cited in the previous draft of this design — is deliberate: a redundant boolean beside a free total is exactly the duplicated state a cleanup pass removes. And the entity flag has the same defect, because `findEntitiesForMemories` also has no `LIMIT` and `ents.slice(0, ENTITIES_PROJECTION_CAP)` caps in TypeScript, so its total is equally free. The two idioms should converge on `entitiesTotal` — scoped as a **follow-up**, not into this change: it touches the `memory-entities` capability and three more call sites for no additional correctness on the defect at hand.

### D7. `relations_limit`: default per surface, one maximum of 50, over-ask rejected

The parameter is shaped exactly like the `limit` it sits beside on `memory.search`, and is added to `memory.get` too (both forms), so no annotation surface can disagree.

**Maximum 50, shared by all three surfaces.** It is the highest annotation bound already shipping — single-id `memory.get` uses 50 today — so the ceiling introduces no payload regime the server does not already serve. The arithmetic is checkable rather than asserted: a `RelationView` is `kind` + a 26-char target id + `status` + optional `confidence` + `reason`, and `reason` is zod-capped at 2000 chars (`relations-tools.ts:48`), so 50 views bound a row's annotations at roughly 100 KB worst case — the same order as the row's own `content`, and reachable only when the caller asks. A maximum of 200 (matching `limit`) would instead let annotations dominate a response by an order of magnitude over the memories they annotate.

**Defaults stay per surface: 10 for `memory.search` rows and batch `memory.get`, 50 for single-id `memory.get`.** Only the maximum unifies. Lowering single-id `get` to 10 would be a silent regression on the deliberate deep-read surface; raising search to 50 would spend tokens on every response to fix a problem the total plus the parameter already solve for the callers who have it. So the change ships with byte-identical default payloads.

**Over-ask is rejected, not clamped** — `z.number().int().min(1).max(50)`, so a 51 returns `-32602`. Two reasons. It is what every other numeric bound on this surface does (`limit` is `.max(200)`), and a parameter that silently disagreed with its own declared maximum would be the only one. And the alternative failure is already on record: `surface-pending-judgment-inventory` documented `judgments: pendingJudgmentsTotal` in a tool description, which rejected for exactly the queues worth draining; the fix was to document `min(total, MAX)`. So the lesson is not "clamp" — it is "the description must not teach an ask the schema rejects".

**Therefore the description carries the recipe.** `relations_limit`'s `.describe()` must state the default, that `relationsTotal` says how many exist, that the follow-up ask is `min(relationsTotal, 50)`, and that a larger value is rejected rather than clamped. That sentence is the whole mitigation, and it is a spec scenario rather than a code comment.

_Alternatives._ **Clamp silently** — the caller cannot tell it was clamped except by comparing against `relationsTotal`, which is the boolean's problem in a new place. **One parameter per surface (`search_relations_limit` …)** — three names for one bound. **No parameter, total only** — half a feature (D2). **A `relations_offset` to page annotations** — a third mechanism for a list bounded at 50; the caller that needs all of them asks once.

### D5. The widening is rejected, and the numbers are recorded so it stays rejected

Recorded here because a future reader will have the same idea for the same plausible reason. Measured over the eval corpus with a production-shaped drained graph: 3 kinds → 32 expansion rows, 15/24 queries, **+11.5%** payload; 6 kinds → 108 rows, **24/24** queries, **+62.4%**. At 4.5 candidates per query against a cap of 5 the appendix saturates on every query, so the mechanism degenerates from "co-surface the relevant neighbour" into a fixed five-row tax. Recall@8 is already 1.000 against a ceiling of 1, so there is no retrieval win to trade tokens for.

A fair-share-across-kinds allocation (the original D1 of this change, modelled on `services/entities.ts::admit`) does **not** rescue it: fair share decides which kinds occupy the slots, and the problem is that every query now fills all of them.

### D6. No eval-harness change

`ingestCorpus` produces `{pending: 145, judged: 2}`; annotations across all 24 top-8 pages are 1154 `pending_conflict` + 10 `supersedes`. `related` requires an agent to call `memory.judge`, which the harness never does, so an A/B of the widened kind set over the shipped corpus moves nothing (delta exactly 0) — a `coverageAtK` metric and a `relation-hop` query type would have instrumented a guaranteed no-op. Nor can the harness see _this_ fix: retrievers return ids, and the annotation list is not scored at any k. `pnpm run eval` therefore runs as a non-regression check only, and its result is not evidence for this change.

## Risks / Trade-offs

- [Risk] An operator comparing a search response before and after upgrade sees a different set of 10 annotations and reads it as data loss. → It is a read projection over unchanged rows; the excess has always been visible in full on `/dashboard/judgments`; the new 10 are a superset in decision value; and `relationsTotal` now states exactly how many exist. Called out in the proposal's existing-installations paragraph.
- [Risk] On an instance with a large judgment backlog, annotation lists become mostly `pending_conflict` rows. → By construction a pending flood cannot evict the load-bearing tier, and the pendings are actionable rather than noise. Draining the queue (`memory.judge`) restores the informational rows, and the queue depth is already reported by `memory.stats`.
- [Risk] `created_at` ties inside a batch-judged transaction would leave the order to scan order — the defect surviving inside its own fix. → The `judgment_id` key is unique-indexed, so the comparator is total. A test asserts identical order across two reads on a same-millisecond batch.
- [Risk] An existing test may assert today's arbitrary order and pass only by accident of scan order. → The mutation check in tasks 4.5–4.6 runs the full suite with the comparator removed and with it restored, so an accidental dependency shows up as a failure rather than as flake later.
- [Risk] An agent reads `relationsTotal: 300` and asks for all of them, getting a rejection instead of data. → The maximum is 50 and the description states the ask as `min(relationsTotal, 50)` with rejection called out explicitly; task 3.3 makes the description a deliverable and task 3.4 tests the rejection. This is the one recorded failure mode of this exact shape in the repo (`surface-pending-judgment-inventory`), so it is guarded rather than assumed.
- [Risk] A caller sets `relations_limit: 50` on `limit: 200`, so annotations dominate the response. → The bound is caller-chosen and arithmetically stated (50 views × a 2000-char `reason` cap ≈ 100 KB per row worst case); the maximum is 50 rather than 200 precisely to keep that product within the same order as the memory content it annotates. No latency claim is made — the rows are already fetched, so the cost is payload, not queries.
- [Trade-off] Informational edges are evicted first, so a memory with many `related` tags surfaces fewer of them than it does today. → Accepted: at 82% of the graph they are the population the bound exists to bound, they carry no required action, and the full set stays available on the dashboard and now via `relations_limit`.
- [Trade-off] The response gains one optional number on every memory-returning read, present even when nothing was cut. → Accepted at roughly 20 bytes per row: a field that appeared only on truncated rows would be the boolean again, and the caller would have to know the default to interpret its absence.

## Migration Plan

No migration, no schema change, no derived-index invalidation, no `EXTRACTOR_VERSION` bump. Deploy is a plain image upgrade; the first boot after it reads the same `memory_relations` rows and projects them in the new order, with unchanged default counts. Rollback is a plain image downgrade: the older code reads the same rows, returns an arbitrary 10 again, drops `relationsTotal`, and ignores an unknown `relations_limit` — a client that had started sending it degrades to the old default rather than erroring, since zod strips unknown keys rather than rejecting them (task 5.7 confirms no plugin sends it in the first place). No client change is required: both additions are optional and additive.

## Open Questions

1. **Should load-bearing kinds get a reserved sub-quota rather than only a higher tier?** Tiering guarantees they lead; it does not guarantee that eleven `conflicts_with` edges all fit under the bound. _Default: no reservation_ — they are 4% of the measured population, and a second policy on top of a caller-controlled bound needs its own evidence. Revisit if a row is ever observed whose load-bearing edges alone exceed the bound.
2. **Should the per-surface defaults converge (10 / 10 / 50 → one number)?** _Default: keep them_, so this change ships byte-identical default payloads (D7). `relationsTotal` is the instrument that will answer it: once it is in the field, how often each surface truncates is observable rather than argued.
3. **Should `entitiesTotal` replace `entitiesTruncated` on the same terms?** The entity total is equally free (`findEntitiesForMemories` has no `LIMIT`). _Default: yes, but not here_ — it is the `memory-entities` capability and three more call sites, with no bearing on the annotation defect. Task 7.3 files it.
