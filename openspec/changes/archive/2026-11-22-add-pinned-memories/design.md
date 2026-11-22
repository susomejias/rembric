## Context

The session opening (`memory.context`) has two ranked channels, recency and relevance, and both are quota-bound. A standing rule that is neither recent nor lexically close to the first prompt does not appear. Issue #448 asks for an explicit, bounded, journaled "always load these" state.

Three invariants constrain the design:

- **Append-only memory.** `content` and `title` are never updated; lifecycle is `status` flips plus `replaces` links, and every lifecycle decision is journaled.
- **Derived, not stored.** Review state is computed at read time from append-only `confirmations`; there is no column and no sweep. Pin state should follow the same shape.
- **Scope at the service layer.** Every read and write resolves one project through `resolveEffectiveScope`; no argument can name another.

## Goals / Non-Goals

**Goals:**

- A pinned memory older than the recency window appears in every fresh `memory.context` of its project.
- Pin and unpin are reversible, journaled events visible in the memory's history, including the automatic unpin on retirement.
- The pinned section is bounded by a count and a character budget, both named constants.
- `memory.search` ranking and the retrieval-evaluation ratchet do not move.

**Non-Goals:**

- Boosting pinned memories inside `memory.search` ranking. Pins sit outside the ranked channels by construction.
- Suspending the review axis for pinned memories.
- Restoring a pin when a retirement is undone.
- Carrying a pin across a merge.

## Decisions

### 1. Pin state lives in an append-only event table, `memory_pin_events`

Each pin or unpin appends one row: `memory_id`, `project_id`, `action` (`pin` | `unpin`, closed by a CHECK), `cause`, nullable `run_id` (the retiring journal run, when there is one), nullable `actor` (token name), `event_ts`. The current state is derived: a memory is pinned when it is `active` AND its latest event is `pin`. No row is ever updated or deleted.

Alternatives considered:

- **A mutable `pinned` column on `memory`.** The cheapest read, but an `UPDATE memory` that is neither a status flip nor a `replaces` link widens the append-only contract, and the history the issue requires ("visible in the memory's history") would need a second journal anyway. Rejected.
- **New `consolidation_ops` op types `pin` / `unpin`.** The journal exists, but `affected_ids` is a JSON array, so "is this memory pinned" becomes a `json_each` scan over every op, and every op type must be classified undoable or terminal, which a pin is neither. Rejected.
- **New verdicts on `confirmations`.** The verdict domain is closed at the database level (a table rebuild), and a pin is not an affirmation: it must not move the review baseline or `last_seen_at`. Rejected.

The event table mirrors `confirmations`, the existing append-only lifecycle-event table, and keeps the derivation as cheap as the review axis.

