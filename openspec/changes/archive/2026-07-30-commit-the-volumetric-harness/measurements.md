# Measurements

Everything below was taken on the machine named beside it. Nothing here is quoted from
another change; where a figure comes from `tune-hot-query-paths` it is labelled as its
figure, not as one re-measured here.

**Machine A** (all figures unless stated otherwise): Linux 7.0.6-2-pve container, 10 cores,
9 GB RAM, Node v22.23.1, `better-sqlite3` 12.11.1, `sqlite-vec` 0.1.6, corpus written to
local disk (not a bind mount).

Sections are numbered after the task groups they answer. Groups 2, 3 and 4 produced tests
rather than figures, so they have no section here — their evidence is
`apps/server/src/scripts/seed-volumetric.test.ts`, which is the artifact those tasks asked
for.

## 1. Preconditions, as found on disk (tasks 1.1–1.4)

Recorded as found rather than as quoted by the proposal, because the proposal was written a
day earlier and the tasks make this a stop condition.

### 1.1 — `DELETE FROM memory` allow-list is still closed at two entries

`apps/server/src/test/invariants.test.ts:58-62`:

```
pattern: /DELETE\s+FROM\s+memory\b/i,
allow: ['db/repositories/memory-repository.ts', 'scripts/seed-dev.ts'],
```

Exactly the two files design D1 rests on. No third entry. **Proceed.**

For completeness, the sibling allow-lists this change also does not touch:
`DELETE FROM sessions` → `db/repositories/agent-sessions-repository.ts`, `scripts/seed-dev.ts`;
`DELETE FROM memory_relations` → `scripts/seed-dev.ts`;
`DELETE FROM prompts` → `db/repositories/prompts-repository.ts`, `scripts/seed-dev.ts`.

### 1.2 — `apps/server/src/scripts/` holds only the two expected scripts

```
seed-dev.test.ts  seed-dev.ts  upgrade-helper.test.ts  upgrade-helper.ts
```

The harness is genuinely new. **Proceed.**

### 1.3 — Target shape, re-read from `tune-hot-query-paths/design.md:3`

Verbatim:

> Every query method in the thirteen repositories plus `db/diagnostics.ts` was audited with
> `EXPLAIN QUERY PLAN` and timed at 1k / 20k / 50k, on a corpus with realistic ~1.3KB
> bodies, 768-dim embeddings for every row, ~1.35 confirmations per memory, 6 scopes, and
> ~18 entities per memory (571MB file at 50k). Session-scoped findings were re-measured on a
> second corpus with 50 000 sessions, because `sessions` grows with agent activity rather
> than corpus size and the two do not track each other.

Unchanged from what the proposal quotes. The harness therefore targets:

| Axis                   | Target from `tune`      |
| ---------------------- | ----------------------- |
| memory count           | 1 000 / 20 000 / 50 000 |
| body size              | ~1.3 KB                 |
| embedding width        | 768 dims, every row     |
| confirmations / memory | ~1.35                   |
| scopes                 | 6                       |
| entities / memory      | ~18                     |
| file size at 50k       | 571 MB                  |
| session count          | 50 000, separate corpus |

**One figure `tune` does not state: the superseded fraction.** It is in the harness's
declared shape because the `replaces` graph is walked by several of `tune`'s findings, but
`tune` never published a ratio for it. It is therefore a **harness choice, not a
reproduction**, and it is labelled as one at its declaration
(`VOLUMETRIC_SHAPE.supersededFraction`, set to 0.2). Recorded here so a later reader does not
mistake it for a measured figure. The same applies to `sessionsEndedFraction`.

### 1.4 — Embedding width and version, confirmed on disk

- `apps/server/src/embeddings/embedder.ts:24` — `EMBEDDING_DIMS = 768`
- `apps/server/src/embeddings/embedder.ts:38` — `EMBEDDING_INPUT_VERSION = 'v2-title-content'`
- `apps/server/src/embeddings/embedder.ts:22` — `EMBEDDING_MODEL_ID = 'onnx-community/gte-multilingual-base'`
- `apps/server/src/db/migrations/0014_hybrid_search_vec_rebuild.sql:37` — `embedding FLOAT[768]`

