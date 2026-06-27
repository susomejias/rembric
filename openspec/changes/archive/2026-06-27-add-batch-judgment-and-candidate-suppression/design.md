# Design — add-batch-judgment-and-candidate-suppression

## Context

`memory.save` surfaces candidates in bulk; the loop that closes them is
one-at-a-time. Grounding in this worktree:

- `findSaveTimeCandidates` (`apps/server/src/services/save-time-candidates.ts:51-115`)
  runs a vec kNN pass and an FTS5 BM25 pass, each filtered to the just-saved
  row's `(scope, project_id)` and each excluding `saved.replaces` via an
  `excludeIds` param the repositories already accept
  (`searchBm25Candidates` — `apps/server/src/db/repositories/memory-repository.ts:132-149`;
  `knnByCosine` — `apps/server/src/db/repositories/vectors-repository.ts:14-65`).
  It NEVER consults `memory_relations`, so a previously dismissed pair returns
  on every re-save.
- The save handler inserts one pending `memory_relations` row per surfaced
  candidate (`apps/server/src/mcp/memory-tools.ts:507-537`) and returns
  `candidates[]` + `judgmentRequired`.
- `RelationsService.judge` (`apps/server/src/services/relations.ts:106-151`)
  opens its OWN `this.tx.transaction` per call and, for `relation='supersedes'`,
  mutates the target (`status='superseded'`) and the source's `replaces[]`. It
  throws `DomainError('memory_not_found', …)` for an unknown `judgmentId` and
  `DomainError('conflict', …)` for an already-closed row. The MCP boundary
  (`apps/server/src/mcp/relations-tools.ts:104-135`) passes these codes through
  verbatim via `mcpError(err.code, …)`.
- `MemoryService.confirm` (`apps/server/src/services/memory.ts:343-357`) is a
  pure append: it inserts a `confirmations` row for the head of the supersedes
  chain and touches `last_seen_at`. It does NOT open a transaction itself; the
  service owns `this.tx` (used at `:160` and `:395`).
- `memory_relations` has only `source_id` / `target_id` columns — no topic or
  content key (`apps/server/src/db/schema/memory-relations.ts:59-86`). A pair
  can only be re-identified across re-saves by walking the `replaces` ancestry,
  because each re-save mints a fresh `source_id`.

## Goals / Non-Goals

Goals:

- Let an agent close every candidate from one save in a single `memory.judge`
  call, with per-item success/failure (one bad id must not abort the rest).
- Let an agent re-affirm all `needsReview` ids from one `memory.context` in a
  single `memory.confirm` call.
- Stop re-surfacing pairs the agent already dismissed as `not_conflict` for an
  evolving topic.
- Preserve full backward compatibility: every existing single-argument call and
  its response shape keeps working unchanged.

Non-Goals:

- No change to the judgment FSM, the supersedes side effect, the candidate
  thresholds, or the consolidation orphan sweep.
- No DB migration, no new column, no new index on `memory_relations`.
- No new MCP tool name and no plugin-manifest churn.
- Not reconciling the pre-existing `memory.judge` error-code drift (spec says
  `judgment_not_found` / `judgment_already_closed`; code emits
  `memory_not_found` / `conflict`). The batch path reports whatever code each
  item's `DomainError` carries, so it inherits today's behaviour rather than
  asserting the aspirational codes. Reconciling the drift is left to a separate
  change.

## Decisions

### Decision 1 — Extend the existing tools, do NOT add new tool names.

Alternatives considered:

- **(A) New tools `memory.judge_batch` / `memory.confirm_batch`.** Clean schema
  per tool, but adds two names to the MCP manifest advertised to all four
  clients, doubling the `tools/list` surface for a behaviour that is logically
  the plural of an existing verb. The single unified `plugin` release track
  (CLAUDE.md) means any manifest-visible change ripples to every client's
  description budget and the `instructions` token ceiling.
- **(B, chosen) Backward-compatible extension of `memory.judge` /
  `memory.confirm`.** The schema accepts EITHER the existing scalar field OR a
  new array field; the handler branches on which is present. No new tool name,
  no manifest churn, and the agent learns one tool that does both. Trade-off: a
  union-shaped input schema (zod) is slightly less self-documenting than two
  tools — mitigated by the tool description spelling out both forms.

Chosen: (B). The plural is the same verb; a new name would be redundant surface.

### Decision 2 — Batch judge runs per-item transactions, NO outer transaction.

Alternatives considered:

- **(A) One outer `db.transaction` wrapping all items.** Atomic all-or-nothing,
  but a single bad `judgmentId` (already-closed, or bogus) would roll back every
  good judgment in the batch — exactly the failure the batch is meant to avoid,
  and the friction that makes agents skip judging. It would also require
  reaching into the transaction runner from the MCP layer.
- **(B, chosen) Loop `RelationsService.judge` per item; collect per-item
  results.** `judge` already opens its own transaction
  (`apps/server/src/services/relations.ts:122`), so each item is atomic on its
  own. A thrown `DomainError` for one item is caught, recorded as
  `{ ok: false, judgmentId, code, message }`, and the loop continues. The
  `supersedes` side effect of a successful earlier item is durable regardless of
  a later failure.

