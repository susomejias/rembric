## Context

This change publishes no behaviour. It exists to move two conclusions out of a running Rembric instance and into the repo, and to publish the one durable property that makes both of them structural rather than a matter of taste.

**Conclusion 1 (the investigation).** Rembric should not build a GraphRAG-style retrieval layer — an LLM-constructed entity/relation graph with community summaries, queried by traversal.

**Conclusion 2 (the benchmark, 2026-07-29, real `extractEntities` and the real in-process embedder).** The two cheap variants that look like "GraphRAG without the LLM" were measured on this codebase and both failed: a deterministic entity co-occurrence graph is empty, and widening `include_relations` to all six edge kinds saturates its own budget against zero recall headroom.

There is no `docs/adr/` in this repo. The archived change folder is the decision-record slot, and `pnpm run check:spec-provenance` is CI-gated so published spec text can only arrive by archiving a change — one folder therefore carries the record and the requirement together, which is the reason this is a change at all and not a doc commit.

### Evidence labelling used throughout

Every figure below carries one of four labels. A decision record that overstates its evidence is worse than none.

| label                | meaning                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **[verified]**       | Checked against this repo's committed files while writing this design.                                                                  |
| **[measured]**       | Produced by the 2026-07-29 benchmark run on this codebase; not re-run here.                                                             |
| **[cited]**          | From a named external source, taken from the prior investigation, not re-fetched in this session. arXiv id given so a reader can check. |
| **[owner-reported]** | Stated by the owner about their own instance; not reproducible from the repo.                                                           |
| **[unverified]**     | Source could not be confirmed. Never to be restated as fact.                                                                            |

## Goals / Non-Goals

**Goals:**

- Publish the property that caused the rejection, in a form that outlives any technique name and that any future LLM-built index fails automatically.
- Give that property an enforcement point that can fail, or state plainly that it cannot.
- Draw its boundary precisely enough that agent-authored text (`memory.content`, `sessions.summary`, `confirmations.reason`, `memory_relations.reason`) is unambiguously outside it.
- Repair the existing negative requirement's two real defects — an expiring title and an uncheckable citation — without discarding its sound conclusion.
- Record the research with its sources, its numbers, its inferences, and its falsifiers, so the next contributor can re-open the question on evidence instead of re-doing the investigation.

**Non-Goals:**

- Re-arguing the verdict, or proposing any GraphRAG variant.
- An absolute prohibition on a language model in the server. See D6: the owner's position is that it is negotiable against measured evidence, and a requirement written as a veto would misrepresent that.
- Query telemetry. It is the missing instrument and it is named as a falsifier (D7); building it is its own change.
- Repairing `schema-drift.test.ts::EXPECTED_TABLES`, which is missing `memory_replaces` and `prompts_fts` **[verified]**. Named in D3 and deferred in `tasks.md` — the new registry covers the same gap from a stronger angle, and folding a drift-test repair into a spec-publication change confuses two things.
- Re-stating the sibling change `order-relation-annotations`. Its D5 owns the `include_relations` widening rejection with the full numbers; this design points at it.

## Decisions

### D1. The invariant is the closure property, not a verdict on a technique

Published requirement (full text in `specs/persistence/spec.md`): a derived table's contents SHALL be determined by exactly two inputs — (a) the current rows of the source tables it derives from, and (b) a recipe pinned in the shipped image and identified by a version marker on disk where the recipe can change between releases. No third input: no network call, no external service, no operator-supplied text, no value that is not reproducible from (a) and (b), and no state accumulated from the derived table's own history.

Why this rather than "GraphRAG MUST NOT be built":

