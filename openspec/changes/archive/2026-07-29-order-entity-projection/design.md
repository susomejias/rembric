## Context

Three MCP surfaces project a memory's entity links into a bounded list, all through the same two lines:

| surface                     | call site              | fetch                     |
| --------------------------- | ---------------------- | ------------------------- |
| `memory.search` result rows | `memory-tools.ts:992`  | `findEntitiesForMemories` |
| `memory.get` batch (`ids`)  | `memory-tools.ts:1058` | `findEntitiesForMemories` |
| `memory.get` single (`id`)  | `memory-tools.ts:1110` | `findEntitiesForMemory`   |

Each does `ents.slice(0, ENTITIES_PROJECTION_CAP)` plus `entitiesTotal: ents.length`. Neither repository read has a `LIMIT`, so the array being sliced holds every entity linked to that memory — which is why `entitiesTotal` is specified as exact rather than a floor, and why the ordering decision can be made in the process without a second query.

`a01d051` added `ORDER BY (kind, value)` to both reads. That closed a real defect — `surface-entity-projection-total` shipped a bound over an unordered set, so two identical reads of the same memory could return different subsets — and `(kind, value)` is unique per memory, so the order is total. It was chosen for totality, not for value; the archived `design.md` D2 says so, and says the usefulness question is deferred rather than denied. This change answers it.

Constraints: all SQL stays under `db/`; the MCP input schema must not change (four clients ship against it); `ENTITIES_PROJECTION_CAP` is named by a published requirement and is not operator-configurable; the projection must not affect which memories are returned or in what order.

### The instrument, and the one that does not work

**The resident dev corpus cannot answer this question, and was not used as the instrument.** It holds 2055 memories with 2441 entity links and 32 distinct entities. Its content is generated one-liners — content length p50 71, p90 148, max 167 — so no memory carries more than **2** links (1601 rows have 1, 420 have 2, none have 3), and 31 of the 32 entities are `path`. The bound binds on 0 of 2055 rows. That 0 is a property of the corpus, not of the projection: reporting it as evidence that the cap never binds would be the vacuous number, and the near-uniform link distribution is the same limitation `align-rarity-gate-population/measurements.md` recorded for the same corpus.

**What was used instead:** the shipped `extractEntities` (`v7-tracked-dotfiles-fair-budget`, unchanged by this change) run over 284 of this repo's own commit bodies. That is a proxy, and its limitations are stated in Risks — but it is a production-shaped one: p50 855 chars, p90 2534, max 8602 against a `summary` bound of 10000, written by the same agents about the same repo, with the same "Files" habit a `memory.session_summary` has. The figures are in `proposal.md`; the two facts the decisions below rest on are that the bound binds on **2 of 284** documents, and that on **2 of those 2** today's order evicts an entire kind while fair share evicts none.

## Goals / Non-Goals

**Goals:**

- Which entities survive the bound SHALL be decided by the memory's own entity composition, not by the alphabetical spelling of a kind name.
- Every kind linked to a memory SHALL be represented in the projection whenever the number of distinct kinds fits the bound.
- The order SHALL be total, so two identical reads on unchanged data return the same list in the same order — the guarantee `a01d051` established, preserved rather than replaced.
- All three surfaces SHALL agree, and a call site SHALL NOT be able to project the list without its total.
- Zero additional queries, and no change to any query plan.

**Non-Goals:**

- Ordering by entity rarity (D3) — the better signal, and it costs a read-path aggregate that the measured binding rate does not pay for.
- A kind-precedence tier of the `ANNOTATION_TIER` shape (D1) — entity kinds admit no defensible precedence, which is archived D2's objection and is upheld here.
- Changing `ENTITIES_PROJECTION_CAP` (D4).
- A shipped per-installation binding-rate figure on the dashboard or in `memory.doctor` (D4).
- Any request argument that raises the returned count, or a tool description naming one — forbidden by the published requirement and untouched.
- Any change to extraction: `extractEntities`, `MAX_ENTITIES`, the per-kind budget, `EXTRACTOR_VERSION`, the entity-noise probes.
- Any change to the save-time rarity gate, `ENTITY_RARITY_THRESHOLD`, or `entityLinkCount`.
- Any repository, schema, migration, or derived-index change.
- Any eval-harness change (D7).

