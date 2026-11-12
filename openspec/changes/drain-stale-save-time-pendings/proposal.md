## Why

The change `add-save-time-lexical-floor` stops new saves from creating noise pending judgments, but it leaves the pending rows that already exist alone (its design decision D8), and those rows were created under the rank-only lexical rule. The owner reports one production instance holding 589 pending, 15 491 judged and 719 orphaned judgments for about 3 400 memories, and the visible pending pairs are unrelated memories that share common words. Waiting for the deadline is not enough. The deadline step orphans at most `ORPHAN_BATCH = 50` rows per scope per run (`packages/core/src/consolidation/runner.ts:44`), and a scope runs at most once per 24 hours (`runner.ts:43`). Every upgraded instance therefore needs an automatic, permanent way to drain pairs that the current detection would never create, with no operator step.

## What Changes

- The deterministic consolidation sweep gains a permanent third step, the **stale save-time pending drain**. It runs after decay and deadline orphaning, in the same throttled per-scope run, with no LLM, no cron and no new trigger. On every run it evaluates pending pairs against whatever save-time detection rules are current.
- **The rule.** Each pending pair (source, target) whose endpoints are both active is evaluated directly, oriented as at save time. It is orphaned ONLY when all three of these hold:
  - its lexical overlap is below `LEXICAL_CANDIDATE_FLOOR`;
  - the cosine similarity of its stored embeddings is below `VEC_THRESHOLD`;
  - its two memories share no entity, by their stored links or by a fresh extraction of each.

  The entity check deliberately ignores the rarity gate. A pair sharing an identifier that the extractor recognises is never drained by the rules, as long as the identifier is one of the extractor's kinds and falls within its per-memory budget. The step never drains by age. Age-based orphaning stays the deadline step's job.

- **One per-pair predicate.** The lexical measure, the vector distance-to-similarity mapping and the two threshold comparisons are extracted from `findSaveTimeCandidates` into one core implementation. Detection and the drain both call it. The re-check never depends on today's per-channel pool or on the per-save cap, and the shipped save path keeps identical behaviour.
- **Fail-safe.** When any channel cannot be evaluated for a pair, the pair stays pending. "Unknown" never counts as "not admitted". This covers:
  - a missing embedding;
  - a vector index that does not match the current embedding recipe;
  - an extraction that throws;
  - a pair longer than `DRAIN_MAX_PAIR_CHARS`;
  - a row that cannot be read;
  - a re-check that throws.