The width in the schema and the width the real embedder produces agree at 768, so the
synthetic vectors are written at the real width rather than at a width copied from prose.
`EMBEDDING_INPUT_VERSION` is recorded but deliberately **not** written by the harness: the
state marker it belongs to is the embedding worker's resume bookkeeping, and a corpus whose
vectors did not come from the embedder must not claim that marker. Consequence, stated so it
is not a surprise: a server booted against a harness corpus sees `v2-title-content` absent
and will schedule a re-embed of the whole corpus. That is correct behaviour — the vectors
really are not the model's — and it is why the harness prints the synthetic-vector caveat.

## 5. The harness's own cost (tasks 5.1–5.3)

All runs on **Machine A**: Linux 7.0.6-2-pve container, 10 cores, 9 GB RAM, Node
v22.23.1, `better-sqlite3` 12.11.1, `sqlite-vec` 0.1.6, corpus on local disk.
Wall-clock is the whole process (`createDb` + migrations + generation + close).
Every row goes through the services; nothing bypasses the write path.

### 5.1 — Wall-clock and file size at each size

| Invocation                               | Wall  | File size            | Bytes/memory | Rows produced                                    |
| ---------------------------------------- | ----- | -------------------- | ------------ | ------------------------------------------------ |
| `--memories 1000 --seed 1`               | 1.9 s | 28.8 MB (27.5 MiB)   | 28.8 KB      | 1 000 memories, 202 superseded                   |
| `--memories 20000 --seed 1`              | 28.6s | 255.9 MB (244.1 MiB) | 12.8 KB      | 20 000 memories, 4 002 superseded, 27 460 confs  |
| `--memories 50000 --seed 1`              | 72.4s | 613.4 MB (585.0 MiB) | 12.3 KB      | 50 000 memories, 10 002 superseded, 68 122 confs |
| `--memories 0 --sessions 50000 --seed 1` | 8.9 s | 54.2 MB (51.7 MiB)   | —            | 50 000 sessions, 40 076 ended                    |

**The 1k figure must not be extrapolated**, and this is the one number here that
would mislead a reader who only saw the table. Its bytes-per-memory is 2.3× the
50k figure because a fixed cost dominates it: `dbstat` attributes **18.03 MiB of
27.5 MiB to `memory_vec_vector_chunks00`**. vec0 allocates a whole chunk per
partition up front, and the corpus has 6 partitions, so ~18 MiB of vector storage
exists before the first vector is meaningful. That cost is paid once, not per
row — which is why bytes/memory falls from 28.8 KB to 12.3 KB and then stops
falling.

### 5.2 — The 50k file size against `tune`'s recorded 571 MB

`tune-hot-query-paths` recorded **571 MB at 50k**. This harness produces
**613.4 MB / 585.0 MiB**. Read as decimal MB that is **+7.4%**; read as MiB
(571 MiB = 598.7 MB) it is **+2.5%**. `tune` does not say which unit it meant, so
the divergence is somewhere in 2.5–7.4%.

**Not a stop condition.** A few percent on a file size is well inside what
differs between two corpora of the same declared shape — a different superseded
fraction alone moves it, and §1.3 records that `tune` never published one. The
harness is therefore usable to re-verify `tune`'s findings, which §8 then does
rather than asserts.

**One real shape divergence, found by measuring rather than by comparing totals**,
and it points at `tune` rather than at the harness. Its task 3.3 names its corpus
as "50 000-memory / **20 000-entity / 20 000-link**". That is **0.4 entity links
per memory** — flatly inconsistent with the "~18 entities per memory" in its own
design paragraph, which this harness reproduces at **900 000 links / 609 952
distinct entities at 50k**. So `tune`'s statistics-dependence figures (3.2, 3.3)
were taken on a corpus roughly 45× sparser on the entity axis than the corpus its
design paragraph describes. §8 quantifies what that does to its numbers. This is
exactly the class of thing the change exists to make visible: nobody could have
noticed it while the generator lived in a scratch buffer.

### 5.3 — Is the 50k run fast enough to use routinely?

**Yes — 72 seconds. But only after a bottleneck was found, named, and fixed
without bypassing the write path.** The first honest answer was no.

**The bottleneck: the build ran with an empty database's query statistics.**
`db/client.ts` runs `PRAGMA analysis_limit=1000; ANALYZE` at open and
`PRAGMA optimize` at close — the right cadence for a server, which restarts. A
bulk writer never restarts, so `sqlite_stat1` said "every table is empty" for the
entire run while `memory_entities` grew past 600 000 rows. That put
`entities.linkMemory`'s get-or-create OR chain on the degenerate
`(scope, project_id)` prefix scan whose cost is **linear in the scope's entity
count** — so the build was quadratic in its own output.

