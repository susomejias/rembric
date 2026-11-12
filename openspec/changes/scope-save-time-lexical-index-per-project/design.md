## Context

After PR #469 (change `prune-common-terms-from-save-time-match`), the save-time lexical pass makes two reads, both over the global `memory_fts`:

1. **The pruning read.** It looks up each token's document frequency in `memory_fts_vocab` and counts every `memory` row as the total.
2. **The candidate statement.** It runs

   ```sql
   SELECT … FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
   WHERE memory_fts MATCH ? AND <saving project> AND m.status = 'active' …
   ORDER BY bm25(memory_fts) LIMIT 20
   ```

That change's design D7 left this open. The statement still walks the kept tokens' postings in every project, and both reads count every project's documents. Only a per-project index ("E2") was near-flat, and it changes bm25 scores. The owner asked for the options to be measured before anything is built.

`memory_fts` has three readers:

- save-time detection (`searchBm25Candidates`);
- interactive search, both the single-project and the widened multi-project lexical branch (`searchBm25Ids`);
- the relevance gate's term statistics (`adminDocumentCount`, `adminQueryTermFrequencies`).

The dashboard's unscoped search (`adminSearchFts`) and the query-tokenising temp table also depend on it, because they derive their tokenizer arguments from `memory_fts`'s DDL.

Constraints:

- **Derived tables:** a derived table must be reproducible by a pinned recipe, and the invariants suite classifies every table in `sqlite_master`. That requirement is in `persistence`: "Every derived table MUST be reproducible from source tables by a pinned recipe".
- **Sync by triggers:** "FTS5 sync SHALL be implemented via SQL triggers on the `memory` table".
- **Migrations:** the migration runner applies only static `.sql` files.
- **Project ids:** they are ULIDs (`ProjectsService.create`) or, for the default project made by migration 0031, 26 lowercase hex characters. Projects are archived, never deleted.

## Goals / Non-Goals

**Goals:**

- Choose one index shape for which the save-time lexical cost depends on the saving project's size, not on other projects' rows. The choice rests on measurements, each from a named instrument.
- State each option's effect on fidelity, migration, upgrade risk, storage and write cost.

**Non-Goals:**

- Phase 1 writes no migration and changes no production code. The prototypes live only under `measurements/`.
- Changing `memory.search`. Option (a) measures it; a search change would be its own change, with its own retrieval re-baseline.
- Changing `COMMON_TERM_DOCUMENT_RATIO`, `LEXICAL_CANDIDATE_FLOOR`, `CANDIDATE_POOL_SIZE` or the reported `similarity`.

## Options and measurements

**Corpora.** The skewed generator and the skewed realistic control, the same ones #469 used (`measurements/corpora.mts`). Six projects; the measured project holds 2%, 20% or 60% of the rows.

**Shapes.** Every shape keeps #469's `ORDER BY bm25(...) LIMIT 20` and its pruning.

- **(d) Status quo after #469.**
- **(a) E2 for save and search.** One FTS5 table per project. A widened search unions the tables, and the relevance gate sums their vocabularies.
- **(b) E2 for save-time only.** The same tables, with the global `memory_fts` kept for search. Pruning statistics come from the project's own table. "bG" is the same table pruned with global statistics; it isolates the effect of the statistics source.
- **(c) E1.** One table with a fourth `project_id` column, queried as `{content tags title} : (expr) AND project_id : "<id>"`.

The prototype DDL is in `measurements/prototype.mts`.

### Save-time statement and pruning read, 50 000 rows

The instruments are separate, so neither table adds them together:

- **Statement:** `options.txt`, p50 of 3 repetitions per probe, then p50 over 10 probes. Pruned expression.
- **Lookup:** `options.txt`, the pruning read alone, same scheme.

