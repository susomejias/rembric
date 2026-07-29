## Context

`memory.save` runs three detection channels, merges and ranks them, and returns the top `CANDIDATES_PER_SAVE_MAX` (default 5) as `candidates[]`. Everything below the cut gets no `memory_relations` row, so it carries no `judgmentId` — and every recovery surface in the system is keyed on a `judgmentId`.

| surface                             | keyed on                | can it reach a dropped pair? |
| ----------------------------------- | ----------------------- | ---------------------------- |
| `memory.judge`                      | `judgmentId`            | no                           |
| `memory.context.pendingJudgments[]` | pending rows            | no — no row exists           |
| consolidation orphan sweep          | pending rows            | no — no row exists           |
| `/dashboard/judgments`              | `memory_relations` rows | no, **by construction**      |
| `memory.compare`                    | both memory ids         | only if the pair is known    |
| `memory.search` (re-derivation)     | content                 | **yes**                      |

**Evidence provenance.** Every quantitative claim below is labelled, following the idiom of `record-graph-retrieval-rejection/design.md`.

| label          | meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `[measured]`   | Produced by running the shipped code over the eval corpus, numbers recorded |
| `[verified]`   | Read directly out of the source at a cited line                             |
| `[unmeasured]` | Believed on structural grounds; no number exists                            |

`[measured]` — eval corpus, real embedder, calling the shipped `findSaveTimeCandidates`, 38 active rows after ingest:

```
candidates found per memory:              427 total, mean 11.2, p50 10, p90 15, max 15
memories exceeding the default cap of 5:  38/38  (100%)
captured by the top-5:                    190/427 (44%)  →  56% dropped
highest candidate similarity anywhere:    0.850
```

