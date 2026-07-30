# Measurements — groups 4–9

**Machine A**: Linux 7.0.6-2-pve container, 10 cores, 9 GB RAM, Node v22.23.1,
`better-sqlite3` 12.11.1, `sqlite-vec` 0.1.6, local disk.

Every figure here was taken against a corpus rebuilt by:

```sh
pnpm run corpus:build -- --db <dir> --memories 50000 --sessions 50000 --relations 43000 --prompts 50000 --seed 1
```

100 s, 728 MB. Groups 1–3 were measured on a corpus that no longer exists; those
figures stay as this change recorded them and are labelled as its figures wherever
quoted below. **These are one machine's numbers**: they establish the ordering of
alternatives and the shape of the growth, not absolute latency on any host.

## 0. The harness had to be extended first

Four tasks (4.7, 6.2, 6.3, 6.6, and half of 6.5) could not be measured at all:
the committed harness had axes for memories and sessions only, and both corpora
held **zero `memory_relations` and zero `prompts`**. Quoting figures from a
throwaway corpus would have breached the `data-access` reproducibility
requirement on its first real test.

Added: `--relations` and `--prompts`, plus a `session_id` on the declared share of
memories and on confirmations (without it `adminCountBySession` groups an all-NULL
column and measures as trivially free). The harness's spec requirement is
MODIFIED accordingly. Its declared shape grew by four figures, all labelled as
harness choices rather than reproductions, and `supersedes` is excluded from
generated verdicts so the relation axis cannot move the memory axis's declared
superseded fraction — asserted by a test that re-checks that figure on a corpus
which also built 240 relations.

## 1. Index additions — before/after on the same corpus

`--drop-new` reverts 0027 on a copy, so both arms are the same corpus in the same
process. Code rewrites are present in both arms; §2 measures those separately.

| task | query                                    | before   | after        |       |
| ---- | ---------------------------------------- | -------- | ------------ | ----- |
| 6.3  | `relations.adminCountWithFilters({})`    | 25.4 ms  | **0.004 ms** | 6964× |
| 6.6  | `prompts` session-prefix (range vs LIKE) | 6.30 ms  | **0.002 ms** | 2906× |
| 6.1  | `adminCountEntities({})`                 | 177.9 ms | **0.183 ms** | 972×  |
| 6.5  | `memory.adminCountBySession(page)`       | 6.35 ms  | **0.007 ms** | 906×  |
| 6.2  | `relations.adminListWithContent({})`     | 205.5 ms | **0.274 ms** | 750×  |
| 5.3  | `entities.adminBacklogCount`             | 7.48 ms  | **0.014 ms** | 551×  |
| 6.4  | `memory.adminList(active)`               | 90.5 ms  | **0.258 ms** | 351×  |
| 6.6  | `prompts.adminList` page 1               | 30.6 ms  | **0.092 ms** | 332×  |
| 6.6  | `prompts.countDeleted`                   | 2.11 ms  | **0.061 ms** | 35×   |
| 4.4  | `findActiveForTransport` (global)        | 1.93 ms  | **0.096 ms** | 25×   |
| 4.3  | `countByStatusAndTypeInScope`            | 2.71 ms  | **0.667 ms** | 4.1×  |

### 4.1 — this change asked for one index and needed two

Task 4.1 specifies `memory(scope, project_id, status, created_at)` and predicts
12.8–38.6 ms → 0.03–0.40 ms. **The index alone does not deliver that**, and the
reason is that `searchMemoryIds` has two callers:

| predicate                                     | plan                                                                   | wall         |
| --------------------------------------------- | ---------------------------------------------------------------------- | ------------ |
| `status = ?` (equality)                       | `SEARCH … (scope=? AND project_id=? AND status=?)`                     | **0.010 ms** |
| `status != 'archived'` (default, a **range**) | `SEARCH … (scope=? AND project_id=?)` + `USE TEMP B-TREE FOR ORDER BY` | **3.09 ms**  |

A range on the third column leaves `created_at` unsorted, so the planner sorts.
Absorbing the inequality into a partial index's WHERE fixes it —
`memory (scope, project_id, created_at) WHERE status != 'archived'` measured
**0.048 ms** with no sort, a 55× win — **and that index was then withdrawn.**