## Decisions

### D1. Max-min fair share across the kinds present, not a kind-precedence tier

The projection is built by round-robin over the kinds linked to the memory: every kind contributes its first entity before any kind contributes a second, and the surplus falls to the kinds that have more. Round-robin over per-kind lists **is** max-min fair share, so no separate allocator is needed. The input is the repository's `(kind, value)` order, so within a kind the entities are in `value` order and the whole result is a deterministic function of the row set.

**Why fair share and not a tier.** `order-relation-annotations` solved the analogous problem with `ANNOTATION_TIER`, and that worked because relation kinds carry a severity order that can be argued from what the reader must do: a `conflicts_with` demands an action, a `related` does not. Entity kinds carry no such order. A `ticket` does not outrank a `path`; which is the better pivot depends entirely on the question being asked, and the question is not in the row. Archived D2 said exactly this, and this change does not overturn it — it routes around it. Fair share is **symmetric across kinds**: it asserts no kind is better, only that a kind present should not be invisible.

And it is already the repo's answer to this exact question one layer up. `services/entities.ts` allocates the 250-entity extraction budget by max-min fair share across the kinds present — `EXTRACTOR_VERSION` literally says `fair-budget` — for the same reason: a document dominated by paths should not have its one error code crowded out. This change applies the same rule to the second bound on the same data. One rule, two bounds, and the helper lands in the module that already owns it.

**Why the measured harm is a kind-coverage harm.** Both binding documents lose a whole kind, and the kinds lost are `ticket` (twice) and `url` — the three alphabetically-last kinds are `ticket`, `url`, `uuid`, so this is the mechanism, not a coincidence. The 23-entity document keeps `env_var:HOME` and nine paths and drops `ticket:#56` and `url:https://opencode.ai`. Under fair share the same document projects one `env_var`, one `ticket`, one `url` and seven paths: it loses two paths, and a memory that mentions 21 paths is not less findable for surfacing seven of them.

_Alternatives._
**A hand-written kind precedence** (`cve_id` > `ticket` > `error_code` > `path` > …) — rejected: it is the guess archived D2 declined to make, it would be argued from intuition about pivot value, and it would have to be re-argued every time a kind is added.
**Rank kinds by `PUBLISHED_NOISE`** (`test/entity-noise/corpus.ts`) — the only measured per-kind figure in the repo, and unfit for this. It is the **worst-case** rate over 1–3 hand-written adversarial decoys, so ranking kinds by it ranks them by the probe author's imagination; and it measures how noisy an _FTS lookup_ for that identifier is, which is the argument for the entity index existing, not for one entity being more worth displaying than another. The entity pivot is an exact index lookup with no lexical noise by construction. Recorded so it is not reached for later.
**Leave `(kind, value)`** — stable, and the measurement shows it is stably wrong in the case the bound exists for.
**Sort by `value` alone** — removes the kind-name bias and replaces it with a filename-spelling bias; `a.ts` before `z.ts` is no more defensible than `error_code` before `path`.

### D2. The interleave is a service-layer function, not an `ORDER BY`, and not MCP-local

It lands in `services/entities.ts` and is applied at the three MCP call sites.

**Not SQL.** A window-function formulation exists (`ROW_NUMBER() OVER (PARTITION BY memory_id, kind ORDER BY value)`, then order by that rank) and is rejected. `findEntitiesForMemories` runs on **every** `memory.search` — one of the hottest reads in the server, and one with an active performance change over it (`tune-hot-query-paths`). Changing its plan to reorder rows the process already holds in an array is cost for no benefit; the repo's own standing discipline is that a SQL rewrite assumed to be free has already been measured as a pessimisation here once. The interleave is O(n) over at most a few dozen rows, after a fetch that has already happened.

