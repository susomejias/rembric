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

## Risks

- **Scope.** This touches eleven specs. The temptation is to transcribe rather than decide; task 1.1 exists to force a recorded verdict per finding first.
- **Re-reading whole specs is mandatory.** Every contradiction found here was _between_ requirements, not within one, so line-local edits will not surface the next one.
- **The evidence bar cuts both ways.** Committing the noise-rate harness will likely retire or narrow at least one kind's justification (`error_code`'s bareword branch already measures 50–75% noise, not the published 0%). That is the point, but it means this change may end up removing a kind, not only documenting one.