It shares the `(scope, project_id)` prefix with `memory_scope_seen_idx`, and
`memory-repository.perf.test.ts` caught the consequence: at the few hundred rows
its fixture holds, the planner prefers the partial index and sorts, displacing the
no-sort plan the recency-index requirement publishes for `recentForContext`
(`memory.context`'s per-turn read). Re-measured on the 50k corpus, the planner
chooses `memory_scope_seen_idx` correctly in both arms — 0.010 ms with the partial
index present, 0.014 ms without — so the displacement exists **only at the scale
real installations run at today** and vanishes at the scale these figures come
from.

Withdrawn rather than shipped: at a few hundred rows both plans are microseconds,
so nothing is lost today, and shipping it would have broken a published plan
guarantee to win a figure that only matters at a scale where the problem does not
occur. Resolving it means choosing between two per-turn readers or finding an index
that serves both orderings. Carried as
`serve-unarchived-scope-scan-without-displacing-recency`.

This is the second time in two changes that a predicted index win did not
materialise for the query shape actually on the path — the first was the
`LEFT JOIN` pessimisation this change's own D2 records. It is also the second time
an existing perf test, not review, caught the regression.

### 4.4 — the index served the filter, not the order

The specified index is ordered by `COALESCE(last_activity_at, started_at) DESC`
while the repository ordered by `started_at DESC`. Measured: the project shape
selected the index and still paid `USE TEMP B-TREE FOR ORDER BY`; the
`project_id IS NULL` shape **abandoned the index entirely** for
`sessions_status_started_idx`, which supplied the order for free — 1.93 ms.

The `ORDER BY` is unobservable: `LIMIT 2` with "sole match or nothing" returns the
same value whichever two rows come back. Removed, with two tests pinning the
argument — the sole match wins even when it is the oldest, and three matches still
return nothing. Result: **0.096 ms**.

### Flat, and why

- `4.1 includeGlobal` — 6.37 → 6.89 ms. The `includeGlobal` predicate is an OR of two scope branches; neither index serves the union without a sort. Not addressed here.
- `6.1 adminListEntities` — 1487 → 1508 ms. This is 6.9's aggregate, deferred by operator decision; no index in 0027 targets it. See §4.
- `6.8 adminSearchFts` / `adminCountFts`, `4.7 prompts.searchByScope` — the FTS scan dominates and no index changes it. The win for these is the removed duplicate scan (§2), which this arm cannot show because it is a code change present in both arms.
- `6.10 readDbstatBytes` — 169 → 171 ms, unchanged by construction: it walks every page. Addressed by making it opt-in (§3).

## 2. Code rewrites — old vs new SQL, and result identity (9.1)

Same corpus, same process, both SQL forms executed and compared. **Every rewrite
returned an identical result set.**

| task               | before     | after     |       | identical |
| ------------------ | ---------- | --------- | ----- | --------- |
| 6.3 unfiltered     | 25.405 ms  | 0.004 ms  | 6964× | YES       |
| 6.6 prefix range   | 6.303 ms   | 0.002 ms  | 2906× | YES       |
| 6.1 all kinds      | 177.877 ms | 0.183 ms  | 972×  | YES       |
| 6.5 memory twin    | 6.350 ms   | 0.007 ms  | 906×  | YES       |
| 5.3 entity backlog | 7.478 ms   | 0.014 ms  | 551×  | YES       |
| 6.3 status=judged  | 20.845 ms  | 0.420 ms  | 49.6× | YES       |
| 6.1 one kind       | 137.356 ms | 25.669 ms | 5.4×  | YES       |

`6.1 one kind` is the weakest of these and worth naming: `kind = 'path'` selects a
large fraction of 610k entities, so `count(*)` still walks most of the index. This
change predicted 46 → 0.71 ms on a 20k-entity corpus; at the declared entity
density the same rewrite gives 5.4×, not 65×.

### 4.6 — the `rank MATCH` rewrite is a pessimisation, not a marginal win

The task set the bar at "ship only if the diff stays small". The diff is not what
stopped it. Measured on the 50k corpus, 400-row rank window, result order
**byte-identical** in all three bands (confirming that half of the prediction):

| query                 | current `bm25()` + `ORDER BY rank` | `rank MATCH 'bm25(…)'` + `ORDER BY memory_fts.rank` |
| --------------------- | ---------------------------------- | --------------------------------------------------- |
| narrow (rare term)    | 12.457 ms                          | 18.613 ms                                           |
| mid (common term)     | 13.852 ms                          | 18.556 ms                                           |
| match-all (4-term OR) | 29.914 ms                          | 39.792 ms                                           |

The rewrite does exactly what was claimed to the plan — `USE TEMP B-TREE FOR
ORDER BY` disappears — and is 1.3–1.5× slower anyway: letting FTS5 order
internally costs more than SQLite's temp B-tree over 400 rows. This change
predicted 16.8 → 10.9 ms. **Not shipped**, and this is the third predicted win in
this change whose ordering inverted under measurement.

### 5.1 — the arithmetic form is unsafe on real data, and the Docker smoke found it

Measured 603.6 ms → 41.4 ms (14.6×) with an identical result **on a harness
corpus**, and then **not taken in that form**. The premise was that
`count(memory) - count(memory_vec)` is exact because a memory's vector goes with
it. The Docker smoke (§7) disproved it: the resident `data-dev` held **35 memories
and 4747 `memory_vec` rows, all with distinct `memory_id`s** — orphaned vectors.
The arithmetic returns **−4712** there, so a reported backlog would have been a
negative number and, clamped, a confident "0 pending" while rows were genuinely
unembedded. The anti-join it replaced is immune: orphan vec rows simply do not
participate.

Root cause, a **pre-existing defect this change did not introduce**: there is no
`AFTER DELETE` trigger removing `memory_vec` rows, only `memory_vec_status_sync`
on UPDATE. `seed-dev`'s `wipe()` carries a comment asserting the opposite —
"memory_vec / memory_fts have AFTER DELETE triggers on memory and clean up
automatically" — which is true for `memory_fts` and false for `memory_vec`, so
every `dev:docker:up` leaks the previous boot's vectors. (`purgeByIds` deletes
`memory_vec` explicitly, so the operator purge path is unaffected.) Carried as
**`memory-vec-orphans-on-wipe`**.