**Not in `memory-tools.ts`.** The MCP layer orchestrates; a projection policy with a rule behind it is domain logic. `order-relation-annotations` D3 put the annotation comparator in `RelationsService` for the same reason, and the tier list needed to sit beside the enum it depends on. Here the rule needs to sit beside the fair-share budget allocator it is the sibling of.

**The repository `ORDER BY` stays, and becomes load-bearing.** `(kind, value)` is no longer merely "an order so the subset is stable" — it is the interleave's stable input, and without it the within-kind order would be scan order again and the fair-shared result would be non-deterministic. Deleting it would reintroduce the `a01d051` defect one layer up, where no test currently looks. Its doc comments must say this, and a task asserts it by mutation.

### D3. Rarity is the right signal and is deferred, with a stated trigger

A rare identifier is a better pivot than a ubiquitous one — pivoting on a path linked to 900 memories returns 900 rows and helps nobody; pivoting on `ticket:#56` returns the one thing it addresses. This is not a new claim in this repo: `ENTITY_RARITY_THRESHOLD` and the save-time gate already encode it, and `align-rarity-gate-population` already settled which population the share is taken over. And the measured failure is precisely a rarity failure: `env_var:HOME` survived, `ticket:#56` did not.

It is deferred because it needs a per-entity link count on a read path served on every `memory.search`. The aggregate itself is cheap in isolation (`memory_entity_links` is `WITHOUT ROWID` with `entity_id` leading the composite PK, so it is an index range scan, and `adminTopEntities` already computes the shape). What is not established is that it is worth a query per search response: the bound binds on 0.7% of production-shaped rows, so the ordering it would improve is invisible on roughly 142 rows in 143, and fair share already removes the kind-loss harm on the rows where it binds.

_Trigger to revisit._ A corpus where the bound binds on a materially larger share of rows — the figure to beat is 0.7% — **or** an observation that fair share retains a ubiquitous entity in preference to a rare one of the same kind, which fair share cannot fix by construction because it never compares two entities of the same kind by anything but `value`. Either would justify measuring the aggregate's cost at 1k/20k/50k links (the `db-performance-auditor` discipline) before adopting it.

_Alternative considered._ **Rarity within the memory only** — order round 1 by ascending count-of-that-kind-in-this-memory, so the kind with one entity leads. Free, no query. Rejected as unmotivated: it changes only the order _within_ the retained set (which the caller is not promised to read in priority order) except when distinct kinds exceed the bound, which is D6's unreachable residual. A rule with no measured effect is a rule to maintain for nothing.

### D4. The cap stays 10, and no shipped instrument is built

`surface-entity-projection-total`'s open question asked whether 10 is right and named the published count as the instrument. The count was the wrong instrument to wait for: nothing records it. The right one turned out to be the shipped extractor run offline over production-shaped text, which needs no code and can be pointed at any corpus.

Its answer: entities per document p50 1, p90 3, **p99 8**, max 23. The bound sits above the 99th percentile. Raising it to 25 would cover the observed maximum while changing nothing on 99.3% of documents, and would spend payload on every row of every search response — the axis `retrieval-evaluation` records CI does not protect. Lowering it would bind more often for no stated benefit. 10 stands, and the constants requirement now says the bound is applied to a fair-shared order, which is what makes the value reviewable at all: a bound over an arbitrary order cannot be judged, because what it withholds is arbitrary.

**Why no dashboard or `memory.doctor` figure.** Both are real operator surfaces and either could host a "share of memories whose entity list exceeds the bound" aggregate — `/dashboard/entities` already computes per-entity `linkCount`, so the inverse aggregate is one `GROUP BY memory_id` away. It is still declined here: it is a `dashboard` (or `mcp-api`, for `doctor`) capability change with its own requirement, scenarios and page, bolted onto a change whose subject is an ordering rule; and the reordering removes the harm that made the figure urgent, since after it a binding projection loses surplus entities of an over-represented kind rather than an entire kind. Not a prerequisite for this change, and a candidate for its own if an operator ever needs to answer the cap question for their own corpus rather than for a proxy.