**Ordering.** The primary key is `INTEGER PRIMARY KEY` (the rowid), not a ULID. Two events for one memory can share a millisecond (a pin immediately undone, a carry-forward in the same transaction as the predecessor's unpin, any test with a fixed clock), and a ULID's random suffix does not order events within a millisecond. The rowid is assigned in insert order, and because the table has no DELETE path a rowid is never reused below the maximum, so "latest event" is `MAX(id)`.

**Why `project_id` is on the event.** The pinned list of a project is the hot read (every `memory.context`). Carrying `project_id` lets that read run off one covering index over the event table, without scanning the project's active memories. A memory never changes project at runtime (the only `project_id` rewrite is a migration carve-out), so the column cannot drift.

### 2. Indexes, with the plans that select them

```
memory_pin_events (memory_id)              -- latest event per memory id
memory_pin_events (project_id, memory_id)  -- pinned list of one project
```

Captured with `EXPLAIN QUERY PLAN` on the migrated schema:

- Latest event for a set of ids (read rows, retirement hook): `SEARCH memory_pin_events USING COVERING INDEX memory_pin_events_memory_idx (memory_id=?)`, then `SEARCH e USING INTEGER PRIMARY KEY (rowid=?)`.
- Pinned list of a project (`memory.context`, count bound): `SEARCH memory_pin_events USING COVERING INDEX memory_pin_events_project_idx (project_id=?)`, then rowid and `memory` primary-key lookups.
- Pin history of one memory (dashboard detail): `SEARCH memory_pin_events USING INDEX memory_pin_events_memory_idx (memory_id=?)`.

Both indexes are covering for their `GROUP BY memory_id … MAX(id)` because a secondary index carries the rowid.

### 3. One retirement side effect, shared by every retirement path

Six paths retire a memory and all of them already call `orphanPendingOnRetirement` inside the retiring transaction: `topic_key` revision, `supersedes` verdict, merge, archive, decay, merge undo. A new `releasePinsOnRetirement` runs beside it with the same `RetirementInput` (ids, cause, timestamp, run). It appends an `unpin` event, with the retirement's cause and run, for every retired id whose latest event is `pin`. Both side effects are invoked through one `applyRetirementEffects` call at each site, so a seventh retirement path cannot release one and forget the other.

The derivation also requires `status = 'active'`, so a retirement path that forgot the hook would still never report a retired memory as pinned. The hook exists for the journal, not for correctness of the derived state.

### 4. `topic_key` upsert carries the pin

When `memory.save` supersedes the active row of a topic slot and that row is pinned, the save transaction appends `unpin` (cause `topic_key revision`) for the predecessor and `pin` (same cause) for the successor. The carry is net-zero, so the count bound is not consulted.

Merge does not carry: a merge successor is new text that the user reviewed as a whole, and the issue scopes carry-forward to the topic slot. The pinned originals are released with cause `merge`; re-pinning the successor is one call.

### 5. Bounds

`PIN_MAX_PER_PROJECT = 10` is declared in `packages/core/src/services/memory.ts` beside `DEFAULT_SEARCH_LIMIT` and `PREDECESSOR_CAP`, where the service enforces it; `PINNED_CONTEXT_CHAR_BUDGET = 4000` is declared in `packages/mcp/src/memory-tools.ts` beside `RELEVANCE_LIMIT` and `CONTEXT_SNIPPET_CHARS`, where `memory.context` applies it. Ten is the upper end of "a handful of standing rules"; four thousand characters is roughly a thousand tokens, small next to the default recency channel. The count is checked inside the pinning transaction, so two concurrent pins cannot both pass a stale count (the connection is single and synchronous). A refusal is `DomainError('pin_limit_reached')` whose details carry `{ limit, pinned: [{ id, title }] }`, so the caller can show the user what to unpin.

The budget is a display bound, not a storage bound. `memory.context` walks the pins in pin order; an entry whose full content still fits in the remaining budget is emitted whole, any later entry is emitted through the existing `CONTEXT_SNIPPET_CHARS` snippet with `truncated: true`. The worst-case pinned section is therefore `PINNED_CONTEXT_CHAR_BUDGET + PIN_MAX_PER_PROJECT × CONTEXT_SNIPPET_CHARS` characters of content.

### 6. `memory.context` composition

`pinnedMemories[]` is the first key of the response. The recency channel asks the repository for `memories + pinnedCount` rows and drops the pinned ids, so it still returns up to `memories` unpinned rows. The relevance channel skips pinned ids in both passes and asks the ranked pass for `RELEVANCE_LIMIT + pinnedCount` rows, so a pinned memory never takes a relevance slot. With no pins both requests are exactly today's, so the response is unchanged apart from an empty `pinnedMemories[]`. `needsReview[]` is an action queue, not a recall channel, and is not deduped: a stale pinned rule must still be put in front of the agent for re-verification.

### 7. Undo restores status, not pins

`undoOp` on a decay, archive or merge reactivates the memories but appends no `pin`. A pin is a deliberate act subject to the count bound; an undo that re-pinned silently could push a project past `PIN_MAX_PER_PROJECT`. The released pin stays visible in the history with its cause, so the operator can re-pin in one action.

### 8. Purge

The purge's "disconnected" predicate gains one condition: no `memory_pin_events` row references the memory. A pin history is audit-relevant in the same way a confirmation is, and keeping such rows out of the purge means the event table needs no DELETE path at all, which an invariant test then enforces.

## Risks / Trade-offs

- **A pinned memory can still decay.** Appearing in `memory.context` does not touch `last_seen_at`, so a pinned rule nobody re-affirms can be archived by the sweep, and the pin is released. This is intended: pins must not become the place stale rules hide. The release is journaled and shown on the dashboard.
- **The pinned section adds payload to every opening.** Bounded by the two constants above; an empty project pays one indexed query.
- **Over-fetch on the ranked pass.** Asking for `RELEVANCE_LIMIT + pinnedCount` changes that pass's requested limit when pins exist, so its `gateShortened` flag is measured against the larger request. Pins are rare and capped at ten; with no pins nothing changes.

## Migration Plan

`0041_memory_pin_events.sql` is purely additive: one new table and two indexes. No existing row is touched, so rollback is the previous image (the table is ignored). The runtime-image and CI boot gates move from 40 to 41 migrations.
