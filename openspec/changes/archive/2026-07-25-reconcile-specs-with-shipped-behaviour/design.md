## Context

Findings come from an eight-agent adversarial review of `fb565d1..5a84ef1` (the six changes archived 2026-07-25). Code defects were fixed directly in `51ef0d1..57b39a2`; what remains needs a decision about which side of each disagreement is right, which is why it is a change and not a doc pass.

Two properties of this repo shape every decision below:

- **Specs are the contract, tool descriptions are the runtime contract.** A stale `description` string is read by an agent every turn and acted on; it outranks stale prose in severity.
- **Derived data is truncate-and-recompute safe.** `memory_fts`, `memory_vec` and the three entity tables all rebuild from the append-only `memory` table. That is what makes several of these fixable retroactively rather than only for new rows.

## Decisions already supported by evidence

**D1 — Where the code is a deliberate improvement, amend the spec.** Two clear cases. Extraction outside the save transaction is the better design (the alternative holds a write transaction open across an `embedNow`); the deviation was even disclosed in `add-entity-index/tasks.md` 3.2 and only the spec went unupdated. And `memory.get`'s bounded, content-free predecessor projection is better than the specified full chain.

**D2 — Where the spec describes better behaviour, move the code.** The `entity` + `status`/`type` combination, `includeGlobal` on the entity path, and the entity branch's completeness claim are all cases where an agent has been told something useful and true-sounding that the code does not honour. Threading the filters is a small change; silently returning unfiltered rows to an agent that asked for `type:'user'` is a correctness problem, not a documentation one.

**D3 — The entity drill-down must be link-backed, not an FTS query.** `/dashboard/memories?q=<value>` reproduces exactly the tokenizer imprecision the index exists to remove: verified against the dev DB, the only entity present (`ticket #36`, linkCount 1) links to a page rendering "No memories match this filter", because `#` is dropped. An operator clicking a linkCount of 1 and getting 0 rows is a broken affordance.

**D4 — Escalation is read-time only.** Already settled in `ab7a5f6` on the strength of two spec statements ("no sweep SHALL be required to produce it"; the decay axis "SHALL NOT read `created_at`, confirmation baselines, or `REVIEW_TTL_MS`"). The remaining work is recording `reviewEscalated` as contract so it cannot drift back.

**D5 — A surviving marker is the restore hazard; a missing one is safe.** Worth stating explicitly in the doc because the intuition runs the other way. `readMarker` → `null` triggers a full wipe and re-scan, which is correct. A marker whose version _matches_ a restored older DB skips the wipe, and `findMissingScans` — a LEFT JOIN against a fully populated `memory_entity_scan` — then returns nothing, so the index stays on the old recipe indefinitely with no error surfaced anywhere.

## Open questions

**Q1 — Is the entities dashboard view scoped or cross-scope-with-labels?** The spec asserts scope isolation; the shipped view lists every project plus global with a `scope` column, and the test named for the scenario asserts that. Cross-scope matches `/dashboard/memories`, and the dashboard is a single-operator surface behind one admin token, so isolation may be the wrong requirement rather than a missing feature. Deciding this also decides whether `add-entity-index/tasks.md` 7.3 was mis-marked or the spec was mis-written.

**Q2 — Should archived memories be indexed?** Not indexing them makes `memory.search({entity, status:'archived'})` structurally always empty while `includeArchived` suggests otherwise, and makes every recipe bump permanently drop archived links. Indexing them costs a pure, cheap extraction per archived row. Leaning toward indexing, but it widens the drain on first upgrade for corpora with many archived rows.

**Q3 — Does `verdict` get a DB `CHECK`?** It would make the `'affirm'|'refute'` domain unrepresentable rather than service-enforced, and would have made the JS/SQL divergence fixed in `ab7a5f6` impossible. Cost is the table-rebuild dance on a populated `confirmations` table.

**Q4 — What is the terminal state for a refuted TTL-less type?** A refuted `reference` surfaces as `needs_review` indefinitely and can never escalate (escalation requires a TTL), which is the same indefinite limbo the escalation requirement was written to close — reintroduced through the refutation door. Either refutation gets its own clock, or the exemption is stated.