Measured, at 20 000 memories, same invocation, same seed, same machine:

| Build                      | Wall        | Rows produced                                    |
| -------------------------- | ----------- | ------------------------------------------------ |
| without statistics refresh | **149.4 s** | 20 000 / 4 002 superseded / 27 460 confirmations |
| with statistics refresh    | **28.6 s**  | 20 000 / 4 002 superseded / 27 460 confirmations |

**5.2× faster, with identical row counts** — which is the point: the fix changed
the build's cost and nothing about its shape. The generated content is a pure
function of the seed, so the two corpora agree on every generated field.

The pre-fix figure was taken twice. A first run measured 149.3 s while two other
builds shared the box, so it was re-run alone and measured 149.4 s — the
contention was not what produced the number.

The mechanism is independently corroborated by §8.1a, which measures the dominant
statement rather than the whole build: at 20k the `linkMemory` lookup costs
0.016 ms with statistics and 10.453 ms without. Times 20 000 memories that is 0.3 s
versus 209 s of entity lookups alone — arithmetic that accounts for the 121 s
difference without needing the build timing at all. Two independent measurements
of the same cause is why this is reported as a diagnosis rather than a correlation.

**The fix is not a bypass of design D6.** Rows still go through
`MemoryService`, `EntitiesRepository.linkMemory` and `VectorsRepository`
.`insertEmbedding`; the only thing added is a `refreshStatistics(handle)` call
between batches, which re-samples `sqlite_stat1` exactly as `createDb` does on
every boot. Nothing about the write path, the triggers or the derived state
changes — only what the planner believes about table sizes.

**It also does not reverse `tune` 3.1's decision.** That task considered an
_interval_ `PRAGMA optimize` for the server and rejected it, on the stated ground
that "`createDb` runs on every process start, so boot-time `ANALYZE` already
covers the whole post-hard-kill failure mode". That reasoning is sound and it is
specifically about a process that restarts. It does not extend to a single
long-lived bulk writer, which is why the refresh here lives in the harness and
not in `db/client.ts`.

## 8. Acceptance: does the harness reproduce a known result? (tasks 8.1–8.2)

Building a corpus is not the deliverable. Building one that reproduces a result
`tune-hot-query-paths` already published is. Two of its characterised queries were
re-captured on harness corpora at 20k and 50k.

**Method.** `Database.prototype.prepare` is wrapped before `createDb` opens, and
the real repository method is called, so what gets `EXPLAIN`ed is the statement the
repository actually executed rather than SQL rewritten by hand from the source.
`linkMemory`'s probe runs inside a rolled-back transaction (its INSERTs would
mutate the corpus), and its statistics-deleted arm runs against a `VACUUM INTO`
copy so the corpus keeps its own statistics.

Reproduce with:

```
pnpm run corpus:build -- --db <dir>/20k --memories 20000 --seed 1
pnpm run corpus:build -- --db <dir>/50k --memories 50000 --seed 1
```

### 8.1a — `linkMemory`'s OR chain and its statistics-dependence (`tune` 3.2)

`tune` recorded: degenerate
`SEARCH memory_entities USING INDEX memory_entities_identity_idx (scope=? AND project_id=?)`
at **6.960 ms** with no `sqlite_stat1`, versus `MULTI-INDEX OR` over **18**
four-column seeks at **0.014 ms** with statistics — "~500×".

