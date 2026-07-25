## Why

A multi-agent audit of the repo surfaced ten defects that are verified against code and, for the four most consequential, reproduced empirically. They are not stylistic — one freezes the whole server for ~57s on an hourly trigger, one makes a single `memory.get` consume 17k+ tokens of the caller's context, one silently reports a successful undo while the rows stay deleted, and one makes the `topic_key` convergence invariant structurally unachievable. All ten are safe to land without a retrieval-eval harness: none of them changes ranking behavior.

Three further verified defects are **deliberately excluded** from this change and recorded in Deferred below, so the deferral is a decision rather than an omission.

## What Changes

- **Delete the pairwise similarity telemetry.** `VectorsRepository.similaritySample` is an O(sample × N) self-join over `memory_vec` with `vec_distance_cosine` per pair. Measured 56,851 ms at 10k vectors (reproduced independently twice); the 50ms heartbeat probe showed a 26,287 ms gap during a 26,236 ms query, i.e. the event loop is fully blocked because `better-sqlite3` is synchronous on the only thread. It is wired as `onDrained` and fires roughly once per hour in which any `memory.capture_passive` ran. At ~30k vectors the freeze exceeds the compose healthcheck budget (3 × 30s) and the orchestrator restarts the container mid-freeze. This is developer calibration telemetry for an already-shipped constant; it is removed, not optimized.
- **Bound the `memory.get` predecessor projection.** `collectPredecessors` is an unbounded BFS over `replaces[]`, and every element is returned with full `content`. It traverses a DAG, not a chain, because `applySupersedesSideEffect` appends to `replaces[]`. Measured: 52 `topic_key` saves → 51 predecessors → 68,627 bytes ≈ 17.2k tokens; depth 5,000 → ≈910k tokens. Amplified by `ok()`, which pretty-prints with 2-space indent **and** duplicates the payload into `structuredContent`. Round trips are not the problem (5,000 in 179 ms). Predecessors become a `{id, title, status, createdAt}` projection with a depth cap, `predecessorCount`, and `truncated`. `findHead` gains an explicit signal when it exceeds its existing 64-hop cap instead of silently returning a non-active row.
- **Make `prompt_purge` terminal for undo.** Only `session_purge` and `archived_memory_purge` are checked, so a `prompt_purge` undo falls through to `markReverted` and returns success while the rows remain deleted — the audit journal actively lies. The dashboard guard has the same omission and renders a live Undo button. Both derive from one exported `TERMINAL_OP_TYPES`, with an invariant test asserting every `CONSOLIDATION_OP_TYPES` member falls in exactly one category.
- **Make decay undo durable.** `reactivate` only sets `status='active'` and leaves `last_seen_at` untouched, so all three `findDecayCandidateIds` predicates still hold and the next sweep re-archives the same rows. An operator restores 40 memories and loses them again within 24h. Reactivation stamps `last_seen_at` (an operator reviving a memory _is_ an access event) and deliberately does **not** touch the review baseline, keeping the two axes orthogonal.
- **Make `topic_key` readable.** The key is accepted on write but absent from every read projection and from the search filters, and `memory.suggest_topic_key` never touches the DB. The agent is required to reproduce a byte-identical key across sessions while being unable to observe the existing one. `topicKey` is returned on the read projections, a `topic_key` search filter is added, and `suggest_topic_key` becomes scope-aware (`occupied`, `occupantId`, `occupantTitle`, `nearby`).
- **Route `memory.capture_passive` through the curation path.** It calls `MemoryService.save` in a loop: no `saveWithTopicKey`, no candidate detection, and no `embedNow` — so its rows carry no vector until the hourly force tick and are invisible to the dense search branch until then (this is also the trigger for the telemetry freeze above). A header mismatch returns `{saved: 0}` as a _success_, so the model reports learnings persisted when nothing was. It shares the save-time helper, the header regex accepts case-insensitive H2/H3 with an optional colon, and a zero-match parse becomes an explicit signal.
- **Stop zombie sessions from disabling session auto-attach.** `findActiveForTransport` returns `undefined` on ≥2 active rows for a `(token_id, project_id)` — correct refusal, but nothing makes the ambiguity transient: `abandonStale` runs at boot only and no heartbeat column exists. A single `SIGKILL`ed client leaves an active row for the whole process lifetime, after which every write without an explicit `sessionId` persists with `session_id = NULL`. Worst consequence: such a session has no attached content, so `sessionHasContentSql` classifies it as _empty_ and it becomes eligible for physical deletion. A `last_activity_at` column plus an interval reaper makes the zombie invisible to the resolver **without** relaxing the deliberate no-recency-tiebreak rule.
- **Populate `confirmations.session_id`.** The column exists _with an index_ and no MCP path ever writes it. (`memory.confirm` is correctly **not** affected by the auto-attach defect — it never calls `resolveActiveSessionId` — which is precisely why the column is permanently NULL.)
- **Rewrite the post-compaction protocol block in English.** `post-compact.sh` emits its instructions in Rioplatense Spanish — the only non-English agent-facing text in the product — on both Claude Code and Codex, at the highest-stakes moment in the session (the model has just lost its context and this text is the only thing telling it what to persist). It reliably causes the model to continue answering an English-speaking user in Spanish. It is absent from `nudge-fixtures.json`, so unlike every other nudge it has no lock-step test against opencode's English equivalent.
- **Scope `memory.stats.sessionsByStatus`.** `countByStatus()` takes no scope and aggregates every non-soft-deleted session row across all projects. Marginal disclosure is genuinely small (two integers — `memory.doctor` already exposes global `sessions.active` by deliberate spec), but `mcp-api` states these counts are "scoped to the request context", so this is a spec-vs-impl divergence. Enforcement is the **required `Scope` parameter**, not a naming convention: the unscoped method is renamed `adminCountByStatus` so the existing confinement grep gate covers it. The same spec text is stale in a second way — it demands `memoriesByScope`, `totalProjects` and `totalTokens`, none of which the handler returns; that text is corrected to match reality.
- **Fix backup documentation that cannot be executed.** `README.md` and `docs/docker.md` instruct `docker compose exec rembric sqlite3 …`, but the runtime stage is distroless — no shell, no `sqlite3`. `docs/backup.md` documents the bare-metal `~/.rembric` path while the canonical deployment uses `/data`, and never mentions the dashboard `VACUUM INTO` + download flow that actually works. Restoring an older snapshot trips the data-loss guard, whose bypass `REMBRIC_ALLOW_DATA_SHRINKAGE` appears in **zero** documents. The snapshot download handler also only ever serves the latest `on-demand-` file, so `pre-update-` snapshots are undownloadable.

