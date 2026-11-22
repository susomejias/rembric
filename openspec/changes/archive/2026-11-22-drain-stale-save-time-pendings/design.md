## Context

Save-time detection (`findSaveTimeCandidates`, `packages/core/src/services/save-time-candidates.ts:44-167`) merges three channels:

- **Vector:** a kNN pool of `CANDIDATE_POOL_SIZE = 20` (`:16`, `:63-68`). Similarity is `1 - clamp(distance)` (`:72`) and a row is admitted at `VEC_THRESHOLD` (`:78`).
- **Lexical:** a bm25 pool of 20 (`:84-90`). Similarity is `tokenContainment(tokenSet(saved.content), tokenSet(title + "\n\n" + content))` (`:80`, `:92`) and a row is admitted at `LEXICAL_CANDIDATE_FLOOR` (`:93`).
- **Entity:** up to 20 rows per extracted entity (`:127-134`), behind a rarity gate that reads the current link count and active total (`:108-125`).

The merged list is capped at `perSaveMax` (`:166`), and the post-save path turns that capped list into pending rows (`packages/core/src/services/save-curation.ts:48-54`).

The sweep runs per scope, at most once per 24 h (`packages/core/src/consolidation/runner.ts:43`, `:89-92`). It is triggered on session start through `setImmediate` (`apps/web/src/lib/services.ts:118-125`). That one callback calls `sweepFor`, which sweeps two scopes, the default project and the session's own project (`runner.ts:57-64`). It runs synchronously on the single Node thread with better-sqlite3, so every millisecond it spends blocks other requests.

The dashboard's "run now" calls `forcedSweep()` (`apps/web/src/app/dashboard/consolidation/page.tsx:54`, `services.ts:153`). That reaches `runAll({ force: true })`, which sweeps every project in one synchronous call inside the request and bypasses the throttle (`runner.ts:50-55`, `:66-75`). The deadline step orphans at most 50 rows per run (`runner.ts:44`, `:125-152`).

Pending rows created before `add-save-time-lexical-floor` came from rank-only lexical admission. That change's D8 left them for the deadline step. This change supersedes D8 with a permanent, rule-driven drain.

## Goals / Non-Goals

**Goals:**

- Orphan, automatically and reversibly, every pending pair that no current channel would admit and that shares no entity, and every pending pair with a retired endpoint (D4).
- Never drain a pair any channel admits, and never drain on an unknown verdict.
- Process a backlog only in bounded runs, each with a measured blocking budget per sweep call and per-pair transactions, and never let kept pairs, slow hosts or other scopes stall progress.
- Leave every published output unchanged except the dashboard's run detail. `memory.doctor` keeps its exact shape.
- Never invoke the embedding model, and keep a pair whose stored vector is missing.
- Keep the shipped save path byte-for-byte identical in behaviour.

**Non-Goals:**

- Orphaning by age, which stays the deadline step's job.
- Any schema change, migration, new table, new column or new op type.
- Fixing the deadline step's non-atomic orphan-then-journal pair (`runner.ts:136-146`). It is recorded as an advisory under Risks.
- Changing the maintenance card's "QUEUED WORK" label (see Open Questions).

## Decisions

### D1 — Evaluate the pair directly, through one shared per-pair predicate

Three pieces move out of `findSaveTimeCandidates` into exported functions in the same module, which the function then calls:

- the lexical measure (`:80`, `:92`, `:139`);
- the vector distance-to-similarity mapping (`:72`);
- the two threshold comparisons (`:78`, `:93`).

A new `evaluatePair(repos, projectId, sourceId, targetId, opts)` in that module calls the same functions on the specific pair. It orients the pair as at save time, with `source_id` as the saved memory and `target_id` as the candidate.

The vector distance comes from a new public point read, `pairCosineDistance(projectId, sourceId, targetId): number | null`. It applies, in SQL, the same `vec_distance_cosine` that `knnCandidates` uses (`packages/db/src/repositories/vectors-repository.ts:79`) to the two stored rows, and returns `null` when either row is missing. It does not reuse `findEmbedding`, which is private (`:91`).