### D5. One helper returns the bounded list and its exact total together

Signature shape: given the ordered rows and the bound, return `{ entities, entitiesTotal }`. The three call sites destructure it; neither field can be produced without the other.

This is not tidiness. `a01d051` had to repair exactly this: `fields: ['entities']` projected 10 of 27 entities and dropped `entitiesTotal`, violating "present whenever `entities` is present" — a guarantee published in the same branch — because the `fields` rule had been written for the relation pair and not for its sibling. Three call sites × two fields that must agree is the shape that produced that bug; one return value is the shape that cannot. The `fields` re-add in `handleSearch` stays as it is (it operates on the projected object, not the fetch) and gets an explicit test rather than an assumption.

### D6. When distinct kinds exceed the bound, kind name decides — stated, not hidden

If a memory carries more than `ENTITIES_PROJECTION_CAP` distinct kinds, round one alone overflows and some kind is necessarily dropped; which one is then decided by ascending kind name, i.e. by the same spelling bias this change exists to remove. The hole is real and named rather than papered over.

It needs 11 of 12 kinds on one memory. Measured maximum distinct kinds per production-shaped document: **4** (distribution: 0→61, 1→159, 2→58, 3→4, 4→2 of 284). No rule is added for it, because any rule would be an unmeasured kind precedence — D1's rejected alternative, reintroduced for a case nothing has ever produced. A spec scenario pins the behaviour so it is contracted rather than incidental.

**Correction found during apply: this is not the only place kind name arbitrates, and the other place is far more reachable.** When equal-sized kinds compete for a _surplus_ slot, the slot goes to the kind whose name sorts first. Measured with the shipped helper at cap 10: `{cve_id: 4, ticket: 4, uuid: 4}` allocates `{4, 3, 3}`, and `{path: 6, ticket: 3, url: 6}` allocates `{path: 4, ticket: 3, url: 3}` — `path` beats `url` on identical counts purely because `p < u`. That needs **three** kinds, not eleven.

The residue is accepted and disclosed rather than fixed. It is inherited from `admit`, the extraction-budget allocator, so removing it here would leave the two allocators disagreeing. And it is an order of magnitude smaller than what this change fixes: losing one slot of a tied kind is not losing the kind. What is corrected is the delta spec, which had claimed the ordering was "symmetric across kinds" — a stronger claim than the code keeps, and exactly the kind of unverified assertion this batch of changes exists to stop shipping.

### D7. No eval-harness change, and `pnpm run eval` is a non-regression check only

The projection is not scored. Retrievers return ids; `entities[]` is an annotation on a row that was already selected and already ordered, and nothing in this change touches selection, ranking, abstention or the entity retrieval path (`findMemoriesByEntity` is untouched). A metric over projection order would have to be invented for this change alone. `pnpm run eval` runs to prove nothing moved, and its output is not evidence for the change — the same disposition `order-relation-annotations` D6 recorded, for the same reason.

## Risks / Trade-offs