Re-captured, OR chain width **18 pairs** at both sizes (so the "18 four-column
seeks" shape matches exactly):

| Corpus                        | With statistics                      | Statistics deleted                           | Ratio  |
| ----------------------------- | ------------------------------------ | -------------------------------------------- | ------ |
| 20k (257 851 entities)        | `MULTI-INDEX OR`, 18 seeks, 0.016 ms | `(scope=? AND project_id=?)` scan, 10.453 ms | 653×   |
| 50k (609 952 entities)        | `MULTI-INDEX OR`, 18 seeks, 0.025 ms | `(scope=? AND project_id=?)` scan, 25.212 ms | 1 008× |
| `tune`, 50k (20 000 entities) | `MULTI-INDEX OR`, 18 seeks, 0.014 ms | `(scope=? AND project_id=?)` scan, 6.960 ms  | ~500×  |

**Both plan shapes reproduce exactly, and the good arm's wall-clock matches**
(0.016–0.025 ms against 0.014 ms — the same number, within measurement noise on a
sub-30-microsecond query).

**The bad arm is 3.6× slower than `tune`'s, and that is a confirmation rather than
a contradiction.** `tune`'s own text says the degenerate plan's cost is a scan of
the scope partition, i.e. linear in the scope's entity count. The two harness
points test that claim directly: 257 851 entities → 10.453 ms and 609 952 → 25.212
ms is 2.37× cost for 2.37× entities — **linear, to two significant figures**.
Extrapolating back to `tune`'s 20 000-entity corpus predicts ~0.8 ms, so `tune`'s
6.960 ms is if anything _higher_ than its corpus size implies; what does not
happen is the harness disagreeing about the mechanism. The magnitude difference is
the entity-axis sparsity recorded in §5.2, not a modelling failure.

### 8.1b — `searchMemoryIds`' ORDER BY temp B-tree (`tune` 4.1, fix not yet applied)

`tune` 4.1 proposes `memory(scope, project_id, status, created_at)` to remove a
temp B-tree, quoting **12.8–38.6 ms → 0.03–0.40 ms**. That index is _not_ applied
yet (group 4 is what this harness unblocks), so the pre-fix plan should still show
the sort.

Re-captured, project scope, `limit 20 offset 0`:

| Corpus | Plan                                                                                                     | Wall     |
| ------ | -------------------------------------------------------------------------------------------------------- | -------- |
| 20k    | `SEARCH m USING INDEX memory_scope_seen_idx (scope=? AND project_id=?)` + `USE TEMP B-TREE FOR ORDER BY` | 0.696 ms |
| 50k    | same plan, both lines identical                                                                          | 4.764 ms |

**The plan shape reproduces**, including the specific index the planner picks
(`memory_scope_seen_idx`, not `memory_scope_project_status_idx`) and the temp
B-tree that is the whole point of 4.1. Cost grows 6.8× for 2.5× the rows, which is
the super-linear growth a sort-the-whole-partition plan predicts and the reason
4.1 exists.

**The wall-clock is well below `tune`'s 12.8–38.6 ms and that gap is not
explained here.** 4.764 ms against a 12.8 ms floor is a 2.7× difference on the
same plan shape at the same corpus size. Candidate causes, none of them verified:
`tune`'s range plausibly spans query variants this probe did not run (its own text
names an `includeGlobal` arm at 27.6 ms, and `includeGlobal: false` was used
here), a different `limit`/`offset`, or a different machine. **Recorded as an open
discrepancy for `tune` group 4 to resolve on this corpus rather than papered
over** — the plan claim is confirmed, the magnitude claim is not.

### 8.2 — Verdict

The harness's acceptance evidence is 8.1a: an independently generated corpus
reproduces `tune` 3.2's plan shapes on both arms, matches its fast-arm timing, and
independently confirms the linearity `tune` asserted about its slow arm. 8.1b
reproduces 4.1's plan shape and leaves its magnitude as a named open question.

Two things were learned that could not have been learned from the prose: `tune`'s
statistics-dependence corpus was ~45× sparser on the entity axis than its design
paragraph claims (§5.2), and the same degenerate plan makes a bulk build quadratic
in its own output (§5.3). Neither was findable while the generator lived in a
scratch buffer, which is the argument for this change in one line.

## 6. Wiring, and two deviations from the proposal's file list (tasks 6.1–6.2)

### 6.1 — One `package.json` script entry

`"corpus:build": "pnpm --filter @rembric/server exec tsx src/scripts/seed-volumetric.ts"`,
added to the **root** `package.json` only — one entry, not the two that `eval`
uses (root delegating to a workspace script), because the task asked for one. The
`e2e:installer` entry is the precedent for `--filter … exec` from the root.

Named `corpus:build`, deliberately not `seed:volumetric`. The two scripts have
opposite safety properties — `seed-dev` is allow-listed to `DELETE FROM memory`,
this one asserts it can never delete — and sharing a `seed:` prefix is exactly the
glance-level confusion the task asked to avoid.

### 6.2 — Nothing in the shipped image invokes it