A gate form was tried next — trust only an exact 0, fall through otherwise — and
**also removed**, for two independent reasons found by review:

1. **It inherits a subtler failure.** One orphan against one genuinely pending
   row cancels to _exactly zero_, so the gate reports a clean backlog while a row
   waits. The first regression test picked 2 orphans against 1 pending (difference
   −1) and did not cover it.
2. **In front of `findMissingEmbeddings` it was a regression, not a saving.**
   That query is `LIMIT`-bounded (0.039 ms); the gate is a full `memory_vec` scan
   (12.7 ms at 20k) — 325× overhead on every 30 s tick while a backlog exists.
   And it was redundant: `EmbeddingWorker.possiblyPending` already skips the scan
   at the service layer, absorbing 119 of every 120 polls.

So `adminBacklogCount` is the anti-join, unguarded, and `findMissingEmbeddings` is
ungated. Both failure modes are pinned by
`vectors-repository.test.ts::"backlog count survives orphaned vec rows"`, each
confirmed failing against the arithmetic: `expected -1 to be 1` and
`expected +0 to be 1`.

**The orphan source is fixed.** `seed-dev`'s `wipe()` deleted every FK-enforced
child of `memory` explicitly and omitted `memory_vec` — the one child outside FK
enforcement — while a comment claimed a trigger handled it. Production was never
affected (`purgeByIds` deletes vec rows explicitly); only `dev:docker:up` leaked.
The explicit delete and a corrected comment ship here; follow-up
`memory-vec-orphans-on-wipe` covers cleaning databases that already accumulated
orphans.

### 4.2 — the point is the stats-dependence, and it is confirmed

OR chain versus `(kind, value) IN (VALUES …)`, 18 pairs, identical results:

| statistics  | OR chain                                                | row value                   |           |
| ----------- | ------------------------------------------------------- | --------------------------- | --------- |
| present     | 0.015 ms, `MULTI-INDEX OR`                              | 0.014 ms, 4-column seek     | wash      |
| **deleted** | **21.623 ms**, `(scope=? AND project_id=?)` prefix scan | **0.017 ms**, 4-column seek | **1272×** |

The row value's plan is the unconditional four-column seek this change asked for.
The best case is a wash, exactly as D6 predicted; the value is that the save path
stops depending on whether `sqlite_stat1` happens to be fresh.

## 3. Decisions taken on measurement

### 4.5 — `scopeActiveMemoryCount`: no change