| corpus    | share | statement (d) | statement (b) | statement (c) | lookup global (d, c) | lookup project (b) |
| --------- | ----- | ------------- | ------------- | ------------- | -------------------- | ------------------ |
| generator | 2%    | 1.92 ms       | 0.09 ms       | 2.50 ms       | 7.64 ms              | 1.04 ms            |
| generator | 20%   | 1.88 ms       | 0.75 ms       | 2.80 ms       | 7.60 ms              | 2.46 ms            |
| generator | 60%   | 1.90 ms       | 1.35 ms       | 2.87 ms       | 7.55 ms              | 5.53 ms            |
| realistic | 2%    | 4.52 ms       | 0.31 ms       | 2.39 ms       | 1.69 ms              | 0.86 ms            |
| realistic | 20%   | 5.38 ms       | 2.68 ms       | 4.33 ms       | 1.37 ms              | 1.17 ms            |
| realistic | 60%   | 8.22 ms       | 8.06 ms       | 8.75 ms       | 1.21 ms              | 1.57 ms            |

**Growth with the index, saving project at 2%** (statement, then lookup, at 1 000, 20 000 and 50 000 rows):

| corpus    | option | statement           | lookup              |
| --------- | ------ | ------------------- | ------------------- |
| generator | (d)    | 0.11, 0.92, 1.92 ms | 0.23, 3.07, 7.64 ms |
| generator | (b)    | 0.08, 0.04, 0.09 ms | 0.10, 0.13, 1.04 ms |
| realistic | (d)    | 0.14, 1.95, 4.52 ms | 0.09, 0.71, 1.69 ms |
| realistic | (b)    | 0.06, 0.15, 0.31 ms | 0.07, 0.07, 0.86 ms |

**The fallback expression.** When pruning falls back, the save keeps every token. At 50 000 generator rows and a 2% share, that statement costs 34.70 ms under (d), 1.64 ms under (b) and 18.54 ms under (c).

The lookup is now the larger cost under (d) on the generator. Option (b) shrinks it only because it reads the project's own vocabulary: bG keeps the global read.

The (d) statement figures here are lower than #469's `plans.txt` (2.48 and 7.29 ms). Its probes and runs were different. Compare figures within one file, never across files.

End to end: `save-latency.txt`, a paired `saveMemoryWithCandidates` wall clock comparing (d) and (b). See D2.

### Fidelity of save-time detection

Totals over 2 corpora × 3 sizes × 3 shares, with 10 probes per cell, compared with (d) (`options.txt`):

| option | top-20 ids equal to (d), pruned | post-floor candidates, verbatim probes: lost / gained | prefix80 target surfaced | prefix80 candidates: lost / gained |
| ------ | ------------------------------- | ----------------------------------------------------- | ------------------------ | ---------------------------------- |
| (d)    | —                               | — (generator 147, realistic 368)                      | 71/90 gen, 89/90 real    | —                                  |
| (b)    | 72/90 gen, 79/90 real           | 2 / 124 gen, 0 / 0 real                               | 71/90, 89/90             | 0 / 27 gen, 0 / 17 real            |
| bG     | 84/90, 84/90                    | 1 / 1, 0 / 0                                          | 71/90, 89/90             | 0 / 0, 0 / 17                      |
| (c)    | 88/90, 90/90                    | 1 / 1, 0 / 0                                          | 71/90, 89/90             | 0 / 0, 0 / 0                       |

Where the gains come from:

- **(b)'s 124 generator gains** come from project statistics. In a small project, its own common words are pruned too, so the #469 fallback fires more often and restores the unpruned expression, whose candidates (d) unpruned also finds. The gains are at 1 000 rows (85) and at 20 000 rows with the 2% share (38).
- **The 17 realistic prefix80 gains** come from the table's per-project idf: (b) and bG show the same 17.
- **Targets:** no option lost a target in any cell.

### Behaviour gates

The repository's own eval commands, run on a scratch clone with `measurements/eval-prototype/apply.py`. As the control, the clone with the prototype off reproduces the base byte for byte (`measurements/evals.txt`).

| option | `pnpm run eval:save-time`                                                                                 | `pnpm eval`                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| (a)    | identical except the non-gating ingest series at floor 0.00 (275 → 250 pending rows); 0.60 unchanged (54) | passes, P@8/R@8/MRR@8 unchanged; 47 of 84 id lists change; hybrid returns 145 rows instead of 140 (355 tokens instead of 344) |
| (b)    | same single line as (a)                                                                                   | byte-identical ids                                                                                                            |
| bG     | identical                                                                                                 | byte-identical ids                                                                                                            |
| (c)    | identical                                                                                                 | byte-identical ids                                                                                                            |