The evaluator answers "does this pair pass a channel at any rank", because no pool or cap is involved. Every rule it drops (pool rank, MATCH term selection, exclusion ids, per-save cap) only narrows what detection admits. So the evaluator admits a superset of what detection would admit for the pair, and its errors can only keep a row.

The shipped save path is pinned three ways:

- `pnpm run eval:save-time` output is byte-identical before and after the extraction;
- the existing `save-time-candidates.test.ts` passes unedited;
- an agreement test asserts that every candidate `findSaveTimeCandidates` returns at an unbounded cap is admitted by `evaluatePair`.

Alternatives considered:

- **Re-run `findSaveTimeCandidates` for the source with an unbounded cap.** Rejected. The pool bound (`:67`, `:89`, `:133`) still applies, so a genuine pair pushed out of today's top 20 by corpus growth would be drained. It also costs a full FTS and kNN query per source.
- **Raise `poolSize` for the re-check.** Rejected. It is still a bound, and its cost grows with the corpus.
- **Restate the thresholds in consolidation.** Rejected. Two copies of the thresholds can drift apart.

### D2 — Entity channel: any shared entity keeps the pair

The drain treats the entity channel as "admitted" when the two memories share any (kind, value). It does not apply the rarity gate (`:121-125`).

The gate reads `entityLinkCount` and `scopeActiveMemoryCount` at call time (`packages/db/src/repositories/entities-repository.ts:174-209`). Those counts drift as a corpus grows, so an identifier that was rare when the pair was created can fail the gate today. Draining a genuine identifier-anchored contradiction is the worst failure this step can have.

Each endpoint's entity set is its stored links (`findEntitiesForMemories`, `entities-repository.ts:152-172`) unioned with a fresh `extractEntities(title, content)` of that endpoint. That is the call the save path runs for the saved memory (`save-curation.ts:41`), and here it runs for the source AND the target. Links alone are not enough. When extraction fails, the backfill worker records a scan with no links so the row leaves its queue (`packages/core/src/services/entity-backfill-worker.ts:50-55`, `entities-repository.ts:101-104`), so a scan record does not prove a memory has no entities. Every source of entities only adds keeps. An extraction that throws makes the entity verdict `unknown`.

What "shared identifier" covers is what the extractor recognises, within its limits:

- **Kinds:** URL, path, ticket, error code, env var, CVE id, git ref, hostname, IP address, MAC address, systemd unit and UUID (`extractor-rules.ts:222-412`).
- **Budget:** at most `MAX_ENTITIES = 250` per memory, fair-shared across kinds (`entities.ts:17`, `:32-53`).
- **Input bound:** the first `MAX_INPUT_CHARS = 200 000` characters of title plus content (`entities.ts:14`).

`DRAIN_MAX_PAIR_CHARS` (D3) is capped at that input bound, so every pair the drain evaluates is extracted in full. An identifier of a kind the extractor does not know, or one cut by the per-memory budget, does not keep a pair.

Alternative: apply today's rarity gate, as detection does. Rejected because of the drift. The drained set therefore stays a strict subset of "not admitted today".

### D3 — Three-valued verdicts; "unknown" always keeps

The evaluation runs in a fixed order:

1. Read both endpoint rows' status and the lengths of their title and content. The lengths come from SQL `length()`, before any content is loaded.
2. If either row is unreadable, keep the pair.
3. If either row is readable and not `active`, drain the pair for a retired endpoint (D4). No content and no channel is read.
4. If either endpoint's title plus content is longer than `DRAIN_MAX_PAIR_CHARS`, keep the pair as `unknown`.
5. Otherwise evaluate the three channels.

Each channel returns `admitted`, `not_admitted` or `unknown`, and a pair is drained by the rules only on three `not_admitted` verdicts. A verdict is `unknown` in these cases:

- **Vector:** either endpoint has no stored embedding (`pairCosineDistance` returns `null`); a model change wipes every vector (`packages/core/src/embeddings/state.ts:64-88`).
- **Vector:** the injected `vectorIndexCurrent()` returned false at the start of the drain step (D10).
- **Entity:** extraction throws for either endpoint (D2).
- **Any channel:** the evaluation throws. The error is caught per pair, and the rest of the run continues.