Re-measured at **0.184 ms** per save, not the 1.09 ms this change's audit
reported. It is already computed once per save, not once per entity. Both options
offered — a per-request cache or a maintained counter — cost more than they buy at
that figure, and a counter is the same drift hazard that deferred `link_count`.
Recorded as measured-and-declined rather than done.

### 4.8 — entity fan-out: measured, then reverted

Plan confirmed at a 1103-link fan-out: `USE TEMP B-TREE FOR ORDER BY` over the
whole fan-out before the `LIMIT`, so cost is O(fan-out) not O(limit) — 1.46 ms.
Identical plans before and after 0027, so no index in this change affects it.

The alternative was implemented and measured: ordering by the link table's
composite primary key gives **0.014 ms (104×) with an identical result set**.
**Reverted.** It is equivalent only while every `memory.id` is a ULID whose
timestamp prefix equals its `created_at` — true for every row the application
writes, unenforced, and false for the repository's own test fixture, which
inserts synthetic ids and orders differently under it. Adopting it converts a
documented chronological guarantee into a conditional one, which is a contract
change.

Carried as **`order-entity-fanout-by-link-pk`**. Its prerequisite is now pinned:
`memory.test.ts::"ULID prefix equals created_at"` asserts the invariant on the
save path, including the backdated-clock path the dev seed uses.

### 5.4 — `abandonInactiveSince`: not added

Gated on 4.4, which shipped. But 4.4's index carries a `token_id`/`project_id`
equality prefix that this sweep has no predicate for, so it cannot be served by
it. Measured effect on the candidate scan: none — 1.56 ms against 1.76 ms, inside
noise. No index added.

### 7.3 — `confirmations_session_idx`: kept

The one drop candidate the prediction got wrong. The session-content `EXISTS`
selects it at **7.80 ms**; without it SQLite builds a transient automatic index
and the same query costs **15.79 ms**. Kept.

### 7.1 / 7.2 — five indexes dropped, on predicate arguments

`7.1`'s plans are **unchanged** with and without the index, and
`confirmations_memory_verdict_ts_idx` serves both readers. `7.2`'s four rest on
predicate arguments — properties of the SQL, not the data — because the tables
they sit on hold 0 or 1 rows in this corpus and could not be measured at volume:
no query filters `oauth_tokens.expires_at` at all; `tokens.revoked_at` and
`consolidation_ops.reverted_at` appear only behind a leading equality served by
another index; `dashboard_sessions.token_id` is only a join key entered from the
primary-key side. Details in the `persistence` delta.

### 6.10 — `readDbstatBytes` behind an explicit action

169 ms on a 728 MB file, walking every page, unbounded in database size. Now
opt-in via `?bytes=1` on the maintenance page, with a link. The default render
falls back to the row-count breakdown it already had.

## 4. The deferred item whose basis moved (6.9)

Q1 deferred `memory_entities.link_count` on a measurement of **98.7 ms**, with
the argument that the dashboard is the tier where cost matters least. At the
declared entity density the same page measures **1487 ms**, and 0027 does not move
it (1508 ms after) because the cost is aggregating the whole join, which no index
addresses.

The deferral **stands** — it is an operator decision and this change does not
reopen it. Recorded here so that if it is revisited, it is revisited against
1.5 s rather than 98 ms. The 15× gap is the entity-axis density difference: 610k
entities at the declared ~18 per memory, against the 20k the original figure was
taken on.

## 5. Write amplification (9.3)

Per save, including the FTS and `memory_replaces` triggers, the embedding insert
and entity linking for ~18 entities; 2000 warm then 2000 measured, fresh database
each arm:

| run | pre-0027  | after 0027 + 0028 | delta  |
| --- | --------- | ----------------- | ------ |
| 1   | 1.2972 ms | 1.1497 ms         | −11.4% |
| 2   | 1.1822 ms | 1.1454 ms         | −3.1%  |
| 3   | 1.1120 ms | 1.1268 ms         | +1.3%  |

**No measurable write amplification.** The declared index count is unchanged at
**35 → 35**: 0027 is net +5 (seven added, two replaced-and-dropped) and 0028 is
−5. The run-to-run spread is ±12 points and straddles zero, which is wider than
any difference between the two sets, so the only defensible statement is that the
write cost did not move.

Recorded as three runs rather than one deliberately: the first single run measured
+6.4% and would have been reported as a real cost. It was taken while the
withdrawn partial index was still in the set, and repeating it showed the sign was
not stable. A single micro-benchmark at this scale does not resolve a few percent.