### Deferred (verified defects deliberately NOT in this change)

- **The inverted FTS save-time threshold.** `sim = 1 / (1 + Math.abs(rank))` is monotonically _decreasing_ in match quality, because FTS5 bm25 is negative and better matches are more negative. Reproduced: a byte-identical duplicate in a 300-row corpus scores `sim = 0.067` and **0 of 20** pool rows clear the 0.4 gate. The existing test passes only because its 2-row corpus drives IDF to ~1e-6, so the "true match" clears the gate _by scoring as noise_.
- **`RANK_CONSTANT = 60` against a 38-row rank window.** The pathology holds iff the window is below 62, so it bites the default path: any row present in both branches' windows outscores an exact identifier match found by the lexical branch alone.
- **The `last_seen_at` self-reinforcement loop.** `memory.search` touches every returned row, which grants decay immunity, a recency boost, and `memory.context` ordering — with no distinction between _returned_ and _used_.

The first two change ranking behavior, and there is currently no retrieval-eval harness, so an improvement cannot be demonstrated over a regression — and the existing suite provably does not protect this area. The third is a product decision about what "access" means. All three follow in separate changes that build the measurement first.

## Capabilities

### New Capabilities

(none — this change repairs existing behavior)

### Modified Capabilities

- `memory`: supersedes-chain read semantics gain a bound; reactivation stamps `last_seen_at`.
- `mcp-api`: `memory.get` predecessor shape, `memory.search`/`memory.get`/`memory.context` expose `topicKey`, `memory.search` gains a `topic_key` filter, `memory.suggest_topic_key` becomes scope-aware, `memory.capture_passive` response gains candidates and an explicit no-match signal, `memory.stats` counts become genuinely scoped and the stale output contract is corrected.
- `sessions`: session rows gain `last_activity_at`; stale-active retirement becomes periodic rather than boot-only; `findActiveForTransport` excludes stale rows while preserving the no-recency-tiebreak requirement.
- `consolidation`: the not-undoable op set includes `prompt_purge`; undo of a decay op is required to be durable against a subsequent sweep.
- `data-access`: the unscoped session count is admin-prefixed so the confinement gate covers it.
- `persistence`: backup/restore requirements reflect the distroless runtime and document the data-loss-guard bypass.
- `claude-code-plugin`: post-compaction protocol text is English and lock-step tested.
- `codex-distribution`: same post-compaction text (shared script).
- `open-source-distribution`: the "README MUST accurately describe the current distribution model" requirement is currently violated by a documented command that cannot run on the distributed artifact.

## Impact

Server:

- `apps/server/src/db/repositories/vectors-repository.ts` (remove `similaritySample`)
- `apps/server/src/embeddings/state.ts` (remove `logSimilarityDistribution`)
- `apps/server/src/server/bootstrap.ts` (`onDrained` wiring; interval reaper; `adminCountByStatus` call sites)
- `apps/server/src/services/memory.ts` (`collectPredecessors` cap, `findHead` signal)
- `apps/server/src/consolidation/operations.ts` (`TERMINAL_OP_TYPES`, reactivate touch)
- `apps/server/src/db/repositories/memory-repository.ts` (`topic_key` projection + filter)
- `apps/server/src/db/repositories/agent-sessions-repository.ts` (`last_activity_at`, staleness predicate, `adminCountByStatus`)
- `apps/server/src/db/schema/agent-sessions.ts` (new column)
- `apps/server/src/services/agent-sessions.ts` (scoped count, activity touch)
- `apps/server/src/mcp/memory-tools.ts` (predecessor projection, `topicKey` output, `topic_key` filter, docstring fix)
- `apps/server/src/mcp/observability-tools.ts` (`capture_passive` routing, scoped stats)
- `apps/server/src/mcp/relations-tools.ts` + `topic-key.ts` (scope-aware suggestion)
- `apps/server/src/mcp/_shared.ts` (docstring fix)
- `apps/server/src/dashboard/consolidation.ts` (terminal-op guard)
- `apps/server/src/dashboard/maintenance.ts` (snapshot download picker)
- `apps/server/src/services/embedding-worker.ts` (false comment)
- new migration under `apps/server/src/db/migrations/` (`last_activity_at`; additive `ALTER TABLE ADD COLUMN`, no table rebuild)

Plugin:

- `apps/plugin/scripts/post-compact.sh`, `apps/plugin/test/nudge-fixtures.json`, `apps/plugin/test/nudge-fixtures.test.ts`

Docs:

- `README.md`, `docs/docker.md`, `docs/backup.md`, `.env.example`

Invariants touched: append-only is **not** relaxed (`last_activity_at` is a new mutable session column in the same class as `summary`; predecessors are a presentation projection). Scope-at-service-layer is _strengthened_ by making the session count require a `Scope`. The no-recency-tiebreak session rule is preserved.
