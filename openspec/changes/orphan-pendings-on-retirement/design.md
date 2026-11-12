## Context

A pending `memory_relations` row asks an agent how two memories relate. Once either memory leaves `active`, the question has no useful answer:

- the agent queue withholds the row (`endpointsActive`, `packages/db/src/repositories/relations-repository.ts:99-102`, applied by `listPendingInScope` and `countPendingInScope`);
- a `supersedes` verdict on it is refused (`packages/core/src/services/relations.ts:413-424`);
- save-time detection would never create it, because detection admits only active targets and runs only for an active saved row.

Today every retirement leaves those rows `pending`. The parent change `drain-stale-save-time-pendings` closes them in the consolidation sweep (its D4 retired-endpoint drain), at most once per day per project and in bounded batches. Its D4 recorded "close on retirement" as alternative A and deferred it for two reasons: retirement happens on at least six write paths, and missing one would silently re-create the backlog; and a memory reactivated by an undo would need its relations restored. This change is alternative A, with both reasons answered: one helper with an enforcement scan over every path (D2, D7), and an undo that restores what the retirement orphaned (D6).

The building blocks exist after the drain change:

- `RelationsService.orphan(judgmentId, reason, judgedAt?)` flips one `pending` row to `orphaned` with `marked_by_kind = 'consolidator'` and throws when the row is no longer pending (`relations.ts:301-314`);
- `recordOrphanPromote(repos, { …, appliedAt? })` journals one `orphan_promote` op (`packages/core/src/consolidation/operations.ts:95-119`);
- passing one timestamp to both makes the undo guard exact (the drain's D6 and D8): the `orphan_promote` undo branch resets the relation only when its `judged_at` is not later than the op's `applied_at`, and otherwise keeps the later verdict and reports it in `keptVerdicts` (`operations.ts:182-211`).

## Goals / Non-Goals

**Goals:**

- No write path can retire a memory and leave a pending judgment touching it.
- Every orphaning is journaled in the same transaction as the retirement, distinguishable from sweep orphanings, and undoable.
- Undoing a journaled retirement restores what it orphaned, and never overwrites a later verdict.
- A future retirement path cannot skip the helper without a test going red.

**Non-Goals:**

- Closing the pending rows that already have a retired endpoint. The drain does that; no backfill or migration is added.
- Inventing an undo for retirements that have none today (`topic_key` revision, judged `supersedes`, merge undo).
- Carrying a pair forward to a successor (D9).
- Changing the drain's selection, rules, bounds or summary.
- Any schema change, migration, new table, column or op type.

## Decisions

### D1 — One helper in `operations.ts`, built from the existing primitives

`orphanPendingOnRetirement(repos, relations, { retiredIds, status, cause, at, runId? })` lives in `packages/core/src/consolidation/operations.ts`, next to `recordOrphanPromote`, and runs inside the caller's transaction (it opens none). For each pending row touching a retired id, in `(created_at, judgment_id)` order, it calls `relations.orphan(judgmentId, reasoning, at)` and then `recordOrphanPromote(repos, { …, relation: null, reasoning, appliedAt: at })`. `at` is the retirement's own timestamp, so the retirement, the relation's `judged_at` and the op's `applied_at` all carry one instant.

The `relations` parameter is typed `Pick<RelationsService, 'orphan'>`:

- `RelationsService` passes itself;
- `MemoryService` passes a `RelationsService` it builds over its own repositories and transaction runner;
- `applyDecay` and `undoOp` build one over theirs, so their published signatures do not change.

That makes `relations.ts` and `operations.ts` import each other. The cycle is safe under ES modules because neither module reads the other's bindings while it evaluates: the helper is a hoisted function declaration, and `RelationsService` is only constructed inside function bodies.

Alternatives considered:

- **A second orphan-and-journal implementation in the helper**, writing `markOrphanedPending` and `insertOp` directly. Rejected: two paths that must stay identical drift, and the drain's guard depends on how `orphan` stamps `judged_at`.
- **Thread a `RelationsService` through `applyDecay`, `undoOp` and `undoRun`.** Rejected: about fifty call sites, the dashboard's among them, change for no behavioural gain.
- **Orphan inside the repository methods that flip status.** Rejected: repositories hold no services, never open transactions, and journaling is a consolidation concern.

### D2 — Selection: every pending row on either side, whatever the other endpoint

The helper reads `RelationsRepository.listPendingTouchingAny(memoryIds)`: rows with `status = 'pending'` whose `source_id` or `target_id` is a retired id. It is keyed by memory ids, like `listTouchingAny`. Both sides are served by existing indexes, `memory_relations_source_status_idx (source_id, status)` and `memory_relations_target_status_idx (target_id, status)`, and task 2.2 records the query plan.

A pair is orphaned even when its other endpoint is already retired (owner decision 4): both endpoints must be active for a pair to be adjudicable, and a pair touching two retired memories is no more answerable than one touching one.

Scope needs no extra filter: `createPending` refuses a cross-scope pair (`relations.ts:125-126`), so every row touching a memory lies in that memory's scope.

Alternative: reuse `listTouchingAny` and filter `pending` in code, as the merge preview does. Rejected for the write path: it also loads every judged row of the memory.

### D3 — The retirement and its orphanings commit or roll back together

The helper runs inside the transaction that flips the status. If an orphaning or its journal insert throws, the whole retirement rolls back and the caller sees the error. A concurrent verdict cannot interleave: better-sqlite3 runs the transaction synchronously on one connection, and the helper selects and orphans in that same transaction.

This is the discipline the journaled retirements already follow: `memory.archive` fails when its `agent_memory_archive` journal insert fails, and `applyDecay` writes its archive and its op in one transaction.

Alternatives considered:

- **A savepoint per pair, swallowing failures so the retirement still commits**, with the drain catching up later. Rejected: it re-creates the exact state this change removes, and a broken journal would be invisible until someone noticed the drain doing the work.
- **Orphan after the retirement commits.** Rejected: it leaves a window, and a crash in it re-creates the backlog.

### D4 — Where each orphaning is journaled

| Retirement                                  | Its own journal op today                       | Orphanings journaled in |
| ------------------------------------------- | ---------------------------------------------- | ----------------------- |
| `memory.merge` commit                       | `merge`, in a `maintenance` run                | that run                |
| `memory.archive` tool and dashboard archive | `agent_memory_archive`, in a `maintenance` run | that run                |
| decay pass                                  | `decay`, in the sweep's run                    | that run                |
| `topic_key` revision                        | none (an `agent_topic_key` relation row)       | a new `maintenance` run |
| judged `supersedes`                         | none (the judged relation row)                 | a new `maintenance` run |
| merge undo (successor archived)             | none (it reverts the `merge` op)               | a new `maintenance` run |

A new run is opened only when the retirement has at least one pending row to orphan, with `scope = 'maintenance'`, `started_at = finished_at = at`, and the summary `{"kind":"retirement_orphan","orphaned":N}`. That is the shape `journalMaintenanceOp` already writes for `agent_memory_archive`, `merge` and the purges. A merge undo's orphanings go to a new run, not to the merge's run, so the reverted run does not gain active ops.

The reasoning is `endpoint retired at retirement: <source|target|source and target> <superseded|archived> by <cause>`. `recordOrphanPromote` prefixes it with `orphaned: `. The prefix differs from the deadline's `unjudged after …`, the rules drain's `stale under current rules` and the retired-endpoint drain's `endpoint retired: ` (owner decision 3). The full prefix up to its colon is what distinguishes it from the drain's, and a test pins all four.

The sweep run's summary is not changed: its top-level `archives` and `orphaned` keep their meaning, and a decay's orphanings are listed as ops of the run. `memory.doctor`'s `lastRunOps` copies a summary's top-level numbers and `kind`, so a `retirement_orphan` maintenance run reads `{ kind: 'retirement_orphan', orphaned: N }` when it is the latest run, exactly as an `agent_memory_archive` run already reads `{ kind: 'agent_memory_archive', archived: 1 }`.

Alternatives considered:

- **One run per retirement path per day.** Rejected: a run would collect ops from unrelated retirements, and "undo run" would undo them together.
- **Nest a counter in the sweep summary.** Rejected: the dashboard requirement that pins the summary shape is modified by the drain change, and the ops list already shows them.

### D5 — The retirement paths

The only writes that move a memory to `superseded` or `archived` are five `MemoryRepository` methods (`packages/db/src/repositories/memory-repository.ts:482-515`, `:793-799`). Data-access confinement forbids SQL outside `packages/db/src/`, so every retirement is a call to one of them:

| Method               | Caller                                                                        | Path                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `markSuperseded`     | `MemoryService.saveWithTopicKey` (`packages/core/src/services/memory.ts:175`) | `topic_key` revision                                                                                                                                                                 |
| `markSuperseded`     | `RelationsService.applySupersedesSideEffect` (`relations.ts:427`)             | judged `supersedes`, from `judge`, `judgeInScope` and `compare`                                                                                                                      |
| `markSupersededMany` | `MemoryService.commitMerge` (`memory.ts:553`)                                 | `memory.merge` commit                                                                                                                                                                |
| `markArchived`       | `MemoryService.archive` (`memory.ts:516`)                                     | `memory.archive` (`packages/mcp/src/memory-tools.ts:1084`) and the dashboard archive actions (`apps/web/src/app/dashboard/memories/page.tsx:55`, `:99`; `memories/[id]/page.tsx:44`) |
| `archiveActive`      | `applyDecay` (`operations.ts:81`)                                             | decay pass                                                                                                                                                                           |
| `archiveOne`         | `undoOp`, merge branch (`operations.ts:169`)                                  | merge undo archives the successor                                                                                                                                                    |

These are not retirements and are left alone: reactivations (`reactivate`, `reactivateOne`), the operator purge of already-archived rows, and inserts that create a row with a non-active status (only tests and seed scripts do that). `seed-volumetric.ts` retires through `saveWithTopicKey`, so it goes through the helper.

### D6 — Undo symmetry

**Linking.** A retirement's orphanings are the active `orphan_promote` ops in the retirement op's own run whose reasoning carries the retirement prefix and whose pair touches one of the memories the op retired (its `affected_ids`). The deadline and drain ops in a decay's run carry other prefixes. The memory test keeps the link exact even when one run holds several retirement ops: the sweep never does that, but `applyDecay` is public and a caller can share a run, and the per-path cost measurement first did (task 7.2). The read is `listActiveOps(runId)`, which rides the `run_id` index.

**Restoration.** After the reactivation, `undoOp`'s reactivating branch walks the linked ops:

1. When the relation was written after the op (`judged_at` null or later than `applied_at`), it is kept and reported in `keptVerdicts`, and the op is marked reverted. This is the drain's guard, reused through the extracted `orphan_promote` undo branch.
2. When either endpoint is not `active` after the reactivation, the relation stays `orphaned`, its op stays active, and the undo reports it in a new `keptOrphaned` list (judgment id and retired endpoint). This happens when a memory was skipped because its topic slot is now taken, or when the other endpoint was retired since. Restoring such a row would re-create an unadjudicable pending row that the drain would then never close, because the drain excludes a judgment id named by a reverted `orphan_promote` op.
3. Otherwise the extracted branch resets the relation to `pending`, and the op is marked reverted and named in `alsoReverted`.

All of it runs in the undo's one transaction.

**`undoRun`.** It undoes a run's ops in reverse order. It skips every orphaning linked to an active reactivating op of the run and lets that retirement's undo handle it, so the endpoint check sees the reactivated rows. Otherwise, an individually undone linked op could restore a pair whose endpoint the retirement undo then leaves retired. The ids in `alsoReverted` join `undoRun`'s `reverted` list.

**Per path:**

| Retirement                          | Undoable today                                                                                                                | Undo of the retirement restores its orphanings                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| decay                               | yes, `decay` op                                                                                                               | yes                                                                                                     |
| `memory.archive`, dashboard archive | yes, `agent_memory_archive` op                                                                                                | yes                                                                                                     |
| `memory.merge` commit               | yes, `merge` op                                                                                                               | yes; the same undo archives the successor, whose own pending judgments are orphaned into a new run (D4) |
| `topic_key` revision                | no                                                                                                                            | not applicable: no undo exists, and this change adds none                                               |
| judged `supersedes`                 | no; only the historical LLM-era `orphan_promote` verdict ops reverse a supersede, and no retirement-prefix op exists for them | not applicable                                                                                          |
| merge undo                          | no; a reverted op cannot be re-applied                                                                                        | not applicable                                                                                          |

Every orphaning stays individually undoable from the dashboard. An individual undo restores the row whatever its endpoints, which is what the drain's spec already does for an undone retired-endpoint drain. The drain then never re-drains that row, and the deadline step still can.

**Consequence for the drain.** A pair restored by a retirement undo is named by a reverted `orphan_promote` op, so the drain's "undo is final" rule excludes it from every later drain step. Only the deadline step or a new retirement closes it again. This follows from the drain's own rule and is accepted: the operator undid the retirement, which restored the question.

Alternatives considered:

- **No symmetry: leave the orphanings in place after a retirement undo.** Rejected by the owner (decision 2). A memory brought back by an undo would silently lose its open questions.
- **Restore regardless of endpoint status.** Rejected: see step 2.
- **Link through the reasoning text (the retirement op id in the string).** Rejected: the run already links them, and parsing ids out of prose is fragile.

### D7 — Enforcement: an AST scan over the source roots

A new block in `apps/web/src/test/invariants.test.ts`:

1. **Inventory.** It scans `packages/db/src/repositories/` for class methods whose body updates `memory` with `status` set to `'superseded'` or `'archived'` (Drizzle `.set({ status: … })` or raw `UPDATE memory … SET status`), and asserts the set equals the five methods of D5. A new flip method fails the test until it is added to the inventory, and so falls under step 2.
2. **Call sites.** It parses every non-test source file under the four scanned roots (`apps/web/src`, `packages/core/src`, `packages/db/src`, `packages/mcp/src`) with the TypeScript compiler API. For every call to an inventory method outside the repositories, it requires a call to `orphanPendingOnRetirement` later in the same enclosing function, and lists each offender with file and line.
3. **Controls.** Run on a source string with an unguarded flip, the scan reports it. Run on the real `operations.ts` text with the helper call removed from `applyDecay`, it reports `applyDecay`. Run on that text unchanged, it reports nothing. An anchor asserts the six call sites of D5 are found, so a scan that silently finds nothing fails.

The TypeScript compiler is already a dev dependency of `apps/web`, so no dependency is added.

Alternative: a regex over source lines. Rejected: "the same function" needs the enclosing function's extent, which a line regex cannot give.

### D8 — The visible text that described the old behaviour

- The `memory.merge` preview warning `pending_judgments` said "they stay pending". It now says that they are closed as orphaned when the merge commits, and that undoing the merge restores them. The warning feeds the fingerprint, so a preview issued by the previous build no longer confirms after an upgrade: the caller gets `fingerprint_mismatch` with a fresh preview, which is what the protocol already does for any state change.
- The `memory.merge` tool description said "pending judgments on an original stay pending". It now says they are closed and restored by an undo.
- The dashboard's `partialUndo` gains one note for `keptOrphaned`.

### D9 — Alternatives to the change as a whole

The percentages are the drain design's D4 figures, measured on the same backup copy of a real installation, and are of the retired-endpoint pending rows.

- **Status quo, leaving the rows to the deadline step.** Rejected. The rows are bounded at `JUDGMENT_ORPHAN_DEADLINE_MS` (14 days), but they were 28% of the pending queue and inflated the operator counts the whole time.
- **The drain only.** Kept as the safety net, but not enough alone. It covers every path in one place, but with up to a day of delay per project and in bounded batches, so the state exists in between and the pending counts stay inflated.
- **Carry the pair forward to the successor.** Rejected:
  - only 54% of the single-side retired rows had an active successor;
  - for 46% of those, the successor was already related to the counterpart;
  - it would have created new pending rows for 16% of the retired rows;
  - the successor already ran its own save-time detection when it was saved, so carrying forward duplicates work into a queue the owner wants smaller.
- **Display-only filtering in the dashboard.** Rejected: it changes what is shown, not what the table holds.

### D10 — A late verdict is accepted

Only `supersedes` is refused on a retired pair. A verdict could still be recorded through a `judgmentId` an agent obtained earlier, and a `not_conflict` dismissal is carried forward to later revisions through the `replaces` ancestry. As first written, this change made that `memory.judge` fail with `conflict`, because the row was already `orphaned`.

`measurements/retired-verdicts.mts`, run on the owner's real database (aggregates only), measured the cost: 1.84% of all historical verdicts (265 of 14 377) were recorded after one endpoint retired. 150 of those came within 60 s, typically in the same `memory.judge_batch`: S→T `supersedes`, then T→U `related`. 83 of the 265 are `not_conflict`, and those dismissals carry forward to later topic revisions.

**Decision (owner): accept the late verdict.** A verdict for a relation orphaned BY A RETIREMENT moves it from `orphaned` to `judged` and is applied exactly as for a pending row. "Orphaned by a retirement" is a non-reverted `orphan_promote` op whose `created_id` is the `judgmentId` and whose reasoning starts with `orphaned: endpoint retired at retirement: ` (`RETIREMENT_ORPHANING_PREFIX`). Deadline and drain orphanings stay terminal, and a `supersedes` verdict still requires both endpoints `active` (the existing guard in `applySupersedesSideEffect`).

- **Repository methods.** `ConsolidationRepository.listLiveOrphanPromoteOps(judgmentId)` and `RelationsRepository.markJudgedFromOrphaned`, which requires `status = 'orphaned'` and sits next to `markJudged`. The service decides on the prefix, so no SQL leaves `packages/db`.
- **Undo.** The existing guard (`judged_at` later than `applied_at` keeps the verdict and reports it in `keptVerdicts`) already covers it. A late verdict in the same millisecond as the orphaning would look untouched, so the new `judged_at` is at least `applied_at + 1 ms`.
- **Alternative rejected:** leaving the row orphaned and recording the verdict with `memory.compare`. It cannot record `not_conflict` and loses the pair's `judgmentId` handle.

### D11 — Coordination with the parent changes and `add-memory-merge`

- No requirement modified by `add-save-time-lexical-floor` or `drain-stale-save-time-pendings` is modified here. The new behaviour is three ADDED requirements, plus one MODIFIED memory requirement that neither parent touches, so this change archives after both parents in any order between them.
- The drain's ADDED scenarios "A superseded source is drained" and "An archived target is drained" stay true: after this change, such rows are ones that predate it or that an operator restored.
- The published consolidation scenario "A retired-endpoint row is withheld from the agent but still orphaned" stays true on the same terms, and is not modified.
- `add-memory-merge` is active and unarchived. Its ADDED requirement "The MCP server MUST expose `memory.merge` with a preview-then-confirm contract" says "Pending judgments touching an original are left as they are", which this change contradicts. A MODIFIED delta cannot target it until it is published: `check-delta-freshness` refuses a header that is not in `openspec/specs/`. **Archive order:** `add-memory-merge` first. Then, before this change archives, it gains a MODIFIED delta of that requirement replacing the sentence (task 9.3).

## Risks / Trade-offs

- **[Risk] A future retirement path skips the helper.** → The D7 scan fails on any call site of a flip method whose function does not call the helper, and on any new flip method in a repository. Its controls prove it detects a removed call.
- **[Risk] A failure in the orphaning fails a user's save, archive, merge or verdict.** → It is the same failure surface as the journal insert those paths already make in the same transaction (D3). The per-path rollback tests pin that nothing is half-applied.
- **[Risk] An agent loses a late `not_conflict` dismissal on a retired pair.** → Measured at 83 of 14 377 historical verdicts on the owner's database. A verdict on a retirement-orphaned judgment is accepted (D10); deadline and drain orphanings stay terminal.
- **[Trade-off] Each `topic_key` revision, judged `supersedes` or merge undo that has pending judgments adds a `maintenance` run to `/dashboard/consolidation`.** → Accepted because each run is a reversible unit of the journal, as the archive and merge runs already are. A retirement with nothing to orphan adds none.
- **[Trade-off] A pair restored by a retirement undo is never drained again by the drain.** → Accepted because it follows from the drain's own "undo is final" rule. The deadline step and a later retirement still close it.
- **[Trade-off] Retirement paths do slightly more work.** → Accepted. Measured per path at 1 000, 20 000 and 50 000 memories (`measurements/README.md`, task 7.2), the added median is 0.01–0.07 ms when there is nothing to orphan and about 0.08 ms per orphaned row, flat across corpus sizes; a merge undo, which orphans the successor's rows and restores the originals', adds about 1 ms for nine rows.
- **[Risk] Undo ordering inside `undoRun` restores a pair whose endpoint the run's own retirement undo then leaves retired.** → `undoRun` leaves linked ops to their retirement's undo (D6), and a test pins it with a topic-slot skip.

## Migration Plan

- No schema change and no migration. The helper runs from the first retirement after the upgrade. Rows that already have a retired endpoint are left to the drain.
- Rollback: revert the commits. Orphanings already applied stay journaled and undoable from the dashboard.

## Open Questions

1. **Production count of late verdicts.** Answered: 265 of 14 377 (1.84%), 83 of them `not_conflict`. The change accepts them (D10).
2. **`add-memory-merge` archive order.** Confirm `add-memory-merge` archives before this change, so the merge requirement's "left as they are" sentence can be MODIFIED here (D11).
3. **Maintenance-run volume.** Should frequent `retirement_orphan` runs be grouped or filtered in the consolidation list later? This is not in scope.