Verified rather than assumed. `git status --porcelain` reports **no change** to
`apps/server/Dockerfile`, `docker-compose.yml`, `docker-compose.dev.yml` or
`apps/plugin/`, and `grep -rn 'seed-volumetric\|corpus:build'` over all four
returns nothing. The harness is reachable only from a developer's shell.

### The two deviations, stated rather than buried

Task 6.2 says the diff must show only the script, its test, `package.json` and
this change folder. It shows two more files. Both are deliberate; neither touches
the shipped image, which is what 6.2 exists to protect.

**1. `apps/server/src/db/diagnostics.ts` — one new exported function.**
`refreshStatistics(handle)`, four lines including the doc comment. Required by
§5.3: the build is quadratic without it, and the alternative was raw SQL in the
script, which `CLAUDE.md` confines to `src/db/` and grants `seed-dev.ts` as a
named exception this change did not want to add a second of. It has **no
production call site** — `grep` shows the harness as its only caller — so the
proposal's "no production code path is touched" still holds in substance: no
existing path's behaviour changes.

**2. `openspec/changes/tune-hot-query-paths/corpus.md` — new file in another
change's folder.** Required by task 8.3, which asks that `tune` be handed its
invocations "in that change's notes". Putting them in this folder instead would
satisfy 6.2's letter and defeat 8.3's purpose, since a reader working through
`tune` would never find them. 8.3 was preferred over 6.2's file list on the
grounds that 6.2's stated purpose — "confirm nothing in the shipped image invokes
it" — is fully met.

## 7. Verification (tasks 7.1–7.5)

### 7.1 — Typecheck, lint, tests, with before-and-after counts

| Gate                   | Result                                                      |
| ---------------------- | ----------------------------------------------------------- |
| `pnpm run typecheck`   | clean                                                       |
| `pnpm run lint`        | clean                                                       |
| `pnpm test` **before** | 119 files · **1 961 passed**, 19 failed, 10 skipped (1 990) |
| `pnpm test` **after**  | 120 files · **1 991 passed**, 19 failed, 10 skipped (2 020) |

**+30 passing tests, +1 file, and exactly the same 19 failures.**

Those 19 failures are pre-existing and environmental, which was verified rather
than assumed: with this change's four files stashed, the identical 19 fail in the
identical three files (`../plugin/test/extract-facts.test.ts` 12,
`../plugin/test/stop-nudge.test.ts` 4, `../plugin/test/stop-sync.test.ts` 3).
They are plugin **shell** tests and `which jq` reports **not found** on this
machine — `jq` is installed at `/root/bin`, off the shell's PATH. Nothing in this
change touches `apps/plugin/`.

`apps/server/src/test/invariants.test.ts` was also run on its own: **67 passed**.

### 7.2 — `pnpm run check:delta-freshness`

`delta-freshness: ok (2 active change(s))`, exit 0. This change carries no
`MODIFIED` block — both delta specs are `ADDED` only — so a clean pass with
nothing to review is the expected result, and it was confirmed rather than
assumed.

### 7.3 — `openspec validate --strict`

`Change 'commit-the-volumetric-harness' is valid`, exit 0.

### 7.4 — `pnpm run eval` was NOT run, as a decision

No retrieval, ranking, scoring or embedding path is touched: the harness reads no
embedder, and its vectors never reach a scoring function. Running the eval would
produce a number that means nothing about this change and would imply, by its
presence in this file, that the corpus can speak to retrieval quality — the exact
inference D2 and the `data-access` delta forbid. Recorded so the omission is a
decision rather than a gap.

### 7.5 — Append-only, untouched by construction

The harness issues no `DELETE` and no `UPDATE` of `content` or `title`; `grep` for
either over the file returns nothing outside the refusal messages that explain
their absence, and the structural assertions in
`seed-volumetric.test.ts::"is structurally incapable of deleting"` hold that shut.

Precisely stated, because "only inserts" would be slightly too strong: the harness
inserts, and its `topic_key` chains cause the sanctioned `active → superseded`
status flip through `MemoryService.saveWithTopicKey`. That flip _is_ the
append-only lifecycle (`CLAUDE.md`: "Lifecycle = `status` flips … plus `replaces`
links"), not an exception to it — no row is deleted and no `content` is rewritten.
It happens through the service, which is the only thing entitled to do it.

The `DELETE FROM memory` allow-list is unchanged at its two entries, asserted by
this change's own test rather than by inspection.