**Q5 — Can the abstention floor be calibrated at all in its current form?** With bm25 ≤ 0 the logistic normalisation yields ≥ 0.5 always, and saturation is steep: measured 0.980 at 3/200 rows against 0.5000002 at 150/200. Any floor ≤ 0.5 can never fire, and anything above it is an IDF cliff rather than a relevance gate. This may need a rank-invariant quantity instead, which is a design change rather than a tuning exercise.

## Resolved (operator decision, 2026-07-25)

**Q1 → cross-scope with labels, for now.** Amend the `dashboard` requirement; do not add a project filter. The view is one operator behind one admin token and `/dashboard/memories` already works this way, so the requirement was mis-written rather than the feature missing. `add-entity-index/tasks.md` 7.3 was therefore correctly implemented and wrongly specified. "For now" is on the record: a project filter stays a legitimate later request.

**Q2 → index archived memories.** Drop the `status != 'archived'` filter from `findMissingScans`. Extraction is pure and cheap, `includeArchived` stops lying, and a recipe bump stops permanently dropping archived links. Accept that the first drain after upgrade is longer on corpora with many archived rows. This also settles `tune-hot-query-paths` Q3: once archived rows are scanned, `count(memory) - count(scan)` is **exact**, not approximate, so that change can take the 12× arithmetic with no accuracy caveat.

**Q3 → add `CHECK (verdict IN ('affirm','refute'))`.** Worth the table-rebuild dance on a populated `confirmations`: it makes the domain unrepresentable rather than service-enforced, and would have made the JS/SQL divergence fixed in `ab7a5f6` impossible by construction. Follow `CLAUDE.md § Table-rebuild migrations`; the runner already owns the pragmas.

**Q4 → state the exemption, no new clock.** Confirms the branch the apply phase already took. A refuted TTL-less type stays `needs_review` and the spec says so explicitly, rather than inventing a second escalation mechanism.

**Q5 → out of scope here; own change.** It is a redesign, not a tuning task: the floor must be scored on a rank-invariant quantity, which also moves the gap-ratio filter's evaluation point. Tracked separately so this change does not grow a design problem.

## Verdict per finding

One row per finding in `proposal.md`, with the side judged right and where it lands. **Amend spec** means the code is the deliberate improvement (D1); **change code** means the spec described the better behaviour and the code moves (D2). Rows marked _not carried_ have a recorded verdict but no task in `tasks.md` and no delta spec — they are named here so the gap is visible rather than lost.