**Size bound.** `DRAIN_MAX_PAIR_CHARS` exists because `memory.save` content has no maximum, and the per-pair work (two `tokenSet` calls and two extractions) grows with it.

The parent's prototype instrument (`measurements/bounds.txt`: wall clock of one pair evaluation, warm, median of 5, synthetic prose) puts one pair at 2.21 ms with both bodies at 32 000 characters, 14.08 ms at 200 000, and 50.06 ms at 1 000 000. Tokenization dominates at the top end.

The value is the largest measured size at which the worst shape stays within 5 ms, one tenth of the 50 ms per-call budget target, capped at the extractor's input bound (D2). Task 1.5 records that choice. An oversized pair is kept, never drained by the rules.

Unknown pairs are evaluated again when the cursor next reaches them (D7).

Alternative: defer the whole step while a scope has embedding or scan backlog. Rejected for now, because per-pair unknowns already keep every affected row, and the deferral would need a new scoped backlog read. See Open Question 1.

### D4 — Retired endpoints are drained, not left to the deadline step

A pending relation with a superseded or archived endpoint is orphaned by the drain, with its own reasoning prefix. Three facts support this:

- **No agent can ever judge these rows.** They are withheld from the agent queue (`openspec/specs/memory/spec.md:1615-1621`; `relations-repository.ts:87-90`, applied at `:376` and `:395`). Before this change, nothing but the deadline step or an operator could close them.
- **The current rules would never create them.** Detection admits only active targets (`memory-repository.ts:105`, `vectors-repository.ts:62`, `entities-repository.ts:223`) and runs only for an active saved row.
- **They are a large share of the queue.** On a backup copy of a real installation, 28% of pending rows had a retired endpoint. Most were superseded (97% of the single-side cases). They inflated the operator's pending count for up to `JUDGMENT_ORPHAN_DEADLINE_MS`.

The deadline step still reaches these rows (`relations-repository.ts:242-265`), so the drain and the deadline step never conflict: whichever runs first orphans the row, and the other finds it no longer `pending`.

**Alternatives considered. All measured on the same backup copy; percentages are of the retired-endpoint pending rows.**

- **A. Close on retirement.** Orphan a memory's pending relations in the same transaction that supersedes or archives it. Not adopted now.
  - Retirement happens on at least six write paths: `topic_key` revision, judged `supersedes`, merge, the archive tool, decay, and the dashboard. Missing one would silently re-create the backlog.
  - A memory reactivated by an undo would also need its relations restored.
  - The sweep step covers every path in one place, with at most one day of delay. A remains a possible follow-up, and B stays as its safety net.
- **C. Carry the pair forward to the successor.** When closing (old, B), evaluate (successor, B) with the same pairwise predicate, and create a pending relation if it is admitted and the two are unrelated. Rejected.
  - Only 54% of the single-side retired rows had an active successor. For 46% of those, the successor was already related to the counterpart.
  - It would have created new pending rows for 16% of the retired rows.
  - The successor already ran its own save-time detection when it was saved. Carrying forward re-adds work to the queue the owner wants smaller.
- **D. Display only.** Count these rows apart in the dashboard and leave them to the deadline, with no writes. Rejected as unnecessary once the drain closes them. It changes what an operator sees, not what the table holds.

### D5 — Scope: the pair's own project, the pair's own rows

The selection applies `endpointsInScope(projectId)` (`relations-repository.ts:77-84`). Every evaluator read is keyed by the pair's two memory ids: status and lengths, title and content, embeddings and entity links. `createPending` already refuses a cross-scope pair (`packages/core/src/services/relations.ts:126`). Because D2 drops the rarity gate, no project-wide count is read at all.

### D6 — Orphan and journal in one transaction

A drain helper calls `RelationsService.orphan` and `recordOrphanPromote` (`packages/core/src/consolidation/operations.ts:75-98`) inside one `tx.transaction`, with ONE timestamp for `judged_at` and `applied_at`.