Measured post-hoc with the whole corpus present, so it is the **steady-state / re-derivation** distribution rather than the count each save faced at its own moment (memory #1 had no predecessors). It models production, which holds 99 active memories, and it is not presented as a save-time measurement anywhere in this change.

`[verified]` constraints:

- `poolSize` defaults to 20 inline at `save-time-candidates.ts:92` and **no call site sets it** — 20 is the only value that has ever run. It bounds each channel before ranking: `LIMIT poolSize` on vec kNN (`:110`), on the FTS5 query (`:139`), and **per extracted entity** on the entity channel (`:190`).
- The cap is `all.slice(0, opts.perSaveMax)` at `:232`; `all` is the deduped, ranked array, already fully in memory.
- `CANDIDATES_PER_SAVE_MAX` is `z.coerce.number().int().min(0).max(25).default(5)` (`config.ts:132-137`); detection is skipped entirely when it is 0 (`memory-tools.ts:659`).
- `SAVE_DESCRIPTION` measures 1172 characters against `DESCRIPTION_MAX_LENGTH = 1900` (`mcp/server.ts:124`).
- `memory.judge` batches to 25 (`relations-tools.ts:62`); `memory.compare` has no array form.

Constraints on any solution: all SQL stays under `db/`; `memory.save` is a hot path on the single synchronous SQLite connection shared with `/mcp`, `/api`, the dashboard and `/healthz`; the MCP **input** schemas must not change (four clients ship against them); and the attention budget the cap defends is not the defect.

## Goals / Non-Goals

**Goals:**

- A caller of `memory.save` SHALL be able to tell five-of-five from five-of-fifteen.
- The reported number SHALL be honest about what it counts, in its name and in the tool description, so no reader can mistake a pool-bounded count for a scope-wide total.
- The number SHALL be actionable using mechanisms that already exist, with the action written where an agent reads it.
- Adding it SHALL cost zero additional queries and zero additional rows.
- A dropped candidate SHALL be documented as recoverable, with the limits of that recovery stated rather than implied.

**Non-Goals:**

- Recording the tail as pending rows (D2), or raising `perSaveMax` / `poolSize` defaults.
- Any slot-efficiency filter — proposed, measured, rejected (D5).
- A new MCP tool or a new read for re-derivation (D4).
- A calibrated threshold of any kind: no near-duplicate gate, no `suggestTopicKey` flag (D5, D6).
- Changing the ranking precedence, widening `include_relations`, GraphRAG (all published rejections).
- Batching `memory.compare`, or either modelling hole in Open questions 2–3.

## Decisions

### D1. The field is `candidatesDetected` — a pool-bounded lower bound, not a total

Definition: the number of distinct candidate pairs detection produced and ranked, **before** `CANDIDATES_PER_SAVE_MAX` was applied — `all.length` at `save-time-candidates.ts:232`. Present on every save response whether or not anything was cut.

**Why a count and not a flag.** A boolean tells a reader information is missing and gives it nothing to decide with, so it will keep the default. `candidatesDetected: 6` beside five candidates is noise; `15` beside five is a fragmented topic worth a `topic_key`. And the boolean is derivable (`candidatesDetected > candidates.length`), so shipping both is duplicated state. This is the sibling change's D4 argument applied to a different surface, and it is why no companion boolean is added.

**Why the name avoids `*Total`.** `pendingJudgmentsTotal` and `relationsTotal` are true scoped counts; they earn the suffix, and `pendingJudgmentsTotal`'s published requirement goes out of its way to say it is "never the returned list's length, which is the page size and therefore exactly the misleading number the field exists to correct" (`mcp-api/spec.md:494`). This number cannot make that promise — the pool bound is upstream of the count — so naming it `candidatesTotal` would teach an agent that a `*Total` in this API may silently under-report, which is a worse outcome than an unfamiliar suffix. `predecessorCount` (`memory/spec.md:950,957`) is the other pole: it reports the bound that was applied, i.e. the array length restated, which carries no information the caller did not already have. `candidatesDetected` sits deliberately between them: strictly more than the array length, strictly not a total, and named for exactly what it counts.

**Why pool-bounded is sufficient rather than merely affordable.** `[measured]` p90 and max were both 15 against a `poolSize` of 20, so a pool-bounded count would have been exact on 38/38 rows of that corpus. That is an argument for the cheap option — and also a warning, stated in the spec: the corpus is 38 rows, smaller than the pool, so exactness is a property of corpus size, not of the field. At 99 active rows and beyond, the bound begins to bind. The field's job survives that transition because its job is triage ("is this topic fragmented?"), not inventory ("enumerate the 23 I did not see"). A number that is exact when small and a floor when large is adequate for triage and would be inadequate for inventory — and nothing in this change asks it to be an inventory.

_Alternatives._ **A genuine cross-channel COUNT** — rejected in D3. **A boolean** — above. **`candidatesTotal`** — above. **Also report `poolSize` so the caller can detect saturation** — rejected: the count can exceed 20 (the entity channel loops the bound per entity), so `N == poolSize` is not a reliable saturation signal, and a second number to interpret the first is worse than one number with an honest description.

### D2. The tail gets zero rows, because similarity is derived data and a verdict is not

`record-graph-retrieval-rejection` publishes the test: a derived table's contents are determined by exactly two inputs — the current rows of the source tables and a recipe pinned in the shipped image behind a version marker (`design.md:45`) — and "derived iff dropping it loses no information" (`D4`). A candidate pair's every field is derived: the two ids and the similarity are a function of immutable `memory.content` / `memory.title` (never `UPDATE`d, append-only invariant) under recipes pinned by `EXTRACTOR_VERSION`, FTS5, and `EMBEDDING_MODEL_ID` / `_REVISION` / `_DTYPE` / `_DIMS` / `EMBEDDING_INPUT_VERSION`. An agent's **verdict** is source data by the same test: nothing recomputes it, which is why it earns a row.

So dropping candidate #6 loses no source data. It loses a prompt, and the prompt regenerates because its input is immutable.

**The delta spec does not depend on that sibling landing.** `record-graph-retrieval-rejection` is still an active change, so its generalised derived-data requirement is not yet published in `persistence`. The `memory` delta therefore states the derived/source test inline and anchors it on requirements that ARE published — "Memories MUST be append-only", the two embedding-identity requirements, and `persistence`'s existing per-table derived declarations (`memory_fts`, `memory_vec`, `memory_replaces`, the entity tables). Do not reintroduce a citation of the unlanded requirement into the spec; archive order between the two changes must not matter.

**Recording the tail is rejected on measured cost.** `[measured]` mean 11.2 candidates per save means recording the pool would roughly double every save's pending output. `[verified]` this instance's queue reached 52 with the un-aged pairs unreachable from every MCP surface (`archive/2026-07-28-surface-pending-judgment-inventory`). And `[measured]` by the sibling change, a deep pending queue is not inert downstream: annotations across 24 top-8 pages on an undrained corpus were **1154 `pending_conflict` + 10 `supersedes`**, so widening recording feeds the annotation flood that `order-relation-annotations` had to tier around.

**Two caveats, in the spec rather than only here.**

1. Re-derivation does not recover **fresh context**. The agent that wrote the memory knows things a later one does not, and that is the whole rationale for the save-time channel. The tail therefore loses judgment _quality_. Mitigation is structural rather than hopeful: the five retained are the five the published precedence ranks highest (entity-sourced first, then the reported similarity — `memory-entities/spec.md:354`), so the loss is the low end of a stated ordering.
2. Re-derivation returns the **current** set, not the save-time set: rows that did not exist then are included, superseded and archived rows are not, and an `EMBEDDING_INPUT_VERSION` bump changes the vectors — `record-graph-retrieval-rejection` is explicit that the guarantee is re-derivability, not bit-exactness (`design.md:65`). This is treated as a **feature**: the question a later agent asks is "what does this conflict with _now_", and a faithful replay of a pool computed against a smaller corpus answers a question nobody has. Consequently the spec claims re-derivability and never reproducibility.

_Alternatives._ **Record the pool, surface the top 5** — rejected above; it is the reason this change exists in its current shape rather than as a recording split. **Record the tail with a distinct status (`deferred`) excluded from the queue** — rejected: a fourth status on the relation FSM plus a second sweep, to store data that is already derivable, and every read that touches `memory_relations` would need to learn the new status. **A journal line per dropped pair** — rejected: journals are source data by D2's own test, so writing derived data into one inverts the distinction, and `consolidation_ops` is for reversible operations, not for observations.

### D3. A true count is undefined for one channel and unaffordable for another

Not merely expensive — this matters, because "expensive" invites "measure it and see".

- **Lexical: undefined.** `memory/spec.md:1017` contracts that admission "SHALL instead be by rank position within the already-correctly-ordered candidate pool", because bm25 has no stable corpus-independent floor (`fix-retrieval-ranking-math`). The pool bound _is_ the admission rule, so "how many FTS candidates exist" has no answer that does not first redefine admission.
- **Dense: unaffordable on this path.** sqlite-vec brute-forces the partition and requires a `k`; `tune-hot-query-paths` design.md Q4 records `knnByQueryVector` at ~42 ms at 50k with `k` not the lever and cost linear in partition size. `memory.save` runs on the single synchronous connection shared with every MCP client, the HTTP API, the dashboard and `/healthz`.
- **Entity: cheap but useless alone.** `entityLinkCount` already runs per extracted entity, so a per-entity total is in hand — but summing the three channels over-counts, because the merge dedupes by target id (`:211-222`), and there is no cheap way to size a union of three bounded sets without materialising them.

_Alternatives._ **Count only the lexical channel and label it** — rejected: a number whose channel coverage varies by save is less interpretable than a floor over all three. **A cached/approximate scope-wide "related" count** — rejected: it is a new derived quantity with its own staleness and its own invalidation, to answer a triage question a floor already answers.

### D4. No new tool: `memory.search` is the re-derivation surface, and it was checked first

The re-derivation path exists in full today. `memory.search({query})` over the memory's own text drives the lexical and dense channels, and the agent holds that text because it just wrote it. `memory.search({entity})` (`mcp-api/spec.md:1596`) drives the entity channel. Recording a verdict on a re-derived pair is `memory.compare`.

A "re-run candidate detection for memory M" read was considered and rejected: it costs a full tool description against a budget this repo deliberately cut 17.1 KB from (`guard-tool-description-truncation`), and `surface-pending-judgment-inventory` already rejected a new tool on that exact ground, preferring a parameter clause. The gap it would close is small and is stated in the spec instead of hidden: search is RRF-fused, so the re-derived set is _similar but not identical_ to the detector's three-channel merge, and it returns ranked memories rather than pairs carrying `judgmentId`s.

_Alternatives._ **`memory.candidates({id})`** — above. **Fold re-derivation into `memory.get` as an option** — rejected: `memory.get` is a lookup, and an option that triggers three retrieval queries changes its cost profile invisibly. **Say nothing and let agents work it out** — rejected: an unstated recovery path is indistinguishable from no recovery path, which is the defect this change is closing.

### D5. Slot efficiency: proposed, measured, rejected — recorded so it is not re-proposed

Three skips were considered on the theory that some of the five slots are spent on already-answered questions. All three are dead.

1. **Skip candidates sharing the saved row's `topic_key`** — **structurally impossible.** A `topic_key` upsert supersedes the previously-active row in that slot, and the lexical and dense channels filter `status = 'active'` (`[verified]` `memory-repository.ts:138`, `:380`; `vectors-repository.ts:66`). A same-key row cannot be active, so it never reaches the pool. `[measured]` 0 of 190 surfaced slots — but only 2 of 38 rows carried a `topic_key`, so the measurement is weak and the **logic** is what decides it.
2. **Skip candidates already in `replaces[]`** — **structurally impossible for the same reason.** `replaces[]` entries arrive from `topic_key` upserts and from judged `supersedes` verdicts, both of which set the target to `superseded`. `[measured]` 0 of 190, with only 2 of 38 rows carrying a non-empty `replaces[]`.
3. **Skip near-duplicates above a similarity threshold** — **the measurement was vacuous, so nothing is spec'd.** `[measured]` the highest candidate similarity anywhere on the corpus was **0.850**, so a 0.95 threshold was unreachable and its 0% is "untested", not "disproven". A requirement written on that evidence would be a guess. Two further reasons stand independently: `memory/spec.md:1125-1134` requires any gate to ship disabled until a committed harness sweep proves a plateau at least two grid steps wide, and auto-judging a duplicate as `supersedes` would have the server invent a verdict, which the fresh-context-judgment invariant reserves for an agent.

The claim "the same five slots could carry five informative pairs instead of five of which two were already answered" is therefore **false on this corpus and impossible in principle on two of its three axes.** It is not made anywhere in this change. `listNotConflictTargetsForSources` remains the only suppression that fires, and it is already implemented.

Two adjacent findings surfaced while checking the above and are filed rather than fixed — see Open questions 4 and 5. Both are verified divergences from published requirements with `[unmeasured]` impact, and both would be slot-efficiency changes, which is the theme this decision closes.

### D6. The `topic_key` nudge lives in the tool description, not in the response

`[measured]` mean 11.2 candidates per save. A save with fifteen candidates almost certainly wants one converged topic rather than fifteen edges, and `memory.suggest_topic_key` already exists to produce the key. This is plausibly the highest-value output of the change: it converts an information-loss report into a modelling fix.

**Description, not response.** A structured hint (`suggestTopicKey: true`) needs a threshold, and `memory/spec.md:1125-1134` requires a calibrated gate to ship disabled pending a committed sweep — a bar this change neither meets nor wants to meet. It is also advice the server would synthesise from a number the agent can read itself, paid for on every save response. The description is read once per session and is where `mcp-api` already puts protocol teaching.

**The description must not name an ask the schema rejects.** Raising the surfaced count is `CANDIDATES_PER_SAVE_MAX`, an operator setting, and the description says so — it does **not** invite the agent to pass a larger value, because there is no such parameter and there will not be one (D2). This is the recorded failure mode of this exact field shape: `surface-pending-judgment-inventory` documented passing `pendingJudgmentsTotal` into a parameter that rejected it with `-32602` for precisely the queues worth draining. `[verified]` budget: 1172 of 1900 characters used, so the recipe fits without displacing anything.

_Alternatives._ **A `suggestTopicKey` boolean** — above. **A free-text `hint` string** — rejected: server-authored prose in a response is the least testable surface possible, and it duplicates the description on every call. **Say it in the `initialize` instructions block instead** — rejected: `[verified]` that block sits at 965/1000 characters (`surface-pending-judgment-inventory`), and per-tool guidance belongs in the tool.

### D7. The count is taken where the cap is applied, and one dead branch is removed so it stays true

`candidatesDetected − candidates.length` is "what the cap dropped" only while nothing filters between the slice and the response. `findSaveTimeCandidates` therefore returns the pre-cap length alongside the capped array, computed at `:232` rather than recomputed in the MCP layer — one place, no drift.

`[verified]` today exactly one thing could break that, and it is unreachable: `if (supersededByTopicKey && c.targetId === supersededByTopicKey.id) continue` (`memory-tools.ts:668`) can never fire, because `saveWithTopicKey` puts the superseded id into the new row's `replaces[]` (`services/memory.ts:229,246`) and `findSaveTimeCandidates` passes `saved.replaces` into `excludeIds` for all three channels (`:100,109,138,189`). Deleting it makes the arithmetic invariant structural rather than accidental, and a test asserts the equality on a topic-key save so a future post-cap filter fails loudly instead of skewing the number.

`CANDIDATE_POOL_SIZE = 20` is exported and added to the named-constants requirement in the same pass. It is the last unnamed bound in the save path, and the field's own semantics reference it, so leaving it as an inline `?? 20` would make the spec cite a number that exists nowhere by name. It stays code-only: for the lexical channel the pool bound _is_ the admission rule (D3), so an env knob would make an admission rule operator-settable — exactly what that requirement exists to prevent — and it has no visible effect on the response, so an operator turning it would be tuning blind.

## Risks / Trade-offs

- [Risk] An agent reads `candidatesDetected: 15` as "15 pending judgments were just created" and tries to drain a queue that does not exist. → The requirement states, and the description repeats, that only the returned `candidates[]` carry `judgmentId`s and pending rows. A spec scenario pins the description's content, and a test asserts the pending-row count equals `candidates.length`, never `candidatesDetected`.
- [Risk] An agent treats the number as an inventory and tries to enumerate the missing pairs. → It cannot: they have no ids. The description gives the two real actions (converge with `topic_key`; re-derive with `memory.search` and record with `memory.compare`) and names no third.
- [Risk] The number is read as a scope-wide total, and an operator concludes the corpus has exactly N related memories. → The name avoids `*Total` (D1), the requirement states the pool bound explicitly, and the description says "at least". `[measured]` on a 38-row corpus it happened to be exact, which is the most dangerous case for this misreading — hence the spec states that exactness is a property of corpus size.
- [Risk] `memory.save` latency regresses on a hot path. → Structurally impossible to regress by query count: no query is added, no repository method changes, and the count is `.length` on an array already materialised at `:232`. The acceptance bar in `tasks.md` proves it rather than asserting it — identical statement count, and wall-clock within the pre-change noise band at 1k/20k/50k on the `tune-hot-query-paths` fixtures. No latency number is claimed anywhere in this change.
- [Risk] Deleting the `supersededByTopicKey` skip changes behaviour on a topic-key save. → It cannot fire (D7, verified through three call sites). A test on a topic-key save asserts the superseded predecessor appears in neither `candidates[]` nor the count, which would fail if the reasoning were wrong.
- [Risk] The `topic_key` guidance makes agents converge topics that should stay separate, collapsing distinct memories under one key. → The guidance is conditioned on a high candidate count and routes through `memory.suggest_topic_key` rather than instructing a key directly; `topic_key` convergence is append-only (the predecessor is superseded, never deleted, and `memory.get` still returns it through `replaces`), so an over-eager convergence is recoverable. `[unmeasured]` — no before/after on agent behaviour exists, and `tasks.md` records the description change as the one behavioural lever in the change.
- [Trade-off] Every save response grows by one number, even when nothing was cut. → Accepted at roughly 25 bytes: a field present only when truncation occurred would be the boolean again, and the caller would have to know the default to interpret its absence.
- [Trade-off] The tail loses fresh-context judgment quality, permanently, and this change does not fix that. → Accepted and stated (D2 caveat 1). The five retained are the five the published precedence ranks highest, and the alternative — recording the tail — is rejected on measured queue cost. Making the number visible is what lets a future change argue for a different budget from evidence.
- [Trade-off] `candidatesDetected` diverges from the repo's `*Total` naming for a numeric companion to a bounded list. → Accepted: the divergence is the honest signal. Two true totals already ship under that suffix, and a third that is a floor would degrade all three.

## Migration Plan

No migration, no schema change, no new table, no index, no derived-index invalidation. `memory_fts`, `memory_vec`, `memory_replaces` and the three entity tables are untouched; `EXTRACTOR_VERSION` and `EMBEDDING_INPUT_VERSION` are not bumped.

Deploy is a plain image upgrade. No save behaviour changes: the same three channels run over the same pool, the same top-5 surface, the same `judgmentId`s are minted, and **no pending row is created, altered or removed by the upgrade** — the judgment queue is exactly as deep the moment after as the moment before. The only difference any caller can observe is one additional number per `memory.save` / `memory.capture_passive` response, plus a longer tool description.

Rollback is a plain image downgrade. The field is output-only, so its disappearance cannot break a client: nothing reads it today because it does not exist, and a client written against it degrades to not seeing it rather than erroring. No client change is required in either direction, so none of the four plugin clients is touched.

Backfill is impossible and no attempt is made: historically dropped pairs left no row, no journal entry and no log line. Their inputs survive — the memory rows are immutable — so any pair that mattered is re-derivable on demand, which is why no backfill is needed rather than an excuse for its absence.

## Open Questions

1. **Should the default `CANDIDATES_PER_SAVE_MAX` move, now that 56% of detected pairs are dropped?** _Default: no, not in this change._ The 56% figure is `[measured]` post-hoc at steady state, not at save time, and raising the surfaced count raises the pending queue one-for-one against `[verified]` evidence that a 52-deep queue is already an operational problem. `candidatesDetected` is the instrument that will answer this from field data: once the distribution of `candidatesDetected` against `candidates.length` is observable on a live instance, the argument for 5 → 8 (or for leaving it) is evidence rather than preference. `tasks.md` records the number to collect.
2. **Should a pair be able to hold more than one verdict?** `[verified]` it cannot: `RelationsService.compare` looks up `findBySourceAndTarget` and overwrites via `markJudged(existing.id, …, { requirePending: false })`, and the schema FSM comment (`db/schema/memory-relations.ts:22`) states "judged → (terminal — re-judging overwrites the same row in-place)". So `conflicts_with` and `scoped` cannot both hold for one pair — a plausible real case ("these contradict, but they apply to different environments"). The nuance survives only in free-text `reason`, which is not filterable, and `/dashboard/judgments` filters on `kind` (`adminListWithContent`), so the unrepresentable second kind is invisible to the operator too. _Default: file it._ Widening verdict cardinality is a schema-shape question (a kinds set, or a second table) that changes the closed-verdict-set contract in `memory`, and nothing here needs it. This change cannot worsen it — it records no additional pairs.
3. **Should `(source_id, target_id)` be unique?** `[verified]` it is not: only `memory_relations_judgment_id_unique` exists, plus three non-unique indexes, and `createPending` inserts with no pair check. **Save-time cannot self-duplicate** — detection dedupes by target id and each save's source is the new row, systematically newer than every target — so this change cannot make it worse. `compare` can assert any direction, so `(A,B)` and `(B,A)` can coexist with contradictory verdicts, and the sibling `order-relation-annotations` makes that visible rather than hiding it in scan order: `listForMemories` annotates both endpoints, so one memory can show two annotations for the same counterpart with conflicting kinds. _Default: file it, and do not reach for the unique index first._ A unique index needs the SQLite table-rebuild dance **plus** a pre-dedupe that decides which existing verdict wins — a data decision, not a migration. A normalised direction would break the POV-dependent `supersedes`/`superseded_by` derivation. And the cheap service guard is subtler than it looks: `applySupersedesSideEffect(sourceId, targetId)` supersedes the target, so merging `(B,A)` into `(A,B)` would invert which memory gets superseded. Direction-preserving reconciliation deserves its own change.
4. **Should the entity channel filter `status = 'active'` like the other two?** `[verified]` it does not: `findOtherMemoriesForEntity` filters `status != 'archived'` (`entities-repository.ts:298`) while the dense channel passes `status: 'active'` (`vectors-repository.ts:66`) and the lexical channel filters `m.status = 'active'` (`memory-repository.ts:138`). Its own doc comment (`:281`) claims "Other **active** memories", and `memory-entities/spec.md:348` requires eligibility against "an existing **active** memory" — so shipped code contradicts a published requirement, and a **superseded** row can take a save-time slot. This also punctures the structural-impossibility arguments in D5.1–D5.2 for one of the three channels. Sole production caller is `save-time-candidates.ts:183`, so the fix is one predicate. _Default: file it, do not fold it in._ `[unmeasured]` impact, and it is a slot-efficiency change — the theme D5 closes. It should be a small, separately-measured change rather than a rider here.
5. **Should the `not_conflict` dismissal walk be transitive?** `[verified]` it is one hop: `listNotConflictTargetsForSources(saved.replaces)` (`save-time-candidates.ts:98`), and `saveWithTopicKey` sets `replaces = [prior.id]` (`services/memory.ts:229,246`). But `memory/spec.md:509` says the dismissal "SHALL be carried forward by walking the `replaces` **chain**" and its scenario at `:556` is titled "Suppression keys on the ancestry, not the new id". So a topic on its fifth save carries only its fourth save's dismissals, and a pair dismissed as a false positive at save 2 re-surfaces at save 5. The mechanism to fix it exists: `PREDECESSOR_CAP = 10` and a bounded breadth-first walk (`services/memory.ts:714-729`, contracted by `memory/spec.md:946`) over the trigger-maintained `memory_replaces` table (migration 0021). _Default: file it, do not fold it in._ Same reasoning as 4 — `[unmeasured]`, slot-efficiency themed, and it adds a bounded query to a hot path, which needs its own measurement rather than riding on one that claims zero added queries.
6. **Should `memory.compare` batch, like `memory.judge` does?** `[verified]` `judge` batches to 25 (`relations-tools.ts:62`); `compare` has no array form, so per-pair recovery costs one call per pair. This change therefore does **not** present `compare` as a bulk escape hatch: it names `topic_key` convergence as the primary action and `compare` as the single-pair one. _Default: separate change_ — batching a write tool needs `judge`'s per-item-transaction contract and its partial-failure response shape spec'd for `compare`, which is its own set of scenarios.