1. **It does not age.** A verdict about a named technique is dead the moment the technique is renamed, and re-litigating it costs the next reader the whole investigation. The property is a statement about this database, checkable without knowing what is fashionable.
2. **Any LLM-built index fails it automatically**, because the index's contents are not a function of (a) and (b). This is not a rhetorical move — it is the concrete reason the layer would hurt: after a restore the index could not be rebuilt, its drift could not be detected, and a bad extraction could not be corrected retroactively over an established corpus, which is precisely the guarantee `memory-entities`' recipe-version requirement exists to provide.
3. **It is already true, in five places, and stated as one thing nowhere.** **[verified]** all of the following:

   | derived table(s)                                               | derives from                      | reproduction mechanism                                                                                                                                          | recipe marker                                    |
   | -------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
   | `memory_fts` (+ shadow tables)                                 | `memory.content`/`tags`/`title`   | external-content FTS5 (`content='memory'`); one built-in statement `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`, used by migrations `0016` and `0020` | none needed — the triggers _are_ the recipe      |
   | `prompts_fts` (+ shadows)                                      | `prompts.content`/`tags`          | external-content FTS5 (`content='prompts'`, `0009`), same built-in rebuild                                                                                      | none needed                                      |
   | `memory_replaces`                                              | `memory.replaces`                 | three triggers on `memory`; migration backfill `SELECT je.value, m.id FROM memory m, json_each(m.replaces) je`                                                  | none needed                                      |
   | `memory_vec`                                                   | `memory.title` + `memory.content` | boot-time `ensureVectorModel` reset + `EmbeddingWorker` resumable drain                                                                                         | `EMBEDDING_MODEL_ID` + `EMBEDDING_INPUT_VERSION` |
   | `memory_entities`, `memory_entity_links`, `memory_entity_scan` | `memory.title` + `memory.content` | `resetEntityIndex` / `ensureEntityExtractor` + backfill drain + on-demand dashboard rebuild                                                                     | `EXTRACTOR_VERSION`                              |

   Five existing requirements each say "this one is derived" (`persistence` at the FTS/vec sync requirement, the `memory_replaces` requirement, "The entity tables MUST be declared derived, never primary"; `memory-entities` at the rebuildability and recipe-version requirements). None obliges a _new_ table to be. The generalisation is the whole point.

**The embedder is admitted, and the phrasing has to earn that.** `memory_vec` is model output, so a requirement worded "no model output" would forbid what ships today. The distinction that survives is reproducibility, not model class: `EMBEDDING_MODEL_ID`, `EMBEDDING_MODEL_REVISION` (pinned HF revision), `EMBEDDING_DTYPE`, `EMBEDDING_DIMS` and `EMBEDDING_INPUT_VERSION` are all constants in the shipped image, and the identity is recorded on disk **[verified]** — so the vector is a fixed function of the memory row. A generative model whose output varies across identical inputs, or whose weights are not in the artifact, is not.

**What the requirement does _not_ claim: bit-exactness.** A quantised ONNX model on a different CPU may differ in the low bits of a float. The requirement is therefore about the _inputs_ a recipe may consume, not about byte-identical output. The byte-equality scenario is confined to the exactly-reproducible indexes (`memory_fts`, `memory_replaces`, the entity tables); for `memory_vec` the claim is "re-derivable from the memory rows by the pinned recipe", which is what the existing backfill requirement already asserts. Stating this limit is the difference between an assertable requirement and an overclaim.

_Alternatives._ **"GraphRAG MUST NOT be built"** — rejected above. **"No language model in the server"** — rejected on D6: it is not the owner's position, and a requirement that misstates the position gets ignored rather than followed. **"Every derived index SHALL be deterministic"** — too weak to bite: an LLM at temperature 0 behind a cache is arguably "deterministic" while still failing every guarantee the property exists to give. The two-input closure form is what excludes it.

### D2. `persistence` owns it

Four capabilities were candidates. `persistence`' purpose line is "the storage substrate … schema management via Drizzle ORM, idempotent migrations, virtual-table sync, append-only invariants at the schema layer, and portable backups" **[verified]** — and it already contains every per-table derived-data requirement the new one generalises. A reader wondering "may this new table be populated by X?" looks at the capability that governs tables.

_Alternatives._ **`retrieval-evaluation`** — rejected: it governs the harness. Its `:11` clause ("no language model participates in ingestion, retrieval, or grading" **[verified]**) is about the _instrument_, and a storage rule restated there would be a second copy free to drift from the first. It is cited by the new requirement, not duplicated into it. **`data-access`** — rejected: it governs where SQL may execute and which method families may be called from where. Orthogonal axis; a derived-table rule there would be findable only by accident. **`memory`** — rejected: behavioural capability, and no read or write behaviour changes. **A new capability** — rejected: one requirement does not earn a capability, and a new home would orphan the five existing derived-table requirements from the rule that generalises them.