### Interactive search under (a)

`search-options.txt`: the statement p50 of 5 repetitions per query, then p50 over the queries. 50 000 rows, with the global statement first and the per-project one second.

| corpus    | scope         | statement        | top-8 identical     | relevance-gate lookup |
| --------- | ------------- | ---------------- | ------------------- | --------------------- |
| generator | 2% project    | 21.22 → 0.57 ms  | 25/28               | 1.69 → 0.88 ms        |
| generator | 60% project   | 29.77 → 16.12 ms | 28/28               | 3.45 → 2.95 ms        |
| generator | widened (all) | 53.47 → 37.74 ms | 13/28               | 3.20 → 4.93 ms        |
| realistic | 2% project    | 4.59 → 0.43 ms   | 24/28               | 0.66 → 0.83 ms        |
| realistic | 60% project   | 11.63 → 10.29 ms | 20/28               | 0.67 → 1.26 ms        |
| realistic | widened (all) | 36.44 → 19.87 ms | 9/28 (overlap 0.71) | 0.72 → 2.57 ms        |

### Storage, build and write cost, 50 000 rows

**Storage** is dbstat page bytes; **build** is a single run. Both come from `options.txt`.

| option               | lexical index storage, generator / realistic | build from populated table |
| -------------------- | -------------------------------------------- | -------------------------- |
| (d) `memory_fts`     | 32.1 / 9.6 MB                                | 801 / 223 ms (`rebuild`)   |
| (a) per-project only | 32.8 / 10.6 MB (replaces `memory_fts`)       | 779 / 224 ms               |
| (b) both             | 64.9 / 20.2 MB (+32.8 / +10.6 MB)            | +779 / +224 ms, once       |
| (c) E1 only          | 32.4 / 9.9 MB (replaces `memory_fts`)        | 781 / 213 ms               |

For scale, the `memory` table is 108.8 / 21.0 MB.

**Write cost** comes from `write-cost.txt`, generator / realistic, p50. The figures are:

- **insert, in-tx:** one `INSERT INTO memory`, timed inside a rolled-back transaction;
- **insert, commit:** the same insert committed on its own;
- **open:** a new connection plus the first prepare, which parses the schema.

| configuration       | insert, in-tx    | insert, commit   | open     | schema objects |
| ------------------- | ---------------- | ---------------- | -------- | -------------- |
| (d)                 | 0.031 / 0.015 ms | 0.102 / 0.063 ms | 0.22 ms  | 112            |
| (b), 6 projects     | 0.077 / 0.042 ms | 0.196 / 0.103 ms | 0.36 ms  | 166            |
| (b), 200 projects   | 0.102 / 0.073 ms | 0.213 / 0.140 ms | 4.15 ms  | 1 912          |
| (b), 1 000 projects | 0.325 / 0.272 ms | 0.552 / 0.390 ms | 42.63 ms | 9 112          |
| (a), 6 projects     | 0.054 / 0.034 ms | 0.133 / 0.077 ms | 0.31 ms  | 163            |
| (c)                 | 0.052 / 0.034 ms | 0.112 / 0.076 ms | 0.25 ms  | 118            |

Creating one project's index (view, table and three triggers) on an existing database takes 0.43 ms at 200 projects and 1.7 ms at 1 000.

## Decisions

### D1 — Recommend option (b): a per-project index for save-time detection only

It is the only measured option that removes the save-time dependence on other projects' rows without moving search results:

- With the saving project at 2%, the statement stays at 0.04–0.09 ms on the generator and 0.06–0.31 ms on the realistic control from 1 000 to 50 000 rows. The pruning read stays at or below about 1 ms.
- The save-time sweep at the shipped floor is unchanged, `pnpm eval` is byte-identical, and every prefix80 target surfaced exactly as under (d).

Its costs are real, and they are the open decisions:

- the lexical index storage roughly doubles;
- every insert pays one more FTS insert plus one `WHEN` check per project;
- the schema grows by nine objects per project.

Alternatives considered:

- **(a) E2 for both paths.** It saves (b)'s storage and makes small-project search 10–37× faster, but:
  - it moves 47 of 84 retrieval id lists;
  - widened search keeps only 9–13 of 28 top-8 lists, because each table's bm25 scores sit on their own idf scale and are merged by raw rank;
  - it makes the widened relevance-gate read 1.5–3.6× slower;
  - the dashboard's unscoped search, `memory_fts_vocab` and the query tokenizer's DDL derivation would all need replacements.

  Rejected for this change. It can follow as its own search change once (b)'s machinery exists, gated by a retrieval re-baseline.

- **(c) E1.** It is never cheaper than (d) for the pruned statement on the generator (2.50 against 1.92 ms at 2%), and it leaves the pruning read global. Every row gains one token of length, which shifts bm25's length normalisation. Rejected again, as in #469.
- **(d) Status quo.** Exact and free, but the 2% project's lookup grows from 0.23 to 7.64 ms on the generator, and the statement from 0.11 to 1.92 ms. Kept as the fallback if the owner declines (b)'s costs.
- **bG** (per-project table, global pruning statistics). The statement is the same as (b)'s, but it keeps the 7.6 ms global lookup. Rejected.

### D2 — End-to-end figure

`save-latency.txt`: a paired `saveMemoryWithCandidates` wall clock, with (d) against (b) and a (d)-against-(d) noise band. 200 rounds, no embedder.

**p50, saving project at 2%**, (d) → (b), at 1 000, 20 000 and 50 000 rows:

| corpus    | 1 000       | 20 000       | 50 000        |
| --------- | ----------- | ------------ | ------------- |
| generator | 9.46 → 9.31 | 12.16 → 7.61 | 20.62 → 10.11 |
| realistic | 1.56 → 1.35 | 3.52 → 1.26  | 8.02 → 2.57   |

**Paired median difference (b − d) at 50 000 rows**, by share:

- generator: −11.16 ms [−11.94, −9.73] at 2%, −8.17 at 20% and −3.10 at 60%;
- realistic: −5.33 [−5.57, −5.08] at 2%, −3.19 at 20% and −0.83 at 60%.

**Noise band:** every (d)−(d) interval lies within [−0.20, 0.60] ms. Every (b) − (d) interval at 20 000 and 50 000 rows lies outside it.

**Caveat:** the per-project triggers are installed in every arm, so these figures EXCLUDE (b)'s extra write. `write-cost.txt` measures that write separately: about +0.05 ms per insert in a transaction, and +0.04 to +0.09 ms committed, at 6 projects.

### D3 — No static SQL migration; a boot reconciler is the migration and the reproduction path

A `.sql` migration cannot loop over projects. The DDL therefore lives in one module (`project-lexical-index.ts`), which has two parts:

- **`projectLexicalIndexDdl(projectId)`:** the view, the table and three triggers. This DDL is the recipe.
- **`reconcileProjectLexicalIndexes(raw)`:** runs in `createDb` right after `migrate` and before serving, under the same `BEGIN IMMEDIATE` discipline. For each project whose objects are missing, or whose stored `sqlite_master.sql` differs from the compiled DDL, it drops and recreates them and runs `'rebuild'`. A recipe change in a later release is therefore detected without a version marker: "the DDL is the recipe".

`ProjectsRepository.create` runs the same DDL inside the project-creating transaction; an empty table needs no rebuild. The default project created by migration 0031 is covered by the reconciler.

Alternatives considered:

- **Lazy creation on first save.** It puts DDL on a request path. Rejected.
- **A registry table mapping project to table name.** A deterministic name needs no registry (D4).

### D4 — Table name from the project id

The table is named `memory_fts_p_` followed by `lower(project_id)`, after the id is checked against `^[0-9a-z]{26}$`. Both id formats in use are 26 alphanumeric characters.

Alternatives considered:

- **`projects.rowid`.** VACUUM may renumber rowids on a table without an `INTEGER PRIMARY KEY`. Rejected.
- **Quoting arbitrary ids.** No need, since the ids are already constrained.

