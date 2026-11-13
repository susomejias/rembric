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
- **Project ids:** they are ULIDs (`ProjectsService.create`) or, for the default project made by migration 0031, 26 lowercase hex characters. Test fixtures insert arbitrary ids (`p0`, `proj1`) directly into `projects`.
- **Project deletion:** the product archives projects and never deletes them. The dev seed's `--reset` (`apps/web/src/scripts/seed-dev.ts`) deletes every project row and inserts a new default project with raw SQL.

## Goals / Non-Goals

**Goals:**

- The save-time lexical cost depends on the saving project's size, not on other projects' rows.
- Phase 1 chose the shape from measurements, each from a named instrument. Phase 2 implements it and re-runs the gates against the shipped code.

**Non-Goals:**

- Changing `memory.search`. Option (a) was measured for it, and it stays out of scope (D1).
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

### D1 — Option (b): a per-project index for save-time detection only (owner decision)

The owner chose option (b), with pruning statistics read from the project's own index rather than the "bG" variant. This accepts three things:

- per-project inverse document frequencies decide which 20 rows enter the pool;
- the lexical-index storage roughly doubles;
- a one-time rebuild runs at the first boot after upgrade.

It is the only measured option that removes the save-time dependence on other projects' rows without moving search results:

- With the saving project at 2%, the statement stays at 0.04–0.09 ms on the generator and 0.06–0.31 ms on the realistic control, from 1 000 to 50 000 rows. The pruning read stays at or below about 1 ms.
- At the shipped floor the save-time sweep is unchanged, `pnpm eval` is byte-identical, and every prefix80 target surfaced exactly as under (d). Phase 2 re-ran these gates against the shipped code (D7).

Option (a), which uses the same machinery for interactive search, stays out of scope. It is a possible follow-up: it would make small-project search 10–37× faster, but it moves 47 of 84 retrieval id lists and needs its own retrieval re-baseline.

### D2 — End-to-end figure

**Phase 1 (`save-latency.txt`).** A paired `saveMemoryWithCandidates` wall clock: 200 rounds, no embedder, (d) against the prototype (b), with a (d)-against-(d) noise band.

p50 with the saving project at 2%, (d) → (b), at 1 000, 20 000 and 50 000 rows:

| corpus    | 1 000       | 20 000       | 50 000        |
| --------- | ----------- | ------------ | ------------- |
| generator | 9.46 → 9.31 | 12.16 → 7.61 | 20.62 → 10.11 |
| realistic | 1.56 → 1.35 | 3.52 → 1.26  | 8.02 → 2.57   |

**Phase 2 (`save-latency-impl.txt`).** The same design, but with the shipped code against the #469 status quo, which is replayed by wrapping the repositories. See D7.

Both files install the per-project triggers in every arm. So neither includes the extra write (b) adds per insert; `write-cost.txt` measures that separately.

### D3 — No static SQL migration; a boot reconciler is the migration and the reproduction path

A `.sql` migration cannot loop over projects. The DDL therefore lives in one module, `packages/db/src/project-lexical-index.ts`:

- **The recipe:** the view, the external-content table and three triggers, built per project. The table carries `memory_fts`'s FTS5 options, read through `inheritedFts5Arguments`.
- **`reconcileProjectLexicalIndexes`:** runs in `createDb` right after `migrate` and before `ANALYZE`, in one `BEGIN IMMEDIATE` transaction.
  - It builds every project's missing index.
  - It drops and rebuilds every index whose stored `sqlite_master.sql` differs from the compiled DDL. A recipe change in a later release, including a change to `memory_fts`'s own options, is therefore detected without a version marker.
  - It drops the objects of every project that no longer exists, such as after the dev seed's `--reset`.
  - On a database that already existed, it logs `project lexical indexes: built N, dropped M (T ms)` when it did any work.
- **`ensureProjectLexicalIndex`:**
  - `ProjectsRepository.insert` calls it in the caller's transaction.
  - The save-time statement and the pruning read call it as a safety net. It covers projects inserted with raw SQL after boot, which happens only in test fixtures and the dev seed.
  - A per-connection cache, filled only outside a transaction, keeps it to zero statements on the hot path. The save-time statement count is therefore unchanged at 8 (`ancestry-statements.test.ts`).
- **Building:** a build inserts the project's rows with the same flattened tags the triggers write. It does not use FTS5 `'rebuild'`, which would read the view's raw JSON `tags`, and FTS5 cannot rebuild from a view that calls `json_each`.

### D4 — Table name: the hex encoding of the project id

The index is named `memory_fts_p_` followed by the lowercase hexadecimal encoding of the id's UTF-8 bytes. `projectIdOfLexicalIndexObject` decodes a name back to the id, which is how the reconciler finds orphans.

Phase 1 proposed `lower(project_id)` behind a `^[0-9a-z]{26}$` guard. Phase 2 replaced it, for three reasons:

- test fixtures and raw inserts use arbitrary ids;
- SQLite identifiers are case-insensitive, so lowercasing is not injective;
- hex is injective and safe for every id, so no guard is needed.

The id still appears as an escaped string literal in the view and trigger `WHEN` clauses. The tests cover an id containing a quote and a space.

### D5 — Routing by per-project triggers (owner decision)