- **No model inference, ever.** The drain reads only the vectors already stored, the way save-time detection's dense channel does. It never loads or calls the embedding model, and never embeds a missing vector. The consolidation runner receives no embedder, only an injected `vectorIndexCurrent` predicate, and the drain imports no embedding module. Tests pin both.
- **Endpoint state.** A pair whose source or target was superseded or archived is drained with its own reasoning prefix. The agent queue already withholds it, so no agent could ever judge it, and the current rules would never create it. On a backup copy of a real installation, these were 28% of the pending queue.
- **Scope.** A pair is re-evaluated only against its own two memories, inside its own project.
- **Journal.** Each drain is one `pending` → `orphaned` flip, journaled in the SAME transaction as an `orphan_promote` op through the existing `recordOrphanPromote`, with one timestamp shared by both writes and a reasoning prefix distinct from the deadline's. Each pair commits on its own. No transaction spans several pairs, a run or the backlog. No schema change, no migration, no new table and no new op type.
- **Batched, with no starvation.** Batching is a requirement. The sweep runs synchronously on the server's single Node thread, so a long run blocks every other request.
  - Each scope's drain step stops at a row cap, and all drain steps of one sweep call share one wall-clock budget, which starts at the first drain step.
  - Every drain step examines at least one pair, so a slow host or a late scope still progresses.
  - A wrap-around cursor (the last examined row's `created_at` and `judgment_id`) is kept in a nested object of the run's existing `summary` JSON, so kept pairs do not block the rest.
  - A pair the operator restored by undo is never drained again by the drain. The deadline step can still close it later.
- **Undo.** Undoing an `orphan_promote` op no longer overwrites a verdict written after the orphaning. `memory.compare` can judge an orphaned row `supersedes` in place, and today's undo would revert that supersede.
- **Operator visibility.** The run summary records the drain's counts in its nested object, including a retired-endpoint counter, and the run-detail page shows the drained count. Each drain op is listed and undoable like any other op.
- **Evidence before code.** Two checks run before implementation: a false-drain measurement on the labelled fixture with the real model, where every genuine class must drain 0, and a check of the decidable share on a production backup copy.
- **Dry-run count.** A script reports how many pending pairs would be drained and how many kept. The owner runs it against a backup copy of the production database, never against the live file.

Behaviour change, not marked **BREAKING**: upgraded instances lose pending judgments that no current channel would create, and those with a retired endpoint.

No MCP field, input or schema changes. `memory.doctor`'s `lastRunOps` keeps exactly `archives` and `orphaned`, because the drain's counters sit in a nested object that `parseRunSummary` skips (`packages/core/src/doctor.ts:14-31`). The stored run summary gains that nested object, and the dashboard's run detail shows the drained count, under a `dashboard` delta.

Supersedes design decision D8 of `add-save-time-lexical-floor` ("leave existing pending rows alone"). That change must land first, because this one reads `LEXICAL_CANDIDATE_FLOOR`.

Invariants touched:

- **Append-only memory:** intact. No memory row is written. Only `memory_relations.status` flips from `pending` to `orphaned`, journaled and reversible.
- **Journaled, reversible consolidation:** every drain is journaled atomically and undoable through the existing undo path, which gains a guard.
- **Scope at the service layer:** the step selects and re-evaluates within the pair's own project.
- **Fresh-context judgment:** the queue loses only pairs that no current channel surfaces and that share no entity, and pairs no agent can judge because an endpoint is retired. Every other pair stays pending.
- **`topic_key` convergence:** untouched.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `consolidation`: adds the drain step: its rule, fail-safe, no-inference guarantee, retired-endpoint drain, scope, bounds and cursor, and visibility. Also adds a guard so an orphaning undo does not overwrite a later verdict. It corrects two published requirements:
  - "Every consolidation decision MUST be journaled" says the sweep produces no new `orphan_promote` rows, which the deadline step already contradicts (`runner.ts:138`).
  - "The consolidation MUST be idempotent on stable input" gains the drain step.
- `dashboard`: "Consolidation runs MUST be inspectable and reversible from the dashboard" pins the summary shape `{"archives":N,"orphaned":M}`. It now accepts the nested `drain` object, shows the drained count and explains a partial undo.
- `persistence`: "The schema MUST track consolidation operations" still describes `orphan_promote` as LLM promotion verdicts. It now records sweep orphanings, with no schema change.

## Impact

- **Code:**
  - `packages/core/src/services/save-time-candidates.ts`: the per-pair predicate is extracted, and a pair evaluator with three-valued verdicts, the size bound and fresh extraction of both endpoints is added. `findSaveTimeCandidates` calls the predicate.
  - `packages/core/src/consolidation/runner.ts`: the drain step, a transactional orphan-and-journal helper, the per-scope cap, the per-call budget and its clock seam, the cursor, the nested `drain` summary object, and the `vectorIndexCurrent` and `drainClock` options.
  - `packages/core/src/consolidation/operations.ts`: an optional `appliedAt` for `recordOrphanPromote`, the undo guard in the `orphan_promote` branch, and the kept-verdict report in `UndoResult`.
  - `packages/core/src/services/relations.ts`: an optional timestamp for `orphan`, so one timestamp reaches both writes.
  - `packages/db/src/repositories/relations-repository.ts`: a scoped selection of examinable pending rows after a `(created_at, judgment_id)` cursor, with undone rows excluded inside the query.
  - `packages/db/src/repositories/memory-repository.ts`: a scoped point read of a pair's two rows returning status and `length(title) + length(content)`, with the text only within the size bound.
  - `packages/db/src/repositories/vectors-repository.ts`: the public point read `pairCosineDistance`.
  - `packages/db/src/repositories/consolidation-repository.ts`: reads for the latest finished run summary of a scope, and for the created ids of every reverted `orphan_promote` op, read once per sweep call.
  - `apps/web/src/lib/services.ts`: wires `vectorIndexCurrent` to `vectorIdentityMatches(dataDir)`.
  - `apps/web/src/app/dashboard/consolidation/[id]/page.tsx` and `page.tsx`: the drained count in the run summary, and the kept-verdict message on a partial undo.
- **Tests:** co-located beside each unit above.
- **Measurements:** `openspec/changes/drain-stale-save-time-pendings/measurements/`, holding:
  - the false-drain measurement and the decidable share;
  - the worst-case content-size cost;
  - the per-drain-step and per-callback cost at 1 000, 20 000 and 50 000 memories, with backlogs of about 600 and 5 000 pending;
  - the mutation log;
  - the dry-run script;
  - the smoke record.
- **Specs:** `openspec/specs/consolidation/spec.md`, `openspec/specs/dashboard/spec.md` and `openspec/specs/persistence/spec.md`.
- **No change to:** the database schema, migrations, MCP tools, input schemas or outputs, plugins, the installer or dependencies. The deadline step's non-atomic orphan-then-journal pair is recorded as an advisory and is not changed here.