Today the two stamp separately. `orphan` takes `judged_at` from `RelationsService.now` (`relations.ts:305`), and `recordOrphanPromote` takes `applied_at` from `new Date()` (`operations.ts:86`). Both gain an optional timestamp parameter, and the helper takes the time once and passes it to both. Calls that omit it, like the deadline step's, keep today's behaviour. One timestamp is what makes the undo guard (D8) exact for the drain's own writes.

`markOrphanedPending` only updates a row whose status is `pending` (`relations-repository.ts:191`), and `orphan` throws when nothing was updated (`relations.ts:307-312`). A concurrent verdict therefore rolls the transaction back, and the row is skipped. The reasoning string names the drain, which keeps it distinct from the deadline's `unjudged after …ms deadline` (`runner.ts:133`).

Each pair commits in its own transaction, and no transaction spans several pairs, a run or the backlog. A failure then rolls back only the pair it hit, the drains already committed in that run stay journaled and undoable, and the run moves on. A test proves this by failing the third pair's write and asserting that the first two stay committed.

Alternatives considered:

- **One transaction per run.** Rejected: one failure would roll back every drain of the run.
- **One transaction for the backlog.** Rejected for the same reason, made worse by a backlog of any size.
- **Bounded groups of pairs.** Not adopted. It trades the per-pair rollback for a commit cost this design has not measured. If the task group 9 measurement shows per-pair commits dominate the run, a group can be proposed against that measurement.

Advisory, not in scope: the deadline step writes the same two rows without a transaction (`runner.ts:136-146`). A failure between the two writes would leave an orphaned row with no journal entry, which undo cannot reach.

### D7 — Bounds and a wrap-around cursor kept in the run summary

Batching is a requirement, not an optimisation. better-sqlite3 is synchronous, and the sweep runs inside a `setImmediate` callback on the server's single Node thread (`apps/web/src/lib/services.ts:118-125`). While a run lasts, no other request is served, so a 5 000-row backlog processed in one go would stall every MCP call, API call and dashboard page for its whole duration.

**Two bounds:**

- `DRAIN_ROW_CAP` limits the pairs one scope's drain step examines per run.
- `DRAIN_BUDGET_MS` limits the wall clock of ALL drain steps in one sweep call. A call is one session-start callback (two scopes) or one forced `runAll` (every project). The budget is shared across the call's scopes, so a call never blocks for N × budget.

The budget counts only time spent inside drain steps. Each step reads the clock when it begins, checks the call's spent time plus its own elapsed time between pairs, and adds its elapsed time to the call's total when it ends. Decay and deadline orphaning, in the first scope or any later one, therefore never spend it; the per-callback instrument reports them instead. The clock source is an injected seam for tests.

Each drain step examines at least one examinable pair even when the budget is spent. A slow host, or a scope late in a `runAll`, still progresses. The overrun per scope is that one pair, which D3's size bound caps, plus the step's fixed reads: the cursor, the reverted ids once per call, and the selection.

**Per-scope fixed cost.** The shipped measurement (`measurements/drain-cost-shipped.txt`) found the selection's indexed range pathological for a project with few pending rows of its own: the range walks every project's pending rows in `(status, created_at)` order and filters them by project, so for the empty default project, which every session start sweeps, it read all 30 017 pending rows of the 50 000-memory corpus (about 26 ms per selection). The selection therefore first probes through the project's own memories (`memory_scope_project_created_id_idx`, then `memory_relations_source_status_idx`). When the probe finds fewer rows than it asked for, it holds the project's whole range, which is sorted in memory and returned; otherwise the indexed range runs, and it then reads about `limit × all pending / probe rows` rows. The probe asks for at least 16 rows. A step that begins with the call's budget already spent asks for one row, because it will examine only one. What remains per scope after the budget is spent is small: in 50-project calls the drain step's p50 is 0.1 ms and its p95 0.6–1.1 ms. The budget's value leaves room for it.