### D3. It is assertable, by a registry — and the part that is not, is labelled as review-only

Three of the requirement's clauses are automatable and one is not. Both facts are stated in the spec rather than papered over with a scenario that cannot fail.

**Automatable — a source/derived table registry in `apps/server/src/test/invariants.test.ts`:**

- Every table in the migrated schema is classified `source` or `derived`. Completeness is asserted against `sqlite_master` over a freshly migrated temp database, **not** against a hand-maintained expected list. This is the load-bearing choice: `schema-drift.test.ts` deliberately tolerates extra tables (FTS5/vec0 shadow-table sets vary by extension version), so it is structurally incapable of noticing an unclassified table — its own spec requirement says as much, and its `EXPECTED_TABLES` is today missing `memory_replaces` and `prompts_fts` **[verified]**, which is exactly that failure mode already realised. A `sqlite_master`-driven partition has no such hole: a migration that adds a table and does not classify it fails.
- Each `derived` entry names its reproduction mechanism, and the test asserts the named mechanism still exists — the trigger name in `sqlite_master`, or the exported rebuild entry point in the file the entry names (`resetEntityIndex`, `ensureVectorModel`). This is the "allow-list anchors" idiom the suite already uses to stop a purge `DELETE` being silently removed from an allow-listed repository **[verified]**, applied to rebuild paths.
- Each `derived` entry whose recipe can change between releases names its version-marker constant, and the test asserts that constant is exported. `EXTRACTOR_VERSION` and `EMBEDDING_INPUT_VERSION` are the two.

The registry is also the requirement's documentation: it is the first place the whole derived set is written down as a set, which is what the change is for.

**Not automatable — the third-input clause.** No test can decide whether a table's contents depend on something outside (a) and (b); that is a property of a proposal, not of a schema. The requirement therefore expresses it as a review gate with a checkable shape: a change introducing such a table must first amend this requirement, so the check is "does the change carry a delta to it?" — yes or no, visible in the diff, and `check:spec-provenance` already forces published spec text through an archived change. The spec says this is a review gate. It does not dress it as a test.

_Alternatives._ **Leave the requirement review-only** — rejected: an unassertable requirement in a repo whose invariant tests are sacred reads as decoration, and the registry is cheap. **Extend `EXPECTED_TABLES`** — rejected: tolerating extras is deliberate and correct there for shadow tables; the fix belongs in a test whose assertion is a partition, not a subset. Repairing the two missing entries is deferred (`tasks.md` §5) rather than folded in. **Assert byte-identical rebuild for all seven derived tables** — rejected on the `memory_vec` float caveat in D1; asserted only where it is true.

### D4. The boundary: derived iff dropping it loses no information

The requirement reaches only derived tables, and the test of derivedness is stated positively: a table is derived if and only if its full contents are recomputable from other tables in the same database. Consequences, spelled out in the requirement because leaving them to inference is how it gets misread as forbidding half the product:

- `memory.content` and `memory.title` — agent-authored, irreproducible, **source**. The corpus is the thing everything else derives _from_.
- `sessions.summary` — agent-authored prose, **source**. Nothing recomputes it.
- `confirmations.reason` and `memory_relations.reason` — agent-written justification attached to a judgment, **source**. The `reason` on a judged relation is the densest signal in the graph (D5 below leans on it), and it exists nowhere else.
- `consolidation_ops` / `consolidation_runs` — the process's own history, **source** by the same test: an op journal cannot be recomputed from the state it produced, which is the whole point of a reversible journal.

The requirement forbids non-reproducible input to a **derived index**. It says nothing about what an agent may write into a source table, and the spec text makes that explicit.

This is the storage-layer sibling of the "review state is derived, never stored" invariant, which is the same idea one layer up: `reviewState` is computed at read time from `confirmations` rather than persisted. Cross-referenced rather than merged — one is about columns that must not exist, the other about tables that must be rebuildable.

### D5. The verdict, and the three reasons in weight order

Recorded so it is not re-litigated from scratch, and so a future proposal knows which reason it has to beat.