This change's audit quoted a 0.126 ms/save baseline and ~0.005 ms per extra index.
Both differ from the ~1.1 ms here because this baseline includes the embedding
insert and entity linking for ~18 entities, not only the memory row and its
triggers.

## 6. Plans re-captured (9.2)

Every query named in §1 and §2 had its plan captured by wrapping
`Database.prototype.prepare` and driving the **real repository method**, so the
`EXPLAIN`ed statement is the one the repository executed rather than SQL re-typed
by hand. Each new index was confirmed selected for at least one named query:

- `memory_scope_project_status_created_idx` — `searchMemoryIds` with explicit `status`
- `memory_scope_unarchived_created_idx` — `searchMemoryIds` default path
- `memory_type_in_scope_idx` — `countByStatusAndTypeInScope`
- `memory_status_created_idx` — `adminList` / `adminCount`
- `sessions_active_transport_idx` — `findActiveForTransport`
- `memory_relations_created_at_idx` — `adminListWithContent({})`
- `prompts_created_active_idx`, `prompts_deleted_idx` — `adminList`, `countDeleted`

`memory_type_in_scope_idx` is additionally selected for `searchMemoryIds`' default
path in the pre-partial-index arm, as an incidental three-column prefix match; the
partial index supersedes it there.

## 7. Docker smoke against pre-existing data (9.5)

The resident `data-dev` (39 memories, 26 relations, 5 sessions, migrations
0000–0026) was copied and the new migrations applied to the copy:

```
before: applied=27 memory=39 relations=26
after:  applied=29 memory=39 relations=26
every row count and every memory id unchanged
PRAGMA quick_check: ok
PRAGMA foreign_key_check rows: 0
dashboard counters: [{"status":"active","count":22},{"status":"superseded","count":17}]
review queue: 22
```

Then the real stack: `pnpm run dev:docker:up`, reachable after ~130 s,
`/healthz` 200 with a bearer token, boot banner
`memory=35 projects=1 sessions=5 tokens=3 prompts=0`.

**The shipped index set inside the running image is exactly the specified one** —
all seven additions present, all seven removals (0027's two replacements plus
0028's five) gone, `confirmations_session_idx` retained, 35 declared indexes.

Surfaces, all HTTP 200 after a dashboard login: home, memories, memories filtered
by status, memories by FTS query, memories filtered to `needs_review`, sessions,
judgments, prompts, consolidation, maintenance, and maintenance with `?bytes=1`.

- **6.8** — the FTS page renders an exact `OF 1` rather than a lower bound, so the total survived the removal of the duplicate scan.
- **6.10** — the default maintenance render reports `Source: row-counts` and offers a "Measure per-table bytes" link; `?bytes=1` reports `Source: dbstat`. The 169 ms page walk is now opt-in.
- **4.3 / review queue** — `memory.stats` over MCP returns `active: 18, superseded: 17`, a populated `memoriesByType`, `needsReviewTotal: 3`, `pendingJudgmentsTotal: 1`.

`data-dev` was backed up before the run and restored afterwards; the stack was
torn down.

**The smoke earned its place**: it is what disproved §2's embedding-backlog
rewrite. Nothing in the unit suite or the harness corpora contains an orphaned
`memory_vec` row, because only repeated `seed-dev --reset` boots produce them.

## 8. Tasks measured and declined, or deferred

| task                                    | outcome                                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 4.5 `scopeActiveMemoryCount`            | measured 0.184 ms/save; both offered fixes cost more than they buy. No change.                                 |
| 4.8 entity fan-out                      | alternative measured at 104×, reverted; needs a contract decision. Follow-up `order-entity-fanout-by-link-pk`. |
| 5.4 `abandonInactiveSince`              | 4.4's index cannot serve it (no `token_id` prefix); measured effect nil. No index added.                       |
| 6.7 sessions recency indexes            | deferred by operator decision Q2.                                                                              |
| 6.9 `link_count`                        | deferred by operator decision Q1; basis re-measured at 1487 ms, not 98.7 ms (§4).                              |
| 9.6 `link_count` trigger reconciliation | moot — `link_count` did not ship.                                                                              |

New follow-ups this change produced, all named rather than left implicit:
`serve-unarchived-scope-scan-without-displacing-recency`,
`order-entity-fanout-by-link-pk`, `memory-vec-orphans-on-wipe`.
