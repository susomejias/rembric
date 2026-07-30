# The corpus this change measures on

Groups 1–3 of this change were measured on a generator that lived in a scratch
buffer and did not survive its session. Groups **4–9 do not have to be**: the
generator is now committed by
`openspec/changes/commit-the-volumetric-harness/`, and this file is the
copy-paste list of invocations those groups need, so unblocking them is not a
re-derivation.

## The invocations

```sh
# The three memory sizes this change's findings are stated at.
pnpm run corpus:build -- --db ../corpora/1k  --memories 1000  --seed 1
pnpm run corpus:build -- --db ../corpora/20k --memories 20000 --seed 1
pnpm run corpus:build -- --db ../corpora/50k --memories 50000 --seed 1

# The separate session-axis corpus. Group 4.4 (`findActiveForTransport`, every
# MCP call) and 5.4 (`abandonInactiveSince`) are stated at 50 000 sessions, and
# the axes are independent, so this costs nothing on the memory axis.
pnpm run corpus:build -- --db ../corpora/s50k --memories 0 --sessions 50000 --seed 1
```

`--seed 1` is not decoration. A before-and-after in this change must compare two
runs against corpora built from the **same seed**, or the difference may be the
corpus rather than the index. Task 3.2's unreproduced `adminList` plan coin-flip
is what that costs: it set out to compare "two independently-seeded 50k corpora"
and could not tell a real instability from two samples.

**The harness never deletes.** There is no `--reset` and no `--force`; it refuses
a database that already holds memories and refuses any directory named `data` or
`data-dev`. To rebuild, remove the directory yourself.

## What these corpora are and are not

Measured cost on Machine A (full figures in the harness's `measurements.md`):
1k → 1.9 s, 20k → 28.6 s, 50k → 72.4 s / 613 MB, 50k sessions → 8.9 s.

**Vectors are synthetic.** They are deterministic pseudo-random unit vectors, not
embeddings. Group 4/6 items that concern plan shape and scan cost are fine —
sqlite-vec brute-forces the partition before computing distance, so cost depends
on how many vectors are in the partition, not on what the floats mean. But **no
retrieval-quality conclusion may be drawn**: not recall, not ranking, not the
fusion weighting, not the abstention floor. `pnpm run eval` is the instrument for
those.

**Timestamps are anchored to a fixed epoch**, so the decay and review axes are
derived against the wall clock at read time. Any measurement on those axes must
pass an explicit `nowMs` (the repository reads accept one) rather than rely on the
ambient clock, or it will report a different answer next month against the same
corpus.

## Three findings this change should absorb before continuing

All three came out of building the harness and re-capturing plans on it. Details
and method in `commit-the-volumetric-harness/measurements.md` §5.2, §5.3 and §8.

### 1. This change's entity-axis corpus contradicted its own design paragraph

Task 3.3 names its corpus as "50 000-memory / **20 000-entity / 20 000-link**",
i.e. **0.4 entity links per memory**. The design paragraph at `design.md:3` says
**~18 entities per memory**, which the harness reproduces as **900 000 links /
609 952 distinct entities at 50k** — roughly **45× denser**.

So the statistics-dependence figures in 3.2 and 3.3 were taken on a corpus far
sparser on the entity axis than this change claims to have measured on. The
mechanism they describe is confirmed (below); the magnitudes are not
re-derivable at the density the design paragraph states. **Recommendation:**
re-state 3.2/3.3's entity figures against `../corpora/50k`, or mark the corpus
they were taken on explicitly, before group 4.2 cites them as its baseline.

### 2. 3.2's `linkMemory` finding reproduces — and its linearity claim checks out

Re-captured on harness corpora, OR chain width 18 pairs (matching "18
four-column seeks" exactly):

| Corpus                        | With statistics                      | Statistics deleted | Ratio  |
| ----------------------------- | ------------------------------------ | ------------------ | ------ |
| 20k (257 851 entities)        | `MULTI-INDEX OR`, 18 seeks, 0.016 ms | 10.453 ms          | 653×   |
| 50k (609 952 entities)        | `MULTI-INDEX OR`, 18 seeks, 0.025 ms | 25.212 ms          | 1 008× |
| this change's 50k (20 000 e.) | `MULTI-INDEX OR`, 18 seeks, 0.014 ms | 6.960 ms           | ~500×  |

Both plan shapes reproduce; the fast arm's timing matches. The slow arm scales
**linearly in the scope's entity count** (2.37× entities → 2.37× cost), which is
independent confirmation of this change's own claim that the degenerate plan
scans the scope partition. **Group 4.2's verification bar — "verify with
`sqlite_stat1` both present and deleted" — is directly runnable on
`../corpora/50k`**, and the numbers above are its pre-fix baseline.

### 3. The same degenerate plan makes any bulk write quadratic

`db/client.ts` runs `analysis_limit=1000; ANALYZE` at open (this change's own task
3.1) and `PRAGMA optimize` at close. That is the right cadence for a server, which
restarts. A process that writes tens of thousands of rows **without restarting**
keeps an empty database's statistics for its whole run, so `linkMemory` stays on
the degenerate plan while `memory_entities` grows — quadratic in the output.

Measured on the harness at 20k: refreshing statistics between batches took the
build from **~149 s to 28.6 s** with byte-identical output.

**This does not reverse task 3.1's decision** to reject an interval `ANALYZE` for
the server; that decision rests on `createDb` running at every process start,
which is true of the server and false of a bulk writer. The harness therefore
calls `refreshStatistics` itself. **But it is worth this change asking one
question it has not asked:** is there any production path that writes at bulk
scale within a single process lifetime — a large import, a backfill drain, a
migration that repopulates a derived table? If so, it inherits the same
quadratic, and boot-time `ANALYZE` does not cover it.

## An open discrepancy, not resolved here

Task 4.1 quotes `searchMemoryIds` at **12.8–38.6 ms** pre-fix. On
`../corpora/50k` the **plan shape reproduces exactly** —
`SEARCH m USING INDEX memory_scope_seen_idx (scope=? AND project_id=?)` plus
`USE TEMP B-TREE FOR ORDER BY`, which is the sort 4.1 exists to remove — but the
wall-clock is **4.764 ms**, about 2.7× below the quoted floor.

Unverified candidate causes: the quoted range may span variants not run here (4.1
itself names an `includeGlobal` arm at 27.6 ms; `includeGlobal: false` was used),
a different `limit`/`offset`, or a different machine. **Resolve it on
`../corpora/50k` before reporting 4.1's improvement as a ratio**, since the
denominator is currently in question even though the defect is not.