**Reason 1 — scale. The corpus fits in context, so the problem GraphRAG solves does not exist here.** GraphRAG exists because ~1M-token corpora cannot be read whole **[cited]** (arXiv 2404.16130). A Rembric project corpus is three orders of magnitude smaller. The owner's instance reports 160 memories — 99 active / 51 superseded / 10 archived **[owner-reported]**; the eval harness returns roughly 62 tokens per memory, which is arithmetic from the sibling change's committed measurement of 39,019 chars across 158 result rows (≈247 chars/row, ≈4 chars/token) **[measured, derived]**. Full content runs larger than the returned projection, putting an active project corpus at roughly 20–35k tokens **[owner-reported, order-of-magnitude]**. The agent can read the whole thing. Every mechanism GraphRAG adds is a mechanism for not reading the whole thing.

**Reason 2 — query class. The dominant query class is the one plain RAG wins.** GraphRAG-Bench measures plain RAG _winning_ fact retrieval at 60.9% against 36.9–60.14% for graph methods, with the graph ahead only on complex reasoning and summarisation **[cited]** (arXiv 2506.05690). Mem0 is the closest analogue by domain — agent memory, not document QA — and its graph variant _loses_ on single-hop (65.71 vs 67.13) and multi-hop (47.19 vs 51.15), at roughly 2× search latency (p95 0.657s vs 0.200s) and 2× tokens **[cited]** (arXiv 2504.19413). A coding agent's traffic is dominated by fact retrieval ("what did we decide about X", "where is Y configured"), which is the class the graph does not win.

**Reason 3 — unmeasurable today, so it could not be justified even if it were right.** Three separate blocks, all **[verified]** in this repo:

- **The discriminating metric is saturated.** `baselines/hybrid.json` records `ceilings.recallAtK = 1` at both k=5 and k=8, with committed floors R@5 0.91875 / R@8 0.95 / MRR 0.7333 — floors set at measured − 0.05, so measured recall@8 is 1.000 against a ceiling of 1. There is no recall to buy.
- **The gold set contains no query of the class the graph wins.** All 24 committed queries in `test/retrieval/queries.ts` are typed: `abstention` 8, `extraction` 4, `knowledge-update` 3, `preference` 3, `cross-scope` 2, `multi-session-causal` 2, `temporal` 2. Zero global-sensemaking or summarisation queries. A graph retriever would be scored entirely on the class it loses.
- **There is no query telemetry anywhere in the server.** A grep for `telemetry` / `queryLog` / `query_log` / `searchLog` / `recordQuery` across `apps/server/src` returns nothing. "Does multi-hop traffic actually arrive?" has no empirical answer, and cannot acquire one without building the instrument first.