The owner chose SQLite `WHEN` triggers, which satisfy "FTS5 sync SHALL be implemented via SQL triggers" without amending the spec. The owner also chose no hard cap on the number of projects. Instead, the measured cost curve is the supported-scale guidance; see "Supported scale".

### D6 — Spec placement and archive order

The two #469 requirements are not archived yet, and they state the opposite: statistics over "every indexed row", and scores "exactly those of default bm25 over the whole index". This change therefore states its rule as ADDED requirements.

Whichever of the two changes archives second must reconcile the text. If #469 archives first, this delta becomes a MODIFIED of those two requirements. The persistence delta adds the `memory_fts_p_` name-pattern classification.

### D7 — Phase 2 gates against the shipped code

Each gate ran on the Phase 1 corpora, which the base commit built, so every first open is an upgrade.

- **`pnpm run eval:save-time`:** identical to the prototype (b) output. The only difference from the base is the non-gating ingest series at floor 0.00, where pending rows go from 275 to 250. At 0.60 it stays at 54.
- **`pnpm eval`:** passes, with unchanged metrics. The `dump-ids.ts` sha256 is `670ec7c1…`, byte-identical to the base.
- **prefix80 recall (`implementation-gates.txt`):** the source surfaced in 71 of 90 probes on the generator and 89 of 90 on the realistic corpus. That equals the status quo and the prototype. With pruning off on the per-project index the counts are the same, so pruning loses no target.
- **Upgrade (`implementation-gates.txt`), first open at 50 000 rows:** the reconciler took 802 ms on the generator and 230 ms on the realistic corpus. The second open took 41 ms and 4 ms. The first open grew the WAL by 34.5 MB and 10.7 MB.
- **End to end (`save-latency-impl.txt`):** with the saving project at 2%, the p50 goes from 21.13 to 8.92 ms on the generator and from 7.46 to 1.54 ms on the realistic corpus, at 50 000 rows. At 1 000 rows it is 9.36 → 9.35 ms and 1.43 → 1.30 ms. The paired differences at 50 000 rows are −12.75 ms [−13.32, −11.24] and −5.95 ms [−6.19, −5.50]. Every interval at 20 000 and 50 000 rows lies outside the noise band of [−0.30, 0.54] ms.

## Supported scale

With no cap, the cost per project is the guidance. Figures come from `write-cost.txt`, at 50 000 rows, generator / realistic:

| projects | insert, in-tx    | insert, commit   | connection open | schema objects |
| -------- | ---------------- | ---------------- | --------------- | -------------- |
| 6        | 0.077 / 0.042 ms | 0.196 / 0.103 ms | 0.36 ms         | 166            |
| 200      | 0.102 / 0.073 ms | 0.213 / 0.140 ms | 4.15 ms         | 1 912          |
| 1 000    | 0.325 / 0.272 ms | 0.552 / 0.390 ms | 42.63 ms        | 9 112          |

Before this change, the insert cost 0.031 / 0.015 ms in a transaction and the open cost 0.22 ms.

Creating one project adds nine schema objects. It took 0.43 ms at 200 projects and 1.7 ms at 1 000, and the next statement on every connection re-parses the schema.

Up to a few hundred projects, the added cost per save is a fraction of a millisecond. At 1 000 projects, each insert costs about 0.3 ms more and each new connection about 42 ms more. The server holds one long-lived connection.

## Risks / Trade-offs

- **[Risk] Many projects slow every write and every schema parse.** At 1 000 projects: insert 0.33 ms, connection open 42.6 ms.
  - → Accepted (D5): the curve is documented in this design and in `docs/embeddings.md`.
- **[Risk] The first boot after upgrade builds every project's index.** It took 802 ms and added 34.5 MB of WAL at 50 000 generator rows.
  - → It runs before serving, as migrations do. The boot log names its duration.
- **[Risk] A rollback to an older release leaves the per-project triggers firing.** They keep maintaining tables nothing reads. This is harmless, but it costs writes.
  - → `docs/embeddings.md` gives the cleanup: drop every `memory_fts_p_%` trigger, table and view.
- **[Risk] A project inserted with raw SQL after boot has no index until its first save-time read builds one.** Only test fixtures and the dev seed do this.
  - → The read path builds the index first, and the next boot's reconciler covers it too.
- **[Trade-off] Per-project idf changes which rows enter the 20-row pool.** Accepted because:
  - `similarity` is token containment and does not depend on bm25;
  - the sweep at the shipped floor is unchanged;
  - no target was lost in any measured cell.
- **[Trade-off] Small projects fall back to the unpruned expression more often.** In a small project, its own common words are pruned too, so the fallback fires. This finds more candidates (124 on the generator), at a cost bounded by the project's size.
- **[Trade-off] The lexical-index storage roughly doubles:** +32.8 MB at 50 000 generator rows. Accepted by the owner.

## Migration Plan

1. **Deploy:** a normal server release. The first boot runs the reconciler before serving and logs its duration; nothing for the operator to do.
2. **Rollback:** revert the release. Optionally drop the `memory_fts_p_%` objects, using the SQL in `docs/embeddings.md`. No source data is touched.
3. **Archive order:** see D6.

## Open Questions

None. The owner closed them on approval: option (b), SQLite `WHEN` triggers, no project cap, and storage plus per-project idf accepted.