Both values are named constants, never read from the environment. They are chosen from the task group 9 measurements against a budget of p95 ≤ 50 ms of drain time per sweep call at 50 000 memories. The approved mitigation, if the budget is missed, is a smaller cap.

**Chosen values: `DRAIN_ROW_CAP = 150` and `DRAIN_BUDGET_MS = 30`.** The cap is the prototype's: 200 pairs exceeded 50 ms in one step at 50 000 memories. The budget is the largest value whose emulated scan met p95 ≤ 50 ms of drain time per call both for a forced `runAll` over the six loaded projects and the default (p95 36–37 ms at 30, 42 ms at 35, 49 ms at 40) and for one over 50 projects, 43 of them empty (p95 39–48 ms at 30, 46–52 ms at 35). The shipped value is then confirmed with the plain clock at 1 000, 20 000 and 50 000 memories (`measurements/drain-cost-shipped.txt`).

**Expected drain time for 589 rows:** `ceil(589 / 150) = 4` runs when the budget does not cut runs short. In the worst case, one pair per run, it is 589 runs. On the session-start cadence a run is one day per scope, and each dashboard "run now" adds a run. The measured pairs per call state where an installation sits between the two.

**Cursor.** The step selects examinable rows in `(created_at, judgment_id)` order after a composite cursor. An examinable row is pending, has both endpoints in the project whatever their lifecycle, and is not excluded by a reverted drain op. `judgment_id` is a ULID minted in `createPending` (`relations.ts:131`) and carries a unique index (`packages/db/src/schema/memory-relations.ts`, `judgmentIdUnique`), so it breaks `created_at` ties deterministically.

The order rides the existing `memory_relations_status_created_idx` `(status, created_at)` as a range and sorts only ties. Plain `judgment_id` order sorted every pending row of the scope before the first pair: 13–18 ms warm and about 170 ms cold at a 5 000-row backlog and 50 000 memories, against 0.35–4.8 ms for the composite order (`measurements/README.md`, validation 8). The prototype ran both orders over 40 wrapping cursor steps and every batch size: identical batches and identical drained sets. Under a shared budget, the `judgment_id` order could not hold it, because every scope paid its sort before its guaranteed pair.