- [Risk] The 284-document instrument is commit bodies, not memories — a proxy, and it could misstate the binding rate in either direction. → Stated as a proxy in `proposal.md` and here rather than presented as a corpus measurement; the alternative available (the dev seed corpus, max 2 links per row) cannot bind the cap at all and would have produced a vacuous 0. The two facts the decisions rest on are also arithmetic, not statistical: a kind-blocked order **must** evict the alphabetically-last kinds when it binds, and fair share **cannot** evict a kind while any kind holds two slots. The measurement shows the case is reachable; the arithmetic shows the direction is right.
- [Risk] The bound binds on 0.7% of rows, so the change is invisible on the other 99.3% and could look like effort for nothing. → The cost is a comparator over an array already in hand: no query, no plan change, no migration, no payload change. And 0.7% is the proxy's figure — a corpus of longer documents binds far more often, and an installation cannot currently tell which it has (D4).
- [Risk] An existing test asserts today's alphabetical order and would pass under the new order only by accident, or vice versa. → Tasks 4.4–4.5 run the suite with the interleave removed and restored, so an accidental dependency surfaces as a failure now rather than as flake later. The same mutation check covers the repository `ORDER BY`, whose new load-bearing role (D2) has no test today.
- [Risk] Deleting the repository `ORDER BY` as "redundant now that the service orders" would silently reintroduce non-determinism inside the fair-shared result. → D2 records it as load-bearing, the doc comments say so, and task 4.5 mutates it to prove a test fails.
- [Risk] An operator diffing a `memory.search` response across the upgrade sees a different set of 10 entities and reads it as data loss. → It is a read projection over unchanged rows; `entitiesTotal` already states the true count and is unchanged; the complete set has always been visible on `/dashboard/entities` and via `memory.search` with an `entity` filter. Called out in the Migration Plan.
- [Risk] `fields: ['entities']` regresses again, since it is the one path that rewrites the projected object after the helper ran. → Task 3.4 tests the `fields` path explicitly on all three of ordering, bound and total, rather than trusting that D5's helper covers it.
- [Trade-off] A memory dominated by one kind surfaces fewer of that kind than today (the 21-path document goes from nine paths to seven). → Accepted: the two slots buy the issue reference and the URL, which address one thing each, and seven of 21 paths is the same "some of many" the caller already had. `entitiesTotal` tells them 23 exist.
- [Trade-off] The projected list is no longer grouped by kind, so a human reading raw MCP output sees kinds interleaved. → Accepted: the consumer is an agent choosing a pivot, not a person scanning a table, and the dashboard entities view is the grouped presentation. Interleaving is the mechanism, not a side effect.
- [Trade-off] Ordering logic now lives in a service while a related `ORDER BY` lives in a repository, so the full order is described in two places. → Accepted and documented at both ends: the repository clause is the stable input, the service function is the policy. The alternative (all of it in SQL) buys single-location clarity with a plan change on the hottest read (D2).

## Migration Plan

No migration, no schema change, no index change, no `EXTRACTOR_VERSION` bump, and no derived-data invalidation: `memory_fts`, `memory_vec` and the three entity tables are untouched, and nothing about how entities are extracted or linked changes. This is a read projection over rows that already exist.

First boot after upgrade reads the same `memory_entity_links` rows and projects them in the new order. `entitiesTotal` is unchanged on every row, `count`, `memories[]` selection and ordering are unchanged, and no response field is added or removed — a populated instance with hundreds of memories sees a different ten entities only on rows where `entitiesTotal > 10`, which the proxy measurement puts at under 1% and the dev seed corpus at zero.

Rollback is a plain image downgrade: the older code reads the same rows and projects the alphabetically-first ten again. Nothing was written, so nothing is left inconsistent, and no client change is required in either direction — the MCP input schema, the tool descriptions and the response shape are all identical, so `apps/plugin/` is not touched and the four clients need no release.

## Open Questions

1. **Does an installation's real corpus bind the bound more often than 0.7%?** _Default: assume it may, and do not build a shipped instrument for it (D4)._ The measurement is reproducible offline against any corpus with the shipped extractor, and the reordering lowers the cost of binding. Revisit as a `dashboard` change if an operator asks the question about their own data.
2. **Should the projection prefer rare entities within a kind?** _Default: no, deferred (D3)._ Fair share cannot express it and the read-path aggregate is unpriced. The trigger is stated in D3; the cost measurement it would need is stated too.
3. **Should `memory.context` project entities at all?** It returns memories today and carries no `entities[]`, so it is the one memory-returning surface outside the "three surfaces agree" guarantee. _Default: leave it._ Adding the projection there would widen a payload that exists to be read at session start, and it is a `mcp-api` requirement change with no defect behind it — noted only so the asymmetry is on record rather than discovered later as an omission.