### D5 — Routing by per-project triggers, not by application code

The persistence spec requires trigger-maintained FTS. The per-project `WHEN` triggers satisfy it with no spec amendment. Their cost grows with the project count (write-cost table). A repository-maintained write would keep the insert cost flat, but it needs a persistence amendment and gives up the transactional guarantee the triggers carry. That is an open decision for the owner.

### D6 — Spec placement and archive order

The two #469 requirements are not archived yet. They name the opposite behaviour: statistics over "every indexed row", and scores "exactly those of default bm25 over the whole index". This change therefore states its rule as an ADDED draft. Once #469 archives, the delta becomes MODIFIED of those two requirements. That keeps both the archive order and the MODIFIED-replaces-wholesale rule correct.

The derived-classification requirement gains a name-pattern rule, so that tables created per project are classified without listing each one.

## Risks / Trade-offs

- **[Risk] Many projects make every write and every schema parse slower.**
  - At 1 000 projects: insert 0.33 ms in a transaction, connection open 42.6 ms, 9 112 schema objects.
  - Creating a project changes the schema, so every connection re-parses it on its next statement.
  - → Mitigation: the owner sets a supported project-count envelope, or chooses repository-maintained routing (D5). The dashboard should show the object count.
- **[Risk] The upgrade builds every project's index once at boot.** That took 779 ms at 50 000 generator rows. The WAL grows by about the new index's size (32.8 MB).
  - → Mitigation: it runs before serving, as migrations do. Phase 2 measures it on a populated upgrade test.
- **[Risk] A rollback to an older release leaves the per-project triggers firing.** They keep maintaining tables that nothing reads. This is harmless but costs writes.
  - → Mitigation: Phase 2 documents the cleanup SQL that drops `memory_fts_p_%` objects.
- **[Trade-off] Per-project idf changes which rows enter the 20-row pool.** Accepted because:
  - `similarity` is token containment and does not depend on bm25;
  - the sweep at the shipped floor is unchanged;
  - no target was lost in any measured cell.
- **[Trade-off] Small projects fall back to the unpruned expression more often.** In a small project, its own common words are pruned too. This finds more candidates (124 on the generator), at a cost that stays bounded by the project's size.
- **[Trade-off] The lexical index storage roughly doubles.** Accepted only if the owner agrees (Open Questions).

## Migration Plan

Phase 2, after owner approval:

1. Rebase on #469's archive. Rewrite the spec deltas as MODIFIED (D6).
2. Add `project-lexical-index.ts` (DDL, reconciler, name function), with RED tests first:
   - triggers keep a project table equal to its view after insert, purge and tag update (`integrity-check` plus a match probe);
   - the reconciler recreates a missing or drifted object and is a no-op otherwise;
   - creating a project creates its index in the same transaction.
3. Call the reconciler from `createDb` after `migrate`. Classify `memory_fts_p_%` objects by pattern in the schema inventory and the invariants suite.
4. Switch `searchBm25Candidates` and the pruning read to the project's table and statistics.
5. Gates:
   - `pnpm run eval:save-time`, which must match `measurements/evals.txt` for (b);
   - `pnpm eval`, byte-identical;
   - the paired save latency;
   - an upgrade test on a populated 50 000-row copy, measuring boot time and WAL growth;
   - `scripts/mutate.mjs` on the routing `WHEN`, the reconciler drift check and the project filter.
6. **Rollback:** revert the release, then optionally run the documented `DROP` of `memory_fts_p_%` objects. No source data is touched.

## Open Questions

- **Accept per-project idf for the save-time pool?** It is measured as harmless at the shipped floor, but it is a behaviour change.
- **The routing mechanism:** per-project triggers, which are spec-compliant and whose cost grows with projects, or a repository-maintained write, which stays flat but needs a persistence amendment? What project count must be supported?
- **The storage cost:** accept roughly 2× the lexical index, +32.8 MB at 50 000 generator rows?
- **Search:** follow up later with option (a) for search (small-project search 10–37× faster), as its own change with a retrieval re-baseline?
