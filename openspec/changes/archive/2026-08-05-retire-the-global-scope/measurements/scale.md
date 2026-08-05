# `retire-the-global-scope` at production worst-case scale

Status: **measured**. Every figure below was executed on this machine on 2026-08-04; nothing is
extrapolated except the three explicitly-labelled interpolations in [§7](#7-the-verdict-an-operator-needs).

The migration was designed and previously measured against **3 real global rows / 16 enriched**. That
is the gap this document closes. The worst case is not "a big corpus" — it is **a corpus that is
almost entirely global**, which is exactly what an operator who only ever used path-less `/mcp` has.

> **Which figures the shipped migration superseded, and which still stand.** Every table here measures
> variant B with both scratch tables in the **main database**. What ships instead is variant B with them
> as `CREATE TEMP TABLE` and the runner pointing SQLite's temp directory at the database's own — the same
> statements, a different place for the spill. **Superseded: the body wall-clock and every disk figure at
> 200k.** Re-measured through the real runner: body **137–152 s** (not 195.6), db growth **+159 MB** (not
> +943), **freelist 0** (not 791 MB, so the `VACUUM`-afterwards advice largely goes away), WAL peak
> **1543 MB** (not 2267), peak RSS **460 MB** (not 1108) — plus up to **~1.5 GB of transient temp spill in
> the data directory**, which the tables below do not have a column for because the earlier shape spilled
> into the database file instead. **Still standing:** the statement-group breakdown and its shares (§3),
> the `foreign_key_check` scaling curve (§4), the four-shape comparison as a _relative_ ranking (§6), the
> interruption result (§8), and all of §9's correctness. `tasks.md` 15.1a carries the operator-facing
> restatement; §5's peak-demand conclusion (**≈1.4× the database size free, transiently**) survives with a
> different composition — WAL plus temp spill rather than WAL plus permanent growth.

---

## 0. What was built, and why not with `seed-volumetric` as-is

`apps/server/src/scripts/seed-volumetric.ts` cannot produce the worst case: `buildCorpus` hardcodes
`scopeSlot = i % VOLUMETRIC_SHAPE.scopeCount` with `scopeCount: 6` and slot 0 global, so global rows
are always **exactly one sixth** of the corpus. Reaching 200 000 global rows through it would mean a
1.2 M-row corpus, most of it irrelevant to the statements under test.

`measurements/scale-fixture.mjs` therefore re-implements the memories phase with an explicit
global/project split while **importing the same generators** (`generateMemory`, `generateVector`), the
same entity extractor and the same services, so `memory_fts`, `memory_vec`, `memory_entities`,
`memory_entity_links`, `memory_relations` and `confirmations` are all trigger/service-built as in
production. `memory_vec`'s declared width was read off disk, not assumed: `FLOAT[768]`, blobs 3072
bytes (`SELECT sql FROM sqlite_master WHERE name='memory_vec'`, `length(embedding)`).

**Inherited caveat, restated because it bounds what these numbers can support:** the vectors are
deterministic pseudo-random unit vectors, **not embeddings**. No retrieval-quality, ranking, fusion or
abstention claim may be drawn from this corpus. Nothing in this document is such a claim — the claims
are row counts, blob identity, wall-clock and bytes on disk, none of which depend on vector semantics.

|        fixture | `memory` |  global | project (control) | `memory_vec` | `memory_entities` | `memory_entity_links` | `memory_relations` | `confirmations` | `sessions` (NULL `project_id`) |       db |
| -------------: | -------: | ------: | ----------------: | -----------: | ----------------: | --------------------: | -----------------: | --------------: | -----------------------------: | -------: |
|   `scale-1000` |    1 100 |   1 000 |               100 |        1 100 |            15 106 |                19 800 |                452 |           1 650 |                          6 (5) |    22 MB |
|  `scale-10000` |   11 000 |  10 000 |             1 000 |       11 000 |           134 245 |               198 000 |              4 517 |          16 500 |                        55 (50) |   128 MB |
|  `scale-50000` |   55 000 |  50 000 |             5 000 |       55 000 |           579 674 |               990 000 |             22 587 |          82 500 |                      275 (250) |   597 MB |
| `scale-200000` |  220 000 | 200 000 |            20 000 |      220 000 |         2 051 891 |             3 960 000 |             90 337 |         330 000 |                  1 100 (1 000) | 2 336 MB |

Three `pre-existing-*` projects hold the **control population**: rows that were already project-scoped
before the migration and must be observably untouched by it. Every "unchanged" assertion below is
paired with a non-zero assertion on the same set, because an unchanged comparison over an empty set
proves nothing (`CLAUDE.md`).

The fixtures also exercise the two UNIQUE indexes D2 reasons about: `scale-1000` holds **34 active
global rows with a non-null `topic_key`** (so `memory_topic_key_active_uidx` is really crossed by the
`UPDATE`, not vacuously satisfied) and **513 113** global `memory_entities` rows at 50k
(`memory_entities_identity_idx`).

---

## 1. The three instruments

`CLAUDE.md` forbids presenting an isolated statement's timing and an end-to-end operation's timing as
one series. There are three instruments here and each table below names which one it used.

|        | instrument            | what it measures                                                                                                                                                                                                                 | what it does NOT include                                                  |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **I1** | **BODY-ISOLATED**     | `db/migrate.ts`'s envelope replicated in-process (`PRAGMA foreign_keys = OFF` → `BEGIN IMMEDIATE` → statements → `PRAGMA foreign_key_check` → `COMMIT` → `PRAGMA foreign_keys = ON`), with each statement group timed separately | process start, `ANALYZE`, the query-tokenizer tables, the ledger `INSERT` |
| **I2** | **RUNNER-WHOLE-BODY** | the real `migrate()` over a real `.sql` migration file — one number, no breakdown                                                                                                                                                | everything else `createDb` does                                           |
| **I3** | **FULL-BOOT**         | the real `createDb()`: pragmas, `migrate()`, `ANALYZE`, `createQueryTokenizerTables`                                                                                                                                             | Node start-up, HTTP bind, the embedding/entity workers                    |

**I3 is the number an operator waits on.** I1 exists to attribute it; I2 is the control that I1's
replicated envelope is faithful. All three are reported, and the interesting result is that at every
magnitude ≥ 10k they agree to within a few percent — i.e. **the migration body IS the boot**.

Conditions, stated so the numbers can be read honestly: 8 vCPU, 15 GB RAM, SQLite 3.x via
`better-sqlite3@12.11.1`, `sqlite-vec@0.1.9`, `journal_mode=WAL`, `synchronous=NORMAL`,
`cache_size=-65536` (64 MB), `temp_store=MEMORY` — i.e. exactly `db/client.ts`. The fixture is copied
immediately before each run, so the **OS page cache is warm**; a cold-cache first boot on slower
storage will be worse, and the WAL/growth figures in §5 bound how much I/O is involved.

---

## 2. Reproducing

```sh
# Everything: builds any missing fixture, runs the timing matrix with 3 reps, the
# two design alternatives, the VACUUM runs, the negative case, the interruption
# probe, the rollback comparison and the boot control.
sh openspec/changes/retire-the-global-scope/measurements/scale-run.sh \
   /var/tmp/rembric-scale-fixtures /var/tmp/rembric-scale-results 3

# The tables in this file, generated from those JSONs — no figure here is retyped.
pnpm --filter @rembric/server exec tsx \
  openspec/changes/retire-the-global-scope/measurements/scale-summarize.mjs \
  /var/tmp/rembric-scale-results
```

Budget the driver about 90 minutes end to end at these magnitudes; the 200k fixture alone takes 16
minutes to build and each 200k run copies 2.3 GB before it starts.

Files: `scale-fixture.mjs` (corpus), `scale-migration-body.sql` (the migration as design.md §Migration
Plan specifies it, runner-compatible), `scale-migrate.mjs` (all three instruments, five body variants and
every assertion), `scale-boot-control.mjs` (§3's I3 control), `scale-crash.mjs` (§8),
`scale-rollback.mjs` (§6), `scale-summarize.mjs`, `scale-run.sh`.

The raw output is committed alongside them, so every figure in this document can be traced to the run it
came from without re-running anything: `scale-results.json` (all 68 timing runs, including the fixture
row counts and the one deliberate failure) and `scale-probes.json` (the interruption, rollback and
boot-control probes plus each fixture's build report).

**Do not point these at `data/` or `data-dev/`.** `scale-fixture.mjs` refuses both by name, and
`scale-migrate.mjs` always works on a copy — the original fixture directory is never opened for write.

**Fixture location.** The scratchpad on this machine is on `tmpfs`; the 200k fixture is 2.3 GB and its
migration transiently needs ~5 GB more, which would be RAM on a 15 GB box also running the dev stack.
The fixtures were therefore built on real disk (`/root/rembric-scale-fixtures`). Reps: 3 per cell,
reduced with the **median** — the min would flatter a migration an operator only gets one shot at.

---

## 3. Wall-clock of the whole body, and the breakdown

### I1 BODY-ISOLATED — whole body (median; rep count per row)

| global rows | reps | set-based (ms) | per-row loop (ms) | loop ÷ set |
| ----------: | ---: | -------------: | ----------------: | ---------: |
|       1,000 |    4 |            114 |               109 |       0.96 |
|      10,000 |    4 |           1436 |              1517 |       1.06 |
|      50,000 |    3 |          12913 |             12473 |       0.97 |
|     200,000 |    4 |         195581 |            232411 |       1.19 |

The **set-based form is not materially faster than the per-row loop at any magnitude** (loop ÷ set = 0.96 /
1.06 / 0.97 / 1.19 — the loop is _faster_ at 1k and 10k, and only 19% slower at 200k). That is the
question §6 answers in full, and it repeats the pattern
`db-performance-auditor` was created for: the obvious batched rewrite is not the win it looks like.

### I1 BODY-ISOLATED — per statement group, set-based (median ms)

| statement group             |   1,000 |   10,000 |    50,000 |    200,000 |
| --------------------------- | ------: | -------: | --------: | ---------: |
| `alter-projects-is_default` |     0.4 |      0.3 |       0.4 |        0.4 |
| `insert-default-project`    |     0.1 |      0.1 |       0.1 |        0.1 |
| `update-memory`             |     4.5 |     40.1 |     248.7 |     1903.5 |
| `update-memory_entities`    |    29.4 |    311.8 |    2362.5 |    17489.1 |
| `update-sessions`           |     0.1 |      0.1 |       0.5 |        3.5 |
| `update-prompts`            |     0.1 |      0.1 |       0.1 |        0.1 |
| `update-consolidation_runs` |     0.0 |      0.0 |       0.0 |        0.0 |
| `vec-create-stash`          |     0.1 |      0.1 |       0.1 |        0.5 |
| `vec-fill-stash`            |    12.6 |    150.1 |    2009.5 |    49713.4 |
| `vec-delete-global`         |    17.1 |    197.3 |    3652.0 |    75035.6 |
| `vec-insert-repointed`      |    11.8 |    157.9 |    2017.2 |    17631.5 |
| `vec-drop-stash`            |     0.2 |      5.4 |      37.1 |      355.1 |
| `foreign_key_check`         |     7.2 |     71.2 |     879.9 |    18703.1 |
| `COMMIT`                    |    30.1 |    436.9 |    1867.5 |    12463.8 |
| **whole body**              | **114** | **1436** | **12913** | **195581** |

### I1 BODY-ISOLATED — per statement group, per-row loop (median ms)

| statement group          |   1,000 |   10,000 |    50,000 |    200,000 |
| ------------------------ | ------: | -------: | --------: | ---------: |
| `update-memory`          |     3.6 |     40.1 |     265.8 |     1660.8 |
| `update-memory_entities` |    23.1 |    298.4 |    2321.3 |    17187.8 |
| `loop-read-global-rows`  |    10.7 |    116.2 |    1202.4 |    36503.2 |
| `loop-delete-insert`     |    34.7 |    433.1 |    6595.6 |   158216.3 |
| `foreign_key_check`      |     6.0 |     68.7 |     634.4 |    11648.0 |
| `COMMIT`                 |    27.2 |    546.6 |    1474.0 |     6434.2 |
| **whole body**           | **109** | **1517** | **12473** | **232411** |

Read the two tables together and the shape is clear: **`memory_vec` is 73% of the body** at 200k in the
set-based form (142.7 s of 195.6 s) and **84%** in the loop form (194.7 s of 232.4 s). `memory_entities`
is the second cost (17.5 s), and it is the one step the design may not even need — D15's recommended
path is a rebuild, which would remove this statement from the migration entirely and drain in the
background instead. `memory`, `sessions`, `prompts` and `consolidation_runs` together are **1.9 s** at
200k: they are noise.

**Neither form is linear, and the departure is severe.** Cost per ex-global row of the whole vec group,
set-based: **31 µs** at 10k, **154 µs** at 50k, **713 µs** at 200k. The per-row loop's
`DELETE`+`INSERT` phase: **43 µs**, **132 µs**, **791 µs**. Fitting between adjacent measured points
gives an exponent of **1.99** (10k→50k) and **2.10** (50k→200k) for the set-based form, and **1.69**
then **2.29** for the loop — i.e. roughly quadratic at the top of the measured range, in both shapes.
**Extrapolating past 200 000 from these numbers would understate the cost**, which is why the verdict
in §7 stops at the largest magnitude actually measured.

### I2 and I3 — the numbers an operator actually experiences

| global rows | I1 set-based body | I2 real `migrate()` | I3 real `createDb()` |
| ----------: | ----------------: | ------------------: | -------------------: |
|       1,000 |               114 |                 101 |                  346 |
|      10,000 |              1436 |                1296 |                 1615 |
|      50,000 |             12913 |               13029 |                12387 |
|     200,000 |            195581 |              199658 |               203044 |

The three instruments agree to within a few percent from 10k up, so **the migration body IS the first
boot**. The I3 control confirms it from the other side: the same fixtures booted with the migration
removed take **12 / 16 / 71 / 4003 ms** (`scale-boot-control.mjs`; the 4 s at 200k is `createDb`'s
`ANALYZE` over a 2.3 GB file, which an operator already pays today). Everything else `createDb` does is
rounding error next to the body.

---

## 4. Does `foreign_key_check` scale?

**Yes, and worse than linearly.** It is the pre-commit gate the runner adds to _every_ migration
(`db/migrate.ts:97-107`) and it inspects the whole database, not the touched rows.

| global rows | `foreign_key_check` | per ex-global row | share of body |
| ----------: | ------------------: | ----------------: | ------------: |
|       1 000 |              7.2 ms |            7.2 µs |          6.3% |
|      10 000 |             71.2 ms |            7.1 µs |          5.0% |
|      50 000 |              880 ms |           17.6 µs |          6.8% |
|     200 000 |          **18.7 s** |             94 µs |          9.6% |

18 seconds is not the headline, but it is 18 seconds that **no migration can avoid** — the next
migration this repo ships, however trivial, pays it too on a corpus this size. It scales with the FK
graph rather than with the diff: the dominant child tables are `memory_entity_links` (3.96 M rows at
200k, two FKs) and `confirmations` (330 k). Worth knowing before someone proposes splitting this
migration into several files "to make each step smaller" — that multiplies this cost by the number of
files.

---

## 5. Peak transaction size, journal growth, and the operator whose disk is nearly full

`BEGIN IMMEDIATE` holds the write lock for the whole body, so nothing can be checkpointed until COMMIT
and the WAL only grows. The figure below is the WAL's high-water mark, stat-ed after COMMIT and before
any `close()` — exact, because no checkpoint can run inside an open write transaction and a checkpoint
never shrinks the file.

**Set-based form (B), the one `scale-migration-body.sql` ships:**

| global rows | db before | WAL high-water | db after body |         growth | freelist after | after VACUUM | VACUUM ms |
| ----------: | --------: | -------------: | ------------: | -------------: | -------------: | -----------: | --------: |
|       1,000 |     22 MB |          12 MB |         27 MB |   +5 MB (+23%) |           4 MB |        22 MB |     108.4 |
|      10,000 |    128 MB |         119 MB |        177 MB |  +49 MB (+38%) |          40 MB |       131 MB |     321.5 |
|      50,000 |    597 MB |         578 MB |        837 MB | +240 MB (+40%) |         198 MB |       606 MB |    2339.1 |
|     200,000 |   2336 MB |        2267 MB |       3278 MB | +943 MB (+40%) |         791 MB |      2360 MB |   20276.6 |

**Per-row loop (A), for contrast:**

| global rows | db before | WAL high-water | db after body |        growth |
| ----------: | --------: | -------------: | ------------: | ------------: |
|       1,000 |     22 MB |          11 MB |         26 MB |  +4 MB (+19%) |
|      10,000 |    128 MB |          82 MB |        141 MB | +13 MB (+10%) |
|      50,000 |    597 MB |         382 MB |        642 MB |  +45 MB (+8%) |
|     200,000 |   2336 MB |        1473 MB |       2491 MB | +155 MB (+7%) |

Three things an operator needs from this table.

1. **Peak disk demand is roughly 2× the database, and it is transient.** At 200k the migration wants
   2 336 MB (the file) + 2 267 MB (the WAL) + 943 MB (growth) ≈ **5.5 GB of space to migrate a 2.3 GB
   database**. On a volume with less than about 1.4× the database free, the set-based form fails
   mid-body — which, per §8, is safe but leaves the operator stuck on a boot loop with no message.
2. **The growth is fragmentation, not data, and it is reclaimable.** After the body the file is +40%
   with a 791 MB freelist; `VACUUM` returns it to 2 360 MB — 24 MB above the pre-migration size, which
   is the real cost of the new rows. `VACUUM` takes 20 s at this scale and itself needs the database's
   size again in free space. `/dashboard/maintenance` already exposes it, so the remedy exists, but
   **nothing tells the operator they now want it.**
3. **The per-row loop is dramatically kinder to disk** — +7% growth and a 1 473 MB WAL versus +40% and
   2 267 MB — because it frees and reuses vec0 chunk pages as it goes instead of freeing 200k rows'
   worth of chunks and then allocating fresh ones. It pays for that with 19% more wall-clock. If the
   binding constraint is disk rather than time, the loop is the better shape, which is the opposite of
   the usual conclusion.

---

## 6. The `memory_vec` loop specifically — four shapes measured, not three assumed

Two shapes were measured because the brief asked for them, and three more because the first two came out
so close that neither could be recommended on speed. **Every shape that completes leaves a correct
database** (§9); they differ only in cost. D and E were not run at 1k, where the whole body is under
120 ms and the comparison is noise.

| global rows |                 | A per-row loop | B set-based | D full rebuild | E id = `__global__` |
| ----------: | --------------- | -------------: | ----------: | -------------: | ------------------: |
|       1,000 | whole body (ms) |            109 |         114 |              — |                   — |
|             | WAL high-water  |          11 MB |       12 MB |              — |                   — |
|             | db growth       |          +4 MB |       +5 MB |              — |                   — |
|      10,000 | whole body (ms) |           1517 |        1436 |           1313 |                 692 |
|             | WAL high-water  |          82 MB |      119 MB |         133 MB |               44 MB |
|             | db growth       |         +13 MB |      +49 MB |         +53 MB |               +5 MB |
|      50,000 | whole body (ms) |          12473 |       12913 |          11897 |                5687 |
|             | WAL high-water  |         382 MB |      578 MB |         617 MB |              206 MB |
|             | db growth       |         +45 MB |     +240 MB |        +260 MB |              +23 MB |
|     200,000 | whole body (ms) |         232411 |      195581 |         196705 |               33732 |
|             | WAL high-water  |        1473 MB |     2267 MB |        2413 MB |              789 MB |
|             | db growth       |        +155 MB |     +943 MB |       +1022 MB |              +85 MB |

- **A — per-row `DELETE` then `INSERT`** (what design.md step 9 reads as literally). Two facts about it
  are not visible from the design text. First, **it cannot be written as a migration file at all**: the
  runner only reads `.sql` and splits on the statement-breakpoint marker, so a loop needs a change to
  `db/migrate.ts`. Second, the naive implementation reads every ex-global row into JS first —
  `loop-read-global-rows` is **36.5 s and ~600 MB of Buffers** at 200k. A `.iterate()` cursor cannot be
  used either, because the loop writes to the table it is reading. So the shape as designed implies a
  materialised 600 MB list.
- **B — stash, one `DELETE`, one `INSERT … SELECT`** (the "obvious" batched form, and what
  `scale-migration-body.sql` ships). **Not materially faster: 1.19× at 200k, 0.97× at 50k, and _slower_ at 1k and 10k.** It costs +943 MB of file growth and 794 MB more WAL. The single `DELETE FROM memory_vec WHERE
partition_key = '__global__'` is the most expensive statement in the whole migration (75.0 s).
- **C — re-`INSERT` at the new partition first, then `DELETE`, with no stash table.** **Does not
  work**, recorded rather than reasoned: `SqliteError: UNIQUE constraint failed on memory_vec primary
key`. `memory_id` is unique across partitions, so the row cannot exist at two partition keys even
  transiently. This is why the stash table is unavoidable in any DELETE-based shape.
- **D — full vtable rebuild** (migration `0014_hybrid_search_vec_rebuild.sql`'s own recipe: stash
  everything, `DROP TABLE`, recreate, reinsert). Touches 10% more rows and lands **within 1% of B at
  200k** (196.7 s vs 195.6 s) — indistinguishable — while growing the file the most (+1 022 MB). Precedented and
  correct, but not a reason to change anything.
- **E — give the default project the literal id `__global__`.** `partitionKeyFor` already writes that
  string for every ex-global vector, so `memory_vec` needs **no statement at all**. It is the only
  shape that materially changes the number: **33.7 s versus 195.6 s at 200k (5.8× faster)**, WAL
  789 MB instead of 2 267 MB, growth +85 MB instead of +943 MB. Its cost is not performance — see §7's
  recommendation and the rollback measurement below, because it is a design trade-off, not a free win.

**Variant E breaks a property design.md D5 states as measured, and this was verified rather than
argued** (`scale-rollback.mjs`, run against both migrated databases with the old binary's own query
shapes from `vectors-repository.ts:113-131` and `:80-92`):

| old binary's read, after migration                           |     shipped shape (B) |                            variant E |
| ------------------------------------------------------------ | --------------------: | -----------------------------------: |
| sparse global read (`WHERE scope = 'global'`)                |                     0 |                                    0 |
| dense global read (`partition_key = '__global__'`)           | **0** — reproduces D5 |                          **10 rows** |
| those rows hydrated through `knnCandidates`' scope-less join |                     — | **10 rows, all `scope = 'project'`** |
| control: dense read in the default project's partition       |                    10 |                                   10 |

So under variant E a rolled-back image's global dense branch returns the ex-global vectors and
hydrates them through a join that carries no scope predicate — a **cross-scope leak on the rollback
path**, in exactly the code D5 measured to be silent. Variant E also makes `GLOBAL_PARTITION_KEY`
_data_ rather than _code_, which is precisely what release N+1 wants to delete (D5, D20). Both controls
in that table pass, so the 0 is a real 0 and the 10 is a real 10.

---

## 7. The verdict an operator needs

Measured I3 FULL-BOOT (median of 3), plus what the operator sees:

| global rows | first boot after upgrade | what it looks like from outside       |
| ----------: | -----------------------: | ------------------------------------- |
|       1 000 |                   0.35 s | indistinguishable from a normal boot  |
|      10 000 |                    1.6 s | a slightly slow boot                  |
|      50 000 |                   12.7 s | a container that has not answered yet |
|     200 000 |   **203 s (3 min 23 s)** | **indistinguishable from a hang**     |

Interpolating between the measured points — **labelled as interpolation, not measurement**; the exponent
is 1.28 between 10k and 50k and 2.0 between 50k and 200k, so these are estimates with real error bars:

| threshold | crossed at approximately |
| --------- | -----------------------: |
| **5 s**   |  **~24 000 global rows** |
| **30 s**  |  **~77 000 global rows** |
| **2 min** | **~154 000 global rows** |

**These numbers argue for migration progress output, and the figure that argues it is 203 s.** There is
no migration logging at all today: `migrate()` returns `{applied, skipped}` and `db/client.ts:72`
discards it, and `printBootstrapBanner` runs _after_ `createDb`. So on a 200k-global installation the
process prints nothing for **3 minutes and 23 seconds** and then boots normally. Three consequences,
in increasing order of how much they should worry the owner:

1. **An operator cannot distinguish it from a hang**, which is the exact scenario `Ctrl-C` exists for.
2. **A container orchestrator may not wait.** A `docker compose` health check or a Kubernetes
   `startupProbe` with a default failure budget will kill the container mid-body long before 203 s.
3. **The retry is not free, and an impatient operator can loop forever.** The ledger row is written
   inside the transaction, so a kill rolls the whole body back and boot 2 starts from scratch (§8
   measures this). An operator who restarts every 60 s on a 200k corpus never finishes, sees no
   message, and has no way to tell that each attempt is making no progress.

Task 1.12 already says to thread `migrate()`'s result into `printBootstrapBanner`. **That is
after-the-fact reporting and it does not address any of the three points above** — the banner prints
when the wait is already over. What the 203 s figure argues for is output _before and during_: a line
naming the migration when it starts, and — because §3 shows two statements own 63% of the body — at
minimum a line before the `memory_vec` step.

---

## 8. Interrupting it: measured, because at 203 s someone will

`scale-crash.mjs` SIGKILLs the migrating process mid-body (SIGKILL, not SIGTERM, so nothing can tidy
up), re-opens the file, and then retries. The first version of this probe **passed vacuously** — it sent
the kill to the `pnpm` wrapper while the real migration completed underneath, which is why the probe now
asserts `signal === 'SIGKILL'` and starts its timer on the child's own READY line.

| fixture |              kill at | ledger row for the migration | every counted total after the crash                       | `integrity_check` | WAL left behind | boot 2                                |
| ------: | -------------------: | ---------------------------: | --------------------------------------------------------- | ----------------- | --------------: | ------------------------------------- |
|  10 000 | 500 ms into the body |                        **0** | **identical to before**, 10 000 global rows still present | ok                |           43 MB | applies in 1.8 s, 0 global rows left  |
|  50 000 |    4 s into the body |                        **0** | **identical to before**, 50 000 global rows still present | ok                |          230 MB | applies in 12.0 s, 0 global rows left |

Eleven assertions each, zero failures. **Interruption is safe**: atomic, no half-moved rows, no ledger
entry, integrity intact, and the retry completes. The cost is that the retry starts over — which is what
makes the missing progress output an availability problem rather than a cosmetic one.

---

## 9. Correctness at every magnitude

Every run asserts the full list; a run with any failure exits non-zero and is recorded as failed.
**Zero failures across 63 runs at four magnitudes**, plus the one negative result that fails by design
(variant C's UNIQUE failure, §6).

| global rows | variant         | runs | assertions per run | failures | blob samples byte-identical / cosine 0 | kNN rows, new partition (min) | kNN rows, control partition (min) |
| ----------: | --------------- | ---: | -----------------: | -------- | -------------------------------------: | ----------------------------: | --------------------------------: |
|       1,000 | set             |    4 |              34–36 | **none** |                      256/256 / 256/256 |                            10 |                                10 |
|       1,000 | loop            |    3 |                 34 | **none** |                      192/192 / 192/192 |                            10 |                                10 |
|       1,000 | runner          |    3 |                 34 | **none** |                      192/192 / 192/192 |                            10 |                                10 |
|       1,000 | boot            |    3 |                 34 | **none** |                      192/192 / 192/192 |                            10 |                                10 |
|      10,000 | set             |    4 |              34–36 | **none** |                      256/256 / 256/256 |                            10 |                                10 |
|      10,000 | loop            |    3 |                 34 | **none** |                      192/192 / 192/192 |                            10 |                                10 |
|      10,000 | rebuild         |    2 |                 36 | **none** |                      128/128 / 128/128 |                            10 |                                10 |
|      10,000 | id-is-partition |    2 |                 36 | **none** |                      128/128 / 128/128 |                            10 |                                10 |
|      10,000 | runner          |    3 |                 34 | **none** |                      192/192 / 192/192 |                            10 |                                10 |
|      10,000 | boot            |    3 |                 34 | **none** |                      192/192 / 192/192 |                            10 |                                10 |
|      50,000 | set             |    3 |              34–36 | **none** |                      192/192 / 192/192 |                            10 |                                10 |
|      50,000 | loop            |    3 |              34–36 | **none** |                      192/192 / 192/192 |                            10 |                                10 |
|      50,000 | rebuild         |    2 |                 36 | **none** |                      128/128 / 128/128 |                            10 |                                10 |
|      50,000 | id-is-partition |    2 |                 36 | **none** |                      128/128 / 128/128 |                            10 |                                10 |
|      50,000 | runner          |    3 |              34–36 | **none** |                      192/192 / 192/192 |                            10 |                                10 |
|      50,000 | boot            |    3 |              34–36 | **none** |                      192/192 / 192/192 |                            10 |                                10 |
|     200,000 | set             |    4 |              34–36 | **none** |                      256/256 / 256/256 |                            10 |                                10 |
|     200,000 | loop            |    3 |                 34 | **none** |                      192/192 / 192/192 |                            10 |                                10 |
|     200,000 | rebuild         |    2 |                 36 | **none** |                      128/128 / 128/128 |                            10 |                                10 |
|     200,000 | id-is-partition |    2 |                 36 | **none** |                      128/128 / 128/128 |                            10 |                                10 |
|     200,000 | runner          |    3 |                 34 | **none** |                      192/192 / 192/192 |                            10 |                                10 |
|     200,000 | boot            |    3 |                 34 | **none** |                      192/192 / 192/192 |                            10 |                                10 |

The assertion list. Two partition-key assertions (`no vector at a partition key that is not a project
id`, `every ex-global vector now sits at the default project partition`) were added while the variant
comparison in §6 was being built, which is why some cells read `34–36`: every `rebuild` and
`id-is-partition` run carries all 36, as does one run per variant at 50k and one extra `set` run at 1k,
10k and 200k; the earlier reps carry 34. No run of either size failed anything.

- `memory` total **conserved** and **non-zero**; zero rows at `scope = 'global'`; the global population
  was **non-zero before** (the non-vacuity half).
- Every ex-global row points at the new default project; the **control population in the three
  `pre-existing-*` projects is unchanged AND non-zero**.
- `memory_vec` total conserved and non-zero; **zero rows at `partition_key = '__global__'`** and the
  global partition was **non-empty before**; no vector at a partition key that is not a live project
  id; every ex-global vector now at the default project's partition.
- `memory_fts` total conserved and non-zero; `memory_entities` conserved with zero at `scope='global'`
  and non-zero global before; `memory_entity_links`, `memory_relations`, `confirmations`, `sessions`
  conserved.
- `sessions.project_id IS NULL` repointed to zero, and there **were** such rows before.
- Exactly one `is_default` project; `projects` grew by exactly one.
- Finished `consolidation_runs` keep `scope = 'global'` (D16) while the live one is repointed — asserted
  as _some remain_ and _fewer than before_, so neither half can pass vacuously.
- `PRAGMA foreign_key_check` empty; `PRAGMA integrity_check` `ok`;
  `INSERT INTO memory_fts(memory_fts) VALUES('integrity-check')` succeeds.
- A dense kNN in the new partition returns **> 0** rows, **and** a control kNN in a pre-existing
  project's partition returns > 0 rows.

**The blob survives at scale.** 64 ex-global vectors are sampled per run by stride across the whole
`memory_id` order (not the first 64), captured before the body, and after it each is checked three ways:
`Buffer.equals` against the original bytes, `vec_distance_cosine(<original blob>, embedding) = 0`, and
`partition_key` equal to the new project's id. **Across all runs: 4 032 samples, 4 032 byte-identical,
4 032 at cosine distance 0, 4 032 in the new partition.** Zero mismatches at any magnitude, in any
variant.

---

## 10. Verdict

**Is the migration safe to run unattended at 200 000 global rows? Yes on correctness, no on
observability.**

- **Correctness: safe.** Zero assertion failures in 63 runs across 1k / 10k / 50k / 200k, in four
  different `memory_vec` shapes, with byte-identical blobs and a working dense index in the new
  partition every time. Interrupting it is atomic and the retry completes. Nothing here argues against
  the shape design.md chose on correctness grounds.
- **Observability: not safe to run unattended as it stands.** At 200k global rows the first boot is
  silent for **3 minutes 23 seconds**, and the three failure modes in §7 (operator kills it, orchestrator
  kills it, restart loop makes no progress) are all reachable without anything being wrong. This is the
  one finding that should change the change.
- **Disk: needs saying out loud.** The set-based form wants ~2× the database free (5.5 GB for a 2.3 GB
  file at 200k) and leaves the file 40% larger until someone runs `VACUUM`. An operator near a full
  volume will fail the migration — safely, but into the silent boot loop above.
- **Speed: nothing cheap to buy.** Of the four `memory_vec` shapes, three land within 19% of each other,
  so there is no free optimisation. The only material lever (variant E, 5.8× faster) is a design
  trade-off that costs a rollback-path cross-scope leak, and it is the owner's call, not a tuning
  decision.

### What would have to change

Nothing at 1k or 10k. From roughly 24k global rows upward, in priority order:

1. **Emit progress output before and during the migration, not only after.** This is the whole verdict.
   The figure that justifies it is 203 s of silence, and §3 says where the lines go: one when the
   migration starts, one before `memory_vec` (73% of the body), one before `memory_entities`.
2. **Document the disk requirement in the release note** — "the upgrade needs free space roughly equal
   to your database size, and the file will be ~40% larger until you run VACUUM from
   `/dashboard/maintenance`". Both figures are in §5.
3. **Decide `memory_entities` deliberately.** D15 recommends the rebuild path; if that is taken, the
   `UPDATE memory_entities` statement leaves the migration and 17.5 s of the 200k body goes with it —
   the second-largest single line item, removed by a decision that is already the recommendation.
4. **Choose between A and B on disk, not on speed,** since speed does not separate them. B (shipped) is
   19% faster at 200k and costs +943 MB; A is kinder to disk (+155 MB) and cannot be written as a
   `.sql` file. If B is kept, the `DELETE` is the single most expensive statement in the migration and
   is worth a comment saying so.