**Cost and architecture, as a supporting reason rather than a fourth one.** **[cited]** throughout: LazyGraphRAG is still not open source — the promised Q1–Q2 2026 window has passed (microsoft/graphrag discussion #1490); Microsoft shipped it through Microsoft Discovery and Azure Local instead. Every practical OSS implementation is Python plus an external store: `fast-graphrag` (Python ≥3.10, MIT, **requires `OPENAI_API_KEY`** — a widely-cited blog claiming it uses spaCy/NLTK noun phrases is wrong, checked against its README), `nano-graphrag` (~1100 LOC, LLM extraction), LightRAG (~114× tokens vs vanilla, arXiv 2410.05779), HippoRAG and HippoRAG 2 (LLM OpenIE at index time, arXiv 2405.14831 / 2502.14802), Graphiti/Zep (**Neo4j ≥5.26**, one LLM call per ingested episode, arXiv 2501.13956). Rembric is one Node process over one SQLite file with a baked offline model, so adopting any of them means a Python sidecar and a second datastore. RAPTOR is not a shortcut either: E2GraphRAG measures it as the most efficient but among the _worst_ in effectiveness, ≈−8% **[cited]** (arXiv 2505.24226).

### D6. The two cheap variants were measured on this codebase, and both failed

The variants that look like "GraphRAG without the LLM" are the ones a future reader will reach for first, so their numbers are recorded here rather than left to be re-derived. Both **[measured]**, 2026-07-29, real `extractEntities` and the real embedder.

**Variant A — a deterministic entity co-occurrence graph.** On the 40-item committed eval corpus (**[verified]**: `CORPUS` has 40 items), **2 of 40 memories extract any entity at all, producing 0 edges**. On 10 real production memories: 7 of 10 have entities, 25 entity links, 22 distinct entities, and exactly **1** shared entity — **1 edge**.

The cause is structural, not a tuning miss. The 12 `ENTITY_KINDS` are _addresses_, not concepts — `path`, `git_ref`, `url`, `error_code`, `ticket`, `cve_id`, `ip_address`, `hostname`, `env_var`, `uuid`, `systemd_unit`, `mac_address` **[verified]** — and `services/entities.ts:5-7` states that symbol identifiers, package names, semver strings, Docker image references and cron expressions are _deliberately_ absent because none can be bounded without matching prose **[verified]**. Two memories about the same decision rarely share an address. Loosening the extractor to make the graph dense is the same trade the `memory-entities` capability already refused on precision grounds ("a false entity link degrades exact lookup into bad text search, which is worse than missing a real one" **[verified]**).

**The judgment graph is the denser one, and it already exists.** Over the same 10 production memories the judgment graph carries 10 internal edges — roughly 10× the entity graph — and each carries an agent-written `reason` **[measured]**. Whatever a co-occurrence graph was meant to supply, `memory_relations` supplies more of, with justification attached, produced under fresh context by the agent that saw both memories. That is the architectural conclusion worth keeping: Rembric's graph is judged, not extracted.

**Variant B — widening `include_relations` to all six edge kinds.** Rejected on measurement; the numbers and the full argument live in the sibling change **`order-relation-annotations`** (its D5 and §6.1), which is validated and unarchived. Summary only, so the two do not drift: 3 kinds → 32 expansion rows / 15 of 24 queries / +11.5% payload; 6 kinds → 108 rows / **24 of 24** queries / **+62.4%**, saturating the cap-5 budget on every query against zero recall headroom, with `related` at 82% of a production-shaped drained graph. The only thing that survived from that investigation is the truncation-ordering defect it exposed, which is what `order-relation-annotations` fixes. Neither change depends on the other.

### D7. The no-LLM property is negotiable against measured evidence — and the requirement must not read as a veto

**The owner's standing position, recorded because it changes how a future proposal must be framed:** enabling a language model in the server is acceptable _if_ a drastic, demonstrated improvement justifies it.

So the no-LLM posture is not an absolute veto. It is a very high evidentiary bar. The practical consequence is a rule about argument, in both directions:

- A future proposal for an LLM-built index must be argued **with numbers on the harness**, not dismissed by citing this invariant. Citing the invariant is an answer to "may I skip the measurement", not to "here is the measurement".
- Equally, the invariant is not satisfied by enthusiasm. The published requirement's escape hatch is amendment: a change that needs a non-reproducible derived index amends the requirement in the same folder as its evidence, which is exactly the shape `memory-entities`' existing "SHALL require a measured improvement on the evaluation harness, recorded in a dedicated change" already uses.

Four invariant collisions such a proposal would have to address, all **[verified]** as currently-published positions:

1. It would be the **first derived index not reproducible from `memory`** — the property D1 publishes.
2. It reverses `openspec/changes/archive/2026-06-05-remove-llm-consolidation/`, whose stated Why is "the server stops reasoning entirely — intelligence lives in the connected agents, the server stays a deterministic SQLite + HTTP process", and which removed an LLM provider, an API key and a cron as three external requirements.
3. It ends the posture in `README.md:233`: "no external services, no API keys, no network calls — … works out of the box on an air-gapped box."
4. It violates `openspec/specs/retrieval-evaluation/spec.md:11`, which forbids a language model in ingestion, retrieval or grading — i.e. it breaks the contract of the very instrument that would have to judge it. This is the sharpest of the four: the harness cannot grade a change that requires disabling the harness's own determinism clause, so a proposal has to say what instrument it will be judged by.

### D8. Falsifiers — what would reopen this

Named so re-opening is a matter of observation rather than argument. Any one of these makes the decision stale:

1. **An active per-project corpus above roughly 5–10k memories** (≈0.5M+ tokens), where the corpus no longer fits in an agent's context. This is Reason 1 expiring, and it is the most likely of the three to expire.
2. **Query telemetry showing real sensemaking or multi-hop traffic.** This is Reason 3's missing instrument. Note the ordering: the telemetry is a prerequisite for re-opening, not part of it — until it exists, "agents ask multi-hop questions" is a hypothesis.
3. **LazyGraphRAG, or an equivalent, shipping open source with LLM-free indexing.** This would collapse the cost reason and, depending on how "LLM-free" it turns out to be, might also satisfy D1's closure property — in which case the invariant does not forbid it at all, which is the point of stating a property rather than a verdict. `Democratizing GraphRAG` (arXiv 2602.23372) is the nearest published direction: no LLM at index time, an entity-document co-occurrence graph, sparse Personalized PageRank — **[cited, PDF read]**, though its numbers and code release were not extractable. Its co-occurrence substrate is the one Variant A measured as empty on this corpus, so it does not transfer as-is.

### Sources

Per-source verification status. The two flagged items must never be restated as fact.

| source                                                                       | status                                                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| arXiv 2404.16130 — Microsoft GraphRAG                                        | **[cited]** — the ~1M-token motivation                                                                                                               |
| arXiv 2410.05779 — LightRAG                                                  | **[cited]** — ~114× tokens vs vanilla                                                                                                                |
| arXiv 2405.14831 / 2502.14802 — HippoRAG 1 / 2                               | **[cited]** — LLM OpenIE at index time                                                                                                               |
| arXiv 2501.13956 — Zep / Graphiti                                            | **[cited]** — Neo4j ≥5.26, one LLM call per ingested episode                                                                                         |
| arXiv 2506.05690 — GraphRAG-Bench / When to use Graphs in RAG                | **[cited]** — plain RAG 60.9% vs 36.9–60.14% on fact retrieval; graph ahead only on reasoning/summarisation                                          |
| arXiv 2504.19413 — Mem0                                                      | **[cited]** — graph variant loses single-hop 65.71 vs 67.13, multi-hop 47.19 vs 51.15, ~2× latency/tokens                                            |
| arXiv 2505.24226 — E2GraphRAG                                                | **[cited]** — RAPTOR most efficient, among worst in effectiveness (≈−8%)                                                                             |
| arXiv 2602.23372 — Democratizing GraphRAG                                    | **[cited, PDF read]** — no LLM at index, entity-document co-occurrence graph, sparse Personalized PageRank; numbers and code release NOT extractable |
| Microsoft Research blog — LazyGraphRAG                                       | **[cited]** — announced; not open source                                                                                                             |
| microsoft/graphrag discussion #1490                                          | **[cited]** — the promised Q1–Q2 2026 OSS window has passed                                                                                          |
| `fast-graphrag` README                                                       | **[cited]** — requires `OPENAI_API_KEY`; the spaCy/NLTK-noun-phrase claim circulating in blogs is wrong                                              |
| OpenReview `KIUOtEKzzN` — NoLLMRAG                                           | **[unverified]** — OpenReview returned a verification screen. Do not cite as evidence.                                                               |
| Medium post — "GraphRAG cost cliff", the sole source for "$33k to index 5GB" | **[unverified]** secondary source. The number MUST NOT be stated as fact anywhere.                                                                   |

## Risks / Trade-offs

- [Risk] The published property is read as an absolute ban on a language model in the server, freezing a decision the owner considers negotiable. → D7 is recorded in this design, and the requirement's own text names amendment-with-evidence as the escape hatch rather than presenting itself as a veto. The `memory-entities` requirement already carries the same shape ("SHALL require a measured improvement … recorded in a dedicated change") and is retitled to keep it.
- [Risk] The property is read as forbidding agent-authored text — `sessions.summary`, a judgment `reason`, `memory.content` itself — and a future contributor concludes half the product is non-conformant. → D4's boundary is in the requirement body, not only in this design, with those four cases named explicitly and the source/derived test stated positively ("derived iff dropping it loses no information"). The registry test makes the classification concrete: those tables appear in it as `source`.
- [Risk] The registry becomes a maintenance tax — every migration adding a table now also edits a test. → That is the mechanism, not a side effect: the edit is one line and it forces the classification decision at the moment the table is created, which is the only moment it is cheap. The alternative is discovering an unclassified table after a restore fails.
- [Risk] The registry's completeness assertion trips on FTS5/vec0 shadow tables, whose set varies by extension version — the exact reason `schema-drift.test.ts` tolerates extras. → Shadow tables are classified by prefix as derived-with-their-parent (the existing `SHADOW_TABLE` regex is the precedent), so the partition is over owned tables while remaining a partition. `tasks.md` §2 requires this to be proven by adding a table and watching the test fail, not assumed.
- [Risk] The retitled `memory-entities` requirement loses force because its dramatic original claim ("adding a graph stream _reduced_ the metrics") is replaced by softer external evidence. → The replacement evidence is stronger where it counts: the local measurement (recall@8 = 1.000 against a ceiling of 1) is verifiable in this repo by anyone, and an unverifiable figure is force that evaporates the first time someone looks for it.
- [Trade-off] This change publishes spec text and one test, and no user-visible behaviour. → Accepted. The behaviour it protects is the ability to rebuild every index from the corpus, which is only visible on the day it is needed, and the repo has no other durable slot for the research.
- [Trade-off] The verdict's Reason 1 rests on an owner-reported corpus size that no committed artifact reproduces. → Accepted and labelled. The conclusion does not turn on precision: the argument is three orders of magnitude of headroom, and D8's falsifier (~5–10k memories) is stated so the reason expires observably rather than silently.
- [Trade-off] Recording rejected variants at this length invites a reader to skip them. → Accepted: the two variants are the first two ideas anyone re-deriving this will have, and re-running the benchmark costs far more than reading D6.

## Migration Plan

No migration, no schema change, no trigger change, no marker change, no `EXTRACTOR_VERSION` or `EMBEDDING_INPUT_VERSION` bump, no derived-index invalidation. Nothing in `memory`, `memory_fts`, `memory_vec`, `memory_replaces`, `prompts_fts`, `memory_entities`, `memory_entity_links` or `memory_entity_scan` is read or written by this change.

Deploy is a plain image upgrade. The first boot after it is byte-for-byte the same sequence as the boot before it — the new test runs in CI against a freshly migrated temp database, like its neighbours in `invariants.test.ts`, and never against operator data. Rollback is a plain image downgrade with nothing to undo. No plugin file changes, so none of the four clients needs a release. Published spec text arrives only at archive time, per `check:spec-provenance`.

## Open Questions

1. **Should the registry also assert the reverse direction — that every `source`-classified table is genuinely not recomputable?** _Default: no._ Unrecomputability cannot be tested; asserting it would be the fake scenario D3 exists to avoid. The registry's `source` entries are documentation of a review decision, and the requirement says so.
2. **Should the `derived` entries be moved out of the test into a module the runtime can read, so `memory.doctor` could report per-table rebuild coverage?** _Default: keep it in the test._ A runtime consumer would make it product surface with its own spec obligations, for a report no operator has asked for. Revisit if a rebuild-coverage gap is ever observed in the field.
3. **Should `retrieval-evaluation` gain a query type for the class a graph would win (global sensemaking / summarisation), so a future proposal has something to be measured on?** _Default: not in this change_ — writing gold labels for a class no telemetry shows arriving is speculative corpus work, and it would be the first query type added to defend a hypothesis rather than to score a behaviour. This is genuinely open: a future LLM-index proposal cannot be measured without it, so whoever writes that proposal owns the corpus extension, and D8's falsifier 2 (telemetry) is the trigger that makes it worth writing.
4. **Does the closure property admit a future index built by a pinned, locally-run generative model with fixed sampling?** Argued in D1 that it does not (output not reproducible from the memory rows and a pinned recipe in the sense that matters — a rebuild after restore must agree with what queries were answered against). _Default: treat it as failing the property_, and require the amendment path. Flagged rather than settled because the boundary between "pinned deterministic model" (the embedder, admitted) and "pinned generative model" (excluded) is drawn on reproducibility of output, and a genuinely greedy-decoded local model sits close to that line.