The cursor (the last examined row's `created_at` and `judgment_id`) and the run's counts go into ONE nested `drain` object of the summary JSON that `finishRun` already writes (`runner.ts:120`, `packages/db/src/repositories/consolidation-repository.ts:24-30`). Each run reads the latest finished run of its scope. When the selection runs out of rows after the cursor, it continues from the lowest key up to the cursor, inclusive, within the same run while the cap allows, so a run never examines a row twice and the next run resumes after the last row examined.

The summary is the right home for the cursor:

- it is per scope and per run, and it is already written at the end of every run;
- nesting keeps every published reader unchanged (D9);
- a lost or corrupt cursor restarts from the lowest id, which costs extra work but never causes a wrong drain.

**Undo is final, for the drain.** A row is excluded when a reverted `orphan_promote` op carries its judgment id as `created_id` (`operations.ts:93`). The created ids of every reverted `orphan_promote` op are read once per sweep call, and the selection excludes them inside its own SQL. Excluding after selecting would let excluded rows fill the row cap: a batch made only of undone rows would examine nothing while the cursor advanced.

`consolidation_ops` has no index on `created_id`; its only index is on `run_id` (`packages/db/src/schema/consolidation.ts:53`). So the read scans the journal. It runs once per sweep call, not once per scope, so a forced `runAll` over N projects pays one scan, not N. It runs inside the first drain step, after the budget clock has started, so its cost spends the drain's own budget instead of adding to it. Its cost at 1 000, 10 000 and 100 000 ops is part of the task group 9 measurement, and an index is out of scope because it would be a migration.

The finality binds the drain only. The deadline step's selection does not read the journal (`relations-repository.ts:242-265`), so an undone row that later crosses the deadline is orphaned by the deadline step, as before this change.

Alternatives considered:

- **Oldest-N selection with no cursor.** Rejected: kept head rows starve the rest.
- **A new table or column.** Rejected: forbidden by this change's constraints.
- **Marking examined rows.** Rejected: it would mutate pending rows outside the journal.
- **A one-off pass with a horizon.** Rejected: the owner wants a permanent step that follows the current rules.

### D8 — Undo restores a drained row, and must not overwrite a later verdict

Verified: the `orphan_promote` undo branch (`operations.ts:160-180`) calls `resetToPending` (`:179`). That sets `status = 'pending'` and clears `relation`, `reason`, `confidence`, `judged_at`, `marked_by_kind` and `marked_by_actor` (`relations-repository.ts:143-157`), which are exactly the fields `orphan` sets (`relations.ts:301-306`, `relations-repository.ts:190`). The existing test `orphan-promotion.test.ts:90-114` asserts that a deadline-orphaned row returns to `pending`.

Gap: `memory.compare` judges an existing row for the same pair in place, whatever its status (`relations.ts:247-262`, `requirePending: false`). `compare` cannot record `not_conflict`: its input type excludes it (`relations.ts:45`), the tool's enum omits it (`packages/mcp/src/relations-tools.ts:55-66`), and the published contract says so (`openspec/specs/mcp-api/spec.md:1062`). The real hazard is `supersedes`. `compare` supersedes the target and adds it to the source's `replaces`, and today's undo of the orphaning op would reactivate the target, remove it from `replaces` and reset the verdict to `pending` (`operations.ts:163-177`, `:179`). An operator's undo of a drain would silently revert an agent's later supersede.

Needed: reset and reverse only when `rel.judged_at` is non-null and `rel.judged_at <= op.applied_at`. Otherwise, leave the relation untouched, report it (judgment id, status, relation) in a new `UndoResult` field, and still mark the op reverted. That is the partial-undo policy the topic-slot guard already follows.

A null `judged_at` cannot be proven to be the op's own write. If the relation is already `pending`, there is nothing to restore. Either way the relation is left untouched and reported.

The guard applies to every `orphan_promote` op, historical ones included, and the MODIFIED journaled requirement now says so instead of promising those ops unchanged undo semantics. Any undo whose relation has not been written since the op behaves exactly as before. The existing LLM-era fixture writes equal timestamps (`operations.test.ts:298-344`), so it keeps passing.

Alternative: guard on `status = 'orphaned'`. Rejected, because historical promote ops legitimately leave `judged` rows.

### D9 — Visibility without a new surface

The summary keeps its top-level `archives` and `orphaned` numbers unchanged, and adds ONE nested object: `drain: { cursor, examined, drainedRules, drainedRetired, keptAdmitted, keptUnknown }`. The nesting is what keeps published outputs stable.

- **`memory.doctor`:** `parseRunSummary` copies only top-level finite numbers and a `kind` string (`packages/core/src/doctor.ts:14-31`). It skips an object value, so `lastRunOps` (`openspec/specs/mcp-api/spec.md:696`) keeps exactly `archives` and `orphaned`. A test pins this.
- **Dashboard:** the run-detail formatter type-checks only `archives` and `orphaned` (`apps/web/src/app/dashboard/consolidation/[id]/page.tsx:99-116`). It is extended to append "· N drained", where N is `drainedRules + drainedRetired`. The published dashboard requirement pins the summary shape `{"archives":N,"orphaned":M}` (`openspec/specs/dashboard/spec.md:165`, `:180`), so it gets a MODIFIED delta. That delta also covers the partial-undo message.
- **Persistence:** the persistence requirement still describes `orphan_promote` as LLM promotion verdicts (`openspec/specs/persistence/spec.md:220-225`), so it gets a MODIFIED delta. No schema changes.

Ops already list with their reasoning and an undo control (`apps/web/src/app/dashboard/consolidation/page.tsx:405-450`). The rules drain, the retired-endpoint drain and the deadline step each have their own reasoning prefix.

Alternative: flat top-level counters. Rejected. `parseRunSummary` would pass every new number into `memory.doctor`'s published `lastRunOps`, which is an MCP output change for an operator-only signal.

No dashboard preview is added. The owner's pre-upgrade check is the read-only dry-run script (task group 10), which calls the drain's selection and `evaluatePair` over every examinable pair without writing.

### D10 — No model inference, enforced by construction

The drain reads only vectors already stored in `memory_vec`, through the public point read `pairCosineDistance` (D1). That read applies the same `vec_distance_cosine` that `knnCandidates` uses (`vectors-repository.ts:79`). It never loads or calls the model, and never embeds a missing vector. A missing vector is an `unknown` verdict (D3).

That includes the window after a model-identity reset. When the embedder loads, `resetVectorModelOnLoad` (`apps/web/src/lib/services.ts:79`, `:159-179`) calls `ensureVectorModel`, which deletes every stored vector if the model identity changed (`packages/core/src/embeddings/state.ts:64-88`). Until the embedding worker re-embeds them, every pair is kept.

**Stale vectors.** A missing vector is not the only hazard. The identity reset runs only when the embedder lazily loads (`services.ts:77-80`), and it can be deferred: its failure is caught and retried on the next load (`services.ts:171-177`). The doctor reports that state as "vector index owes a reset" (`state.ts:57-62`). Until then, a sweep could score vectors written under an older recipe as if they were current.

The runner therefore receives an injected `vectorIndexCurrent: () => boolean`. The server wires it to `() => vectorIdentityMatches(dataDir)` (`state.ts:52-55`), which is false whenever the marker names another model or input version, and also while a reset is pending, because `readMarker` returns `null` for a pending marker (`state.ts:20-35`). The drain calls it once at the start of each drain step. When it returns false, every pair's vector verdict in that step is `unknown`, so no pair is drained by the rules; retired-endpoint drains need no vector. A runner built without the option treats the index as not current, so a caller that forgets to wire it never drains by the rules. The predicate is injected because the import pin below forbids the drain from importing `embeddings/state.ts`.

The guarantee is structural, not a convention:

- `ConsolidationRunnerOptions` holds no embedder (`runner.ts:12-24`), and the server builds the runner without one (`services.ts:107-117`). The embedder reaches only `MemoryService` and `EmbeddingWorker`, through `getEmbedder` (`services.ts:75-91`). The drain's new dependencies are repositories, which are SQL only, plus two injected functions. One is the boolean `vectorIndexCurrent`. The other is the clock seam `drainClock?: () => number` (D7).
- The drain's import graph reaches no embedding module. `save-time-candidates.ts` imports `@rembric/db`, `./entities.js` and `./hybrid-search.js` (`:1-4`). `hybrid-search.ts` imports only `@rembric/db` (`:1-9`). `entities.ts` imports `@rembric/db` and `./extractor-rules.js`. `runner.ts` imports none (`:1-10`).

Two tests pin it:

- a type test fixes the exact key set of `ConsolidationRunnerOptions`, which is today's eight keys plus `vectorIndexCurrent` and `drainClock`, so adding an embedder fails the build;
- a scan of the drain's transitive relative imports asserts that none reaches `embeddings/`, with a control proving the scan detects the import in `packages/core/src/services/embedding-worker.ts`.

Alternative: embed a missing vector on the fly so the pair can be decided. Rejected for three reasons:

- loading the model blocks the event loop on its own (`services.ts:93-95`);
- it would make a cleanup step depend on inference, which can fail;
- a pair that cannot be decided is exactly the case the fail-safe exists for.

### D11 — Evidence before implementation

Before any code is written, two checks run (task group 1):

- **A false-drain measurement on the labelled save-time fixture, with the real model.** Pendings are created at `lexicalFloor: 0`, the old rank-only rule, and then drained by a prototype of the rule. It reports drained counts per class. Every genuine class (near-duplicate, expanded rewrite, contradiction) must drain 0. Any other result stops the change with a decision for the owner.
- **The decidable share on a production backup copy.** It reports the share of pending pairs whose endpoints both have stored vectors and entity-scan records.

The fixture measurement already exists as a prototype (`measurements/fixture-drain.mts` → `fixture-drain.txt`). Its README reports 0 false drains in the production arm, with all 17 labelled pairs kept. Task 1.1 re-runs it on the final rule.

The parent has already run a prototype of this rule on a backup copy of a real installation's database. Only aggregate figures are recorded here, never content, titles, project names or identifiers:

- 20% of pending rows were drained by the rules, and 28% had a retired endpoint;
- 0 of the drained pairs shared an entity when re-extracted independently;
- an independent re-verification of the verdicts found 0 mismatches;
- undoing the drain restored the relations table byte for byte;
- a second pass drained 0;
- the cost was about 0.13 ms per pair, and a 400-pair run took about 49 ms on that host.

These are prototype figures. The committed measurements of task groups 1 and 9 replace them as the evidence for the constants.

## Risks / Trade-offs

- **[Risk] A genuine pair is drained** because it misses both thresholds and shares no entity the extractor recognises, for example a paraphrased contradiction whose embeddings disagree. → Today's save would not create that pair either. The false-drain gate on the labelled fixture must show 0 per genuine class before implementation (D11). Every drain is undoable and undo is final for the drain. The dry-run count shows the volume before the owner upgrades.
- **[Risk] A sweep call blocks the event loop.** → `DRAIN_BUDGET_MS` is shared across the scopes of one call and counts only time inside drain steps. The overrun is one pair plus the step's fixed reads per scope, each pair size-bounded, and the cap is pre-approved to shrink. Decay and deadline time is outside the drain's budget, so the per-callback instrument reports the whole call separately.
- **[Risk] Vectors written under an older recipe are scored as current.** → The `vectorIndexCurrent` predicate makes the vector verdict `unknown` until the identity reset has completed (D10).
- **[Trade-off] Oversized pairs are never drained by the rules.** → Accepted: their cost is unbounded, and the deadline step still closes them.
- **[Trade-off] The reverted-op lookup scans `consolidation_ops` once per run**, because `created_id` has no index. → Accepted and measured. Adding an index would be a migration.
- **[Risk] An agent holding a drained judgment id gets `conflict` from `memory.judge`** (`relations.ts:183-188`). → This is the same outcome a deadline-orphaned row already produces, and `memory.compare` still records a verdict.
- **[Risk] On an install whose embeddings never materialise, nothing ever drains, and each run spends its cap re-examining.** → Safe by construction. See Open Question 1.
- **[Risk] A summary write fails and the cursor is lost.** → The next run restarts from the lowest id, which costs extra work but never causes a wrong drain.
- **[Trade-off] Kept pairs are re-examined every cycle.** → Accepted. The cost is bounded by the cap, and it is what lets the step follow whatever rules are current.
- **[Trade-off] Undo semantics change for every `orphan_promote` op, historical ones included.** → A later verdict is preserved instead of being reset, which closes a hole the deadline step shares today. A historical op whose relation has a null or later `judged_at` is now reported instead of reset.
- **[Advisory]** The deadline step's orphan and journal writes are not atomic (`runner.ts:136-146`), and neither step journals a `failed` op as "Consolidation operations MUST be atomic per operation" describes. Both are out of scope here.

## Migration Plan

- No schema change and no migration. The step starts on the first sweep after the upgrade.
- Rollback: revert the commit, or set `DRAIN_ROW_CAP = 0`, which makes the step examine nothing. Drains already applied are undone per op or per run from the dashboard.

## Open Questions

1. **Installs without embeddings.** Should an install whose vectors never exist keep draining nothing, which is the current fail-safe, or should a lexical-only mode treat the vector channel as "not admitted"?
2. **"QUEUED WORK" label.** Draining raises the orphaned count that the maintenance card labels "QUEUED WORK", in amber (`apps/web/src/app/dashboard/maintenance/page.tsx:111`, `:161-166`). Should that label or its tone change? This is not in scope.
3. **Budget value.** Is p95 ≤ 50 ms of drain time per sweep call, at 50 000 memories, the right budget?
4. **Undo guard scope.** The guard in D8 also changes undo for deadline-orphaned rows. Confirm that this is wanted rather than limited to drain ops.
