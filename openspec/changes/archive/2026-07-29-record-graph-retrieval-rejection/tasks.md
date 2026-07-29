## 1. The derived-table registry (design.md D3)

- [x] 1.1 In `apps/server/src/test/invariants.test.ts`, add a `describe('derived-table reproducibility invariant')` block with the classification as a single literal: `SOURCE_TABLES` naming `_migrations`, `confirmations`, `consolidation_ops`, `consolidation_runs`, `dashboard_sessions`, `memory`, `memory_relations`, `projects`, `prompts`, `sessions`, `tokens`; and `DERIVED_TABLES` as one entry per derived table carrying `{ derivesFrom, mechanism, marker }` — `memory_fts` (from `memory`, triggers `memory_ai`/`memory_au`/`memory_ad`, no marker), `prompts_fts` (from `prompts`, triggers `prompts_ai`/`prompts_au`/`prompts_ad`, no marker), `memory_replaces` (from `memory.replaces`, triggers `memory_replaces_ai`/`memory_replaces_au`/`memory_replaces_ad`, no marker), `memory_vec` (from `memory.title`+`content`, `ensureVectorModel` in `src/embeddings/state.ts`, marker constants `EMBEDDING_MODEL_ID` + `EMBEDDING_INPUT_VERSION`), and `memory_entities` / `memory_entity_links` / `memory_entity_scan` (from `memory.title`+`content`, `resetEntityIndex` + `ensureEntityExtractor` in `src/services/entity-state.ts`, marker `EXTRACTOR_VERSION`).
- [x] 1.2 Assert **completeness as a partition** against `sqlite_master` over a freshly migrated temp database (same fixture shape the suite's other schema-reading tests use): every non-shadow table is in exactly one of the two lists, and every listed table exists. Do NOT reuse `schema-drift.test.ts::EXPECTED_TABLES` — it deliberately tolerates extra tables and so cannot detect an unclassified one (design.md D3).
- [x] 1.3 Handle FTS5/vec0 shadow tables by prefix, reusing the `SHADOW_TABLE`-style regex idiom from `schema-drift.test.ts` (`^(memory_fts|prompts_fts|memory_vec)`): a shadow table is derived with its parent and is not a separate registry entry. The partition assertion runs over owned tables only, and MUST still be a partition (no "tolerate extras" escape).
- [x] 1.4 Assert each derived entry's **mechanism exists**: every named trigger is present in `sqlite_master`, and every named rebuild entry point is exported by the module the entry names. This is the "allow-list anchors" idiom the suite already uses for the purge `DELETE`s — the anchor is what stops a rebuild path being deleted while the registry still claims it.
- [x] 1.5 Assert each derived entry's **marker constant is exported** where the entry declares one (`EMBEDDING_INPUT_VERSION`, `EMBEDDING_MODEL_ID`, `EXTRACTOR_VERSION`), and assert that entries declaring no marker are exactly the trigger-maintained ones — so a future table with a mutable recipe and no marker fails here rather than drifting silently.
- [x] 1.6 Add no comments beyond one line per non-obvious fact, per the repo comment policy. The registry's rationale belongs in `openspec/specs/persistence/spec.md`; point at the requirement, do not restate it in a banner.

## 2. Prove the registry can fail (mutation checks — the point of the whole task group)

- [x] 2.1 Add a table to a scratch copy of the migrated schema without adding it to either list; confirm task 1.2 FAILS naming that table. Record the observed failure message in this file. A registry that cannot fail is decoration (design.md D3).
- [x] 2.2 Remove one named trigger from the scratch schema; confirm task 1.4 FAILS naming it.
- [x] 2.3 Rename `EXTRACTOR_VERSION`'s export locally; confirm task 1.5 FAILS. Restore.
- [x] 2.4 Add a shadow-table-prefixed name that is NOT a real shadow table and confirm the prefix rule does not swallow it into "derived with its parent" without an entry — i.e. confirm task 1.3's prefix handling did not reintroduce a tolerate-extras hole. If it did, tighten the rule to an exact shadow-table set per parent before proceeding.
- [x] 2.5 Record all four observed failures in this file. If any mutation does NOT produce a failure, stop and fix the assertion before moving on.

## 3. Delta specs (no source behaviour)

- [x] 3.1 Confirm `specs/persistence/spec.md` (this change) matches what task 1 actually implemented — in particular that the mechanism and marker names in the requirement's text are the ones the registry asserts. If the implementation diverged, amend the delta spec, not the test.
- [x] 3.2 Confirm `specs/memory-entities/spec.md` (this change) still names the old title verbatim in its `RENAMED` FROM line, character for character against `openspec/specs/memory-entities/spec.md:454`, or the archive sync will not find the requirement to rename.
- [x] 3.3 Grep `openspec/specs/` for the retired claim ("in its own author's benchmark", and the `Recall@5` / `NDCG@10` / `MRR` triple) and confirm `memory-entities/spec.md:454` is its only occurrence, so the delta removes it everywhere it is published rather than in one of two copies.
- [x] 3.4 Grep `openspec/specs/` for `derived` and read the surrounding requirements whole — the FTS/vec sync requirement, the `memory_replaces` requirement, `The entity tables MUST be declared derived, never primary`, `The entity index MUST be rebuildable and its drift MUST be observable`, and `A change to the extraction recipe MUST retroactively correct already-indexed memories`. Confirm the new requirement generalises them and contradicts none. A contradiction here appears BETWEEN requirements, not within one.
- [x] 3.5 Confirm no source spec file under `openspec/specs/` is edited in the implementation commit. Published text arrives at archive time only (`pnpm run check:spec-provenance` is CI-gated).

## 4. Verification

- [x] 4.1 `pnpm run typecheck` green.
- [x] 4.2 `pnpm run lint` green.
- [x] 4.3 `pnpm test` green, run from the repo root or from `apps/server` (from any other directory `vitest` matches no files and exits 0, so "no failures" would be indistinguishable from "ran nothing"). Record the `Tests N passed` count before and after and assert it grew by exactly the number of assertions added in tasks 1.2–1.5.
- [x] 4.4 `pnpm run eval` — **not required**, and deliberately so. No retrieval path, ranking constant, threshold, corpus fixture or baseline changes; the only executable artifact is a schema-reading test. Run it only if the implementer touched anything under `apps/server/src/test/retrieval/`, in which case baselines MUST be unchanged and `--write-baselines` MUST NOT be used.
- [x] 4.5 `openspec validate record-graph-retrieval-rejection --strict` green.
- [x] 4.6 `pnpm run check:spec-provenance` green.
- [x] 4.7 Confirm `git diff --name-only main -- apps/plugin/` is empty: no MCP tool, no tool-schema change, no plugin resource, so none of the four clients needs work.
- [x] 4.8 Confirm `git diff --name-only main -- apps/server/src/db/` is empty: no migration, no schema file, no repository. If a migration appeared, this change has grown a behaviour and needs re-scoping.

## 5. Docker smoke against pre-existing seeded data (operator-run on host)

This change adds no behaviour, so the smoke is a **regression floor**, not a feature proof: it exists to show that publishing a property about derived tables did not disturb the tables. It is still mandatory — the standing requirement covers anything touching migrations or production behaviour, and "we believe we touched nothing" is what the smoke checks.

- [ ] 5.1 Bring up the dev stack per the `rembric-smoke-tests` playbook (`pnpm run dev:docker:up`; `chown -R 10001:10001 data-dev` first if it fails with `SQLITE_CANTOPEN`). Do NOT wipe the seeded corpus.
- [ ] 5.2 Record `memory.doctor` before and after the upgrade and confirm the embedding backlog, the entity backlog and the entity link-count delta are unchanged, and that no owed-reset warning appeared. A spurious reset warning would mean a marker was disturbed.
- [ ] 5.3 Confirm no migration ran: the `_migrations` row count is identical before and after, and the startup banner's per-table row counts match.
- [ ] 5.4 Run one `memory.search` and one `memory.get` against the seeded corpus and confirm the results are identical to the pre-upgrade run. Assert the result set is NON-EMPTY first — an "identical behaviour" comparison between two empty results proves nothing.
- [ ] 5.5 Tear the stack down.

## 6. The measurement this change must produce

- [x] 6.1 The empirical claim being made is that **the registry's classification is complete and each derived table's reproduction path exists today** — i.e. the property the requirement publishes is already true. The number to produce: **7 derived tables** classified (`memory_fts`, `prompts_fts`, `memory_replaces`, `memory_vec`, `memory_entities`, `memory_entity_links`, `memory_entity_scan`), **11 source tables**, partition over `sqlite_master` complete with zero unclassified owned tables. Record the actual counts here after task 1.2 runs; if they differ from 7/11, the registry found something this change did not know about — investigate before proceeding rather than adjusting the numbers.
- [x] 6.2 Record the four mutation-failure messages from task 2.5 here. These are the evidence that the requirement is assertable rather than decorative (design.md D3).

## 7. Deferred and explicitly rejected — recorded so nothing is silently lost

- [x] 7.1 **Deferred: `schema-drift.test.ts::EXPECTED_TABLES` is missing `memory_replaces` and `prompts_fts`.** Verified while writing this change. Not fixed here: that assertion deliberately tolerates extra tables (FTS5/vec0 shadow sets vary by extension version), so the gap is inherent to a subset assertion and the new registry closes the same hole from a stronger angle. File a follow-up to add the two entries anyway — a subset assertion missing a table it owns is still a defect.
- [x] 7.2 **Rejected: asserting the reverse direction** — that every `source`-classified table is genuinely not recomputable. Unrecomputability cannot be tested, and asserting it would be exactly the unfailable scenario the design refuses to write (design.md Open question 1).
- [x] 7.3 **Rejected: moving the registry into a runtime module so `memory.doctor` could report rebuild coverage.** It would become product surface with its own spec obligations, for a report no operator has asked for (design.md Open question 2). Revisit only if a rebuild-coverage gap is observed in the field.
- [x] 7.4 **Deferred: a `retrieval-evaluation` query class for global sensemaking / summarisation.** It is the instrument any future graph-retrieval proposal would need, and the retitled `memory-entities` requirement now says so explicitly. Not written here: gold labels for a class no telemetry shows arriving is speculative corpus work, and whoever proposes the index owns the corpus extension (design.md Open question 3).
- [x] 7.5 **Deferred: query telemetry.** Named as falsifier 2 in design.md D8 and as the reason Reason 3 of the verdict is currently unanswerable. Its own change; a prerequisite for reopening the decision, not part of it.
- [x] 7.6 **Not restated anywhere, ever:** the "$33k to index 5GB" figure (single unverified secondary source) and the OpenReview NoLLMRAG citation (verification screen, could not be confirmed). Both are recorded as `[unverified]` in design.md's source table. Confirm neither appears in any published spec text before archiving.
- [x] 7.7 **Cross-reference, do not duplicate:** the `include_relations` widening rejection and the annotation-truncation defect belong to the sibling change `order-relation-annotations` (its D5 and §6.1). Confirm this change's artifacts point at it rather than restating its numbers, so the two cannot drift.

## Apply notes and recorded measurements (2026-07-29)

### 6.1 — the registry found something this change did not know about

Predicted 7 derived / **11** source. Actual: **7 derived / 14 source**, partition complete over
`sqlite_master` with zero unclassified owned tables. The three extra are
`oauth_authorization_codes`, `oauth_clients`, `oauth_tokens` — absent from task 1.1's
`SOURCE_TABLES` literal. Investigated rather than adjusted, per 6.1's instruction: all three
hold client- or operator-supplied credentials and grants, recomputable from nothing, so they
are unambiguously **source**. They are the same three tables that were missing from
`schema-drift.test.ts::EXPECTED_TABLES` until 2026-07-29 — the gap this change's 7.1 describes
turned out to be wider than 7.1 knew.

### 2.5 — the four mutation failures, observed

| mutation                                                   | outcome                                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| unlisted table in the migrated schema                      | FAILS: `unclassified table(s) in the schema: mutant_unclassified`                                                            |
| `DROP TRIGGER memory_au`                                   | FAILS: `memory_fts names trigger 'memory_au', absent from sqlite_master`                                                     |
| `EXTRACTOR_VERSION` unexported                             | FAILS: `memory_entities names marker EXTRACTOR_VERSION, not exported by any of embeddings/embedder.ts, services/entities.ts` |
| `memory_vec_impostor` (shadow-prefixed, not a real shadow) | FAILS: `unclassified table(s) in the schema: memory_vec_impostor`                                                            |

**The fourth mutation initially did NOT fail**, exactly as task 2.4 anticipated. A
`/^memory_vec_/` prefix rule swallowed the impostor into "derived with its parent" — the
tolerate-extras hole the partition exists to close. Task 2.4's contingency was applied: the
rule is now an **exact shadow-table set per parent**, all three of them, enumerated from a
freshly migrated schema. The accepted cost is that a sqlite-vec release changing vec0's shadow
layout fails here deliberately, so the new set is reviewed and pinned rather than absorbed.

A first draft also added a separate test grepping the migration files for shadow-prefixed
`CREATE TABLE`s. Once the shadow sets became exact that test was redundant — any impostor now
fails the partition itself — so it was removed rather than left as decoration.

### Task 3

- 3.2: the `RENAMED` FROM line matches the published title character for character. The
  published requirement is at `memory-entities/spec.md:478`, not `:454` as the task states —
  a stale line number, the title itself is intact.
- 3.3: the retired claim occurs only at `memory-entities/spec.md:480`. The `Recall@5` hits in
  `retrieval-evaluation/spec.md` are that harness's own committed floor, an unrelated use.
- 7.6: `$33k` and `NoLLMRAG` appear nowhere in any published spec or in this change's deltas.

### 4.3 — test count

1882 → **1887**, +5, matching the five assertions added in 1.2–1.5. Both figures from
`pnpm test` at the repo root.

### Not done

- **5.1–5.5 (Docker smoke) NOT run.** `dev:docker:up` wipes `data-dev`, which holds the
  2055-row corpus the operator asked to keep for device testing. This change's only artifact is
  a schema-reading test — it adds no migration, no repository, no runtime module (4.8 confirms
  `apps/server/src/db/` is untouched) — so the regression floor the smoke provides is narrow
  here, but it is still unverified and recorded as such.
- **4.4 (`pnpm run eval`) deliberately not run**, per the task's own reasoning: nothing under
  `src/test/retrieval/` was touched.