| Finding                                                         | Verdict                          | Lands in                                   |
| --------------------------------------------------------------- | -------------------------------- | ------------------------------------------ |
| `consolidation` orthogonality invariant / read-time escalation  | amend spec (code fixed already)  | `memory` delta, task 3.4                   |
| `entity` "MAY be combined with `status`/`type`"                 | change code                      | task 2.1                                   |
| entity path promises completeness, returns 8                    | change code                      | task 2.2                                   |
| `topic_key` documented as any-status, defaults to `active`      | change code                      | task 2.3                                   |
| global entities invisible to a project-scoped read              | change code                      | task 2.4                                   |
| extraction "SHALL run inside the same transaction as the save"  | amend spec                       | `memory-entities` delta                    |
| `dashboard` "the view is scope-isolated"                        | amend spec (Q1)                  | `dashboard` delta, task 1.2                |
| `dashboard` entity drill-down is an FTS query                   | change code (D3)                 | **not carried** — no task, no delta        |
| `claude-code-plugin` "first-prompt relevance prefetch"          | amend spec or call the endpoint  | **not carried**                            |
| four specs describe the recall hook as matcher-gated            | amend specs                      | **not carried**                            |
| `claude-code-plugin` "hook output ≤30 tokens" (measured ~135)   | amend spec                       | **not carried**                            |
| `retrieval-evaluation` "a floor per metric" gates three of five | gate the two, or narrow the line | **not carried**                            |
| `data-access` aggregate-count loophole + two unprefixed reads   | amend spec **and** change code   | task 5.10                                  |
| the refutation channel is unrecorded                            | amend spec (add)                 | `mcp-api` + `memory` deltas, tasks 3.1–3.3 |
| `memory.context`'s entity pre-pass is unrecorded                | amend spec (add)                 | `mcp-api` delta, task 4.1                  |
| entity-table DDL and the identity index are unrecorded          | amend spec (add)                 | `persistence` delta, task 4.2              |
| `verdict` has no DB `CHECK`                                     | change code (Q3)                 | task 4.3                                   |
| entity-channel candidate similarity is unit-incompatible        | change code (normalise)          | task 4.4                                   |
| seven ranking/lifecycle constants no requirement names          | amend spec (add)                 | `memory` delta, task 4.5                   |
| surviving `last_seen_at` claims (three sites)                   | amend spec                       | tasks 5.1–5.3                              |
| `sessions` startup-only vs periodic retirement                  | amend spec                       | task 5.4                                   |
| rank-window claim vs the post-fusion boost                      | amend spec                       | task 5.5                                   |
| gap-ratio filter specified per-best, implemented per-pair       | amend spec                       | task 5.6                                   |
| `memory.get` predecessor chain and the phantom `source` field   | amend spec                       | task 5.7                                   |
| entity retrieval "no cutoff" vs the 400-row bound               | amend spec                       | task 5.8                                   |
| `memory.stats` / `memory.doctor` response shapes                | amend spec                       | task 5.9                                   |
| `docs/backup.md` restore trap, shrinkage var, cron claim, guard | change docs                      | tasks 6.1–6.7                              |
| `persistence` "both tables" for the entity rebuild              | amend spec                       | task 6.6                                   |
| the kind-justification table has no measurement apparatus       | change code **and** amend spec   | tasks 7.1–7.5                              |
| archived memories are never indexed                             | change code (Q2)                 | task 8.1                                   |
| a drain is indistinguishable from an unknown entity             | change code                      | task 8.2                                   |
| `truncateAll` is three DELETEs outside a transaction            | change code                      | task 8.3                                   |
| `findMemoriesByEntity` has no ordering tiebreaker               | change code                      | task 8.4                                   |
| the entity-links composite PK is absent from Drizzle            | change code                      | task 8.5                                   |
| the three entity tables are absent from the drift snapshot      | change code                      | task 8.6                                   |
| `ABSTENTION_FLOOR` has no usable dynamic range                  | redesign (Q5)                    | owned by `rescore-relevance-abstention`    |
| `writeBaseline` sets floors with no ratchet                     | change code                      | task 8.8                                   |
| `MEMORY_TYPES` is hand-copied at four sites                     | change code                      | task 8.9                                   |

**D6 — The entity candidate channel's score is a similarity, its rarity is a gate (Q-less, decided here for 4.4).** `1 - linkCount/scopeMemoryCount` is a rarity proportion, so a once-linked entity in a 1000-memory scope reports 0.999 and outranks any realistic cosine in a `max()` merge that claims to compare one quantity. Scoring it on rarity is also corpus-size-dependent, which is the exact defect `fix-retrieval-ranking-math` removed from the lexical side. The channel therefore reports the SAME bounded token-containment quantity the lexical channel reports, and `ENTITY_RARITY_THRESHOLD` stays what it already was — an admission gate. Precedence becomes explicit instead: entity candidates lead the merged list, because that is the same principle `memory.context`'s entity pre-pass already rests on ("an exact identifier match is stronger evidence than any ranked score"). Scoring on containment alone without the explicit lead would have silently disabled the channel — a shared rare identifier with no shared vocabulary is exactly the case it exists for, and five vec/fts candidates would crowd it out of `perSaveMax`.

## Risks

- **Scope.** This touches eleven specs. The temptation is to transcribe rather than decide; task 1.1 exists to force a recorded verdict per finding first.
- **Re-reading whole specs is mandatory.** Every contradiction found here was _between_ requirements, not within one, so line-local edits will not surface the next one.
- **The evidence bar cuts both ways.** Committing the noise-rate harness will likely retire or narrow at least one kind's justification (`error_code`'s bareword branch already measures 50–75% noise, not the published 0%). That is the point, but it means this change may end up removing a kind, not only documenting one.