Chosen: (B). Per-item isolation is the whole point; partial success is the
desired semantics.

### Decision 3 — Batch confirm runs ONE outer transaction.

Alternatives considered:

- **(A) Per-id transactions (mirror judge).** Unnecessary: `confirm` is a pure
  append of a `confirmations` row with no cross-row side effect and no
  agent-supplied verdict to be individually wrong. The `needsReview` ids come
  from the server's own `memory.context` output, so a bad id is the unusual
  case, not the norm.
- **(B, chosen) One `this.tx.transaction` around the loop.** All affirmations
  land together; a missing/out-of-scope id throws `memory_not_found` and aborts
  the batch cleanly (the agent re-issues with the valid subset). This is the
  cheaper, simpler path for an idempotent append and matches how the service
  already batches the `save` + relations writes
  (`apps/server/src/services/memory.ts:160`).

Chosen: (B). Confirm is idempotent and side-effect-free; atomicity is fine and
the inputs are server-vended.

### Decision 4 — Suppress dismissed `not_conflict` by walking the `replaces` ancestry of the source, NOT the new id.

Alternatives considered:

- **(A) Exclude pairs by the new memory's own id.** Useless: the new save has a
  brand-new id, so no prior `memory_relations` row references it — the detector
  would still re-surface every old dismissal.
- **(B) Add a topic/content key to `memory_relations` and dedup on it.**
  Requires a table-rebuild migration (SQLite has no cheap `ADD COLUMN` with the
  back-population this needs) and a load-bearing schema change for a read-time
  filter — disproportionate.
- **(C, chosen) Resolve the new memory's `replaces` ancestry (the ids of the
  predecessors it supersedes, available from `findScopeTupleById(...).replaces`,
  `apps/server/src/db/repositories/memory-repository.ts:352-356`) and exclude
  every `target_id` that those source ids judged `not_conflict`.** A new
  repository read returns those target ids; the service merges them into the
  `excludeIds` already passed to both candidate queries. No schema change, no
  migration, and it precisely models "the agent already said this evolving
  topic does not conflict with X."

Chosen: (C). It reuses the existing `excludeIds` plumbing and the existing
`replaces` ancestry; the dismissal follows the topic across re-saves the same
way the supersedes chain does.

### Decision 5 — Suppression is scoped to `not_conflict` only.

Other judged relations (`supersedes`, `conflicts_with`, `related`, `compatible`,
`scoped`) are NOT suppressed: a `conflicts_with` pair SHOULD keep re-surfacing
so the agent re-confronts an unresolved contradiction on the next save, and a
`supersedes`/`related` target is already excluded by `replaces` or is a legit
annotation. Only `not_conflict` means "acknowledged false positive, stop asking"
— matching how `listForMemory` already hides `not_conflict` from search
annotations (`apps/server/src/services/relations.ts:268-269`,
`apps/server/src/db/repositories/relations-repository.ts:156-171`). Alternative
(suppress any judged pair) was rejected because it would silence live conflicts.

## Risks / Trade-offs

- [Trade-off] Union-shaped input schemas (scalar OR array) on two tools →
  Accepted because it avoids two new manifest tool names and the four-client
  release-track churn; the tool description documents both forms.
- [Risk] A batch judge that partially fails could leave the agent unsure which
  pendings remain → Mitigation: the response lists per-item `{ ok, judgmentId,
code? }` so the agent re-issues only the failed ids; the spec pins this shape.
- [Risk] The dismissed-`not_conflict` exclusion set could grow large for a long
  evolving topic and bloat the `excludeIds` JSON passed to the queries →
  Mitigation: the set is bounded by the number of distinct `not_conflict`
  targets across the (typically short) `replaces` ancestry; the queries already
  consume an `excludeIds` array, so no new query shape is introduced.
- [Risk] Suppression could hide a pair the agent WANTS to re-judge after the
  facts changed → Mitigation: suppression is `not_conflict`-only; a real
  conflict (`conflicts_with`) is never suppressed, and the operator can still
  see every relation in the dashboard.
- [Trade-off] Batch confirm aborts the whole batch on one bad id (outer tx) →
  Accepted because the ids are server-vended by `memory.context.needsReview`, so
  a bad id is anomalous, and `confirm` is idempotent so a retry is safe.

## Migration Plan

No data migration. Pure additive code change behind backward-compatible schemas.
Order: (1) repository read for dismissed `not_conflict` targets; (2)
`findSaveTimeCandidates` exclusion merge; (3) `MemoryService.confirmMany`; (4)
MCP schema/handler/output extensions for `memory.judge` and `memory.confirm`;
(5) tool descriptions. Each step lands with its own test. No flag, no rollback
beyond reverting the commit (no persisted state changes shape).

## Open Questions

- Should the batch judge cap the array length (e.g. ≤ `CANDIDATES_PER_SAVE_MAX`
  or a small constant) to bound a single call? The spec below pins a cap of 25
  items to match the existing context-size maxima style; revisit if a real
  workload needs more.
- Should `confirmMany` deduplicate ids before looping (a repeated id would
  insert two `confirmations` rows)? The spec below requires de-duplication so a
  caller passing the same id twice records one affirmation; confirm this matches
  operator expectations.
