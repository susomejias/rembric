## Why

Our staleness handling has a blind spot. Decay (`apps/server/src/consolidation/decay.ts`) archives a memory only when it is **both** untouched past a threshold **and** below the confidence floor (`confidence < 1`). The confidence floor is deliberate — it protects established facts from silent archival — but the side effect is that a memory confirmed even once and then quietly gone out of date lives as `status = 'active'` **forever**, with nothing ever flagging it for re-verification. On read, a `project` memory affirmed eight months ago is indistinguishable from one affirmed yesterday.

Decay answers "has anyone _touched_ this lately, and was it ever trusted?" (an **access + confidence** axis, keyed on `last_seen_at`). It cannot answer "has anyone _re-affirmed that this is still true_ within its useful shelf life?" (an **affirmation** axis). The two are orthogonal: a memory can be read every day (fresh `last_seen_at`, decay never fires) and still be factually stale because nobody has re-confirmed it.

This change adds the missing affirmation axis as a **derived, read-time-only** review state, built entirely on primitives we already have — the per-`type` shelf life and the existing append-only `confirmations` event table — with **no new MCP tool, no new mutation verb, and no load-bearing invariant touched**. The "I re-verified this" signal is the existing `memory.confirm`, which is already journaled (append-only event) and already reversible.

## What Changes

- Introduce `REVIEW_TTL_MS` — a per-`type` shelf-life map (the single source of truth for review cadence), one entry per `MemoryType`. A type with no entry never needs review.
- Add a **derived, read-time-only** review state to the memory domain. For a memory with `status = 'active'`:
  - `reviewBaseline = max(created_at, latest confirmation event_ts)` — the last time the memory was **affirmed** (created or `memory.confirm`'d). Deliberately **not** `last_seen_at`: reading a memory is access, not affirmation, and `last_seen_at` is already the decay axis.
  - `reviewAfter = reviewBaseline + REVIEW_TTL_MS[type]` (null when the type has no TTL).
  - `reviewState = (reviewAfter != null && reviewAfter <= now) ? 'needs_review' : 'fresh'`.
  - Computed in the read projection. **No new column, no persisted state, no sweep, no cron.** Memories that are not `active` (`superseded` / `archived`) have no review state.
- Expose `reviewState` (and `reviewAfter` when non-null) on `memory.search` and `memory.get` response rows as metadata. Informational only — it never changes ranking, filtering, or scope behaviour.
- Add a `needsReview` list to the `memory.context` envelope: at most 5 `active` in-scope memories whose derived `reviewState = 'needs_review'`, oldest baseline first, each carrying `{ id, type, title, snippet, reviewAfter, ageMs }`. This is a **unary** signal (one memory, no counterpart), structurally distinct from the existing **pairwise** `pendingJudgments[]` (source↔target); the two lists never overlap and resolve through different verbs.
- Teach the agent, via the existing tool descriptions, that a `needsReview` item is resolved through **verbs that already exist**:
  - still true → `memory.confirm` (records a confirmation event → advances the baseline → clears `needs_review`, and incidentally raises confidence, protecting it from decay).
  - changed → `memory.save` with `topic_key` (supersedes the prior row via the existing upsert path).
  - contradicts another memory → the existing save-time `candidates[]` → `memory.judge` flow (pairwise, already journaled).

## Capabilities

### New Capabilities

_None._ The change adds a derived-state requirement to `memory` and extends the `memory.context` / `memory.search` / `memory.get` contracts in `mcp-api`.

### Modified Capabilities

- `memory`: new requirement — `active` memories SHALL expose a **derived** review state (`fresh` | `needs_review`) computed from the `type` shelf life and the affirmation baseline at read time. The state is never persisted and never mutates a row.
- `mcp-api`: `memory.context` response SHALL include a `needsReview` list (≤5, unary, oldest first); `memory.search` and `memory.get` response rows SHALL carry `reviewState` (and `reviewAfter` when non-null) as metadata.

## Impact

Affected code:

- `apps/server/src/services/review.ts` (new) — `REVIEW_TTL_MS` map + pure `deriveReviewState({ type, createdAt, status, lastConfirmedAt }, now)` helper. Single source of truth for the time math, fully unit-testable.
- `apps/server/src/db/repositories/memory-repository.ts` — (a) a batch read returning the latest confirmation `event_ts` per memory id (read-only join over `confirmations`); (b) `findNeedsReviewIds(scope, projectId, now, ttlMap, limit)` mirroring `findDecayCandidateIds`, with the per-type TTL pushed into SQL as a `CASE` built from `REVIEW_TTL_MS` so the map stays the only source.
- `apps/server/src/services/memory.ts` — wire the derived field into `get` / `search` projections; expose a scoped `needsReview` query for context assembly. No write path changes.
- `apps/server/src/mcp/sessions-tools.ts` — add `needsReview` to the `memory.context` envelope (mirrors the existing `pendingJudgments` assembly block).
- `apps/server/src/mcp/server.ts` — extend the `memory.search` / `memory.get` / `memory.context` tool descriptions to teach the review-resolution flow. No new tool is registered.

Affected APIs:

- MCP `memory.context` — additive `needsReview` field.
- MCP `memory.search` / `memory.get` — additive `reviewState` / `reviewAfter` metadata on response rows.

Load-bearing invariants touched: **none.**

- **Append-only memory** — review state is _derived_, never stored; resolution uses `confirmations` (append-only) and `topic_key` supersede (existing). No row `DELETE`d, no `content` `UPDATE`d, no new lifecycle mutation verb.
- **Fresh-context judgment** — the conflict path is unchanged; `needsReview` is a separate unary channel resolved via `confirm` / `save`, falling back to the existing `judge` flow only when a contradiction is involved.
- **Deterministic consolidation, no cron** — decay remains the sole archival authority; review adds zero background work (pure read-time derivation).
- **Scope enforced at the service layer** — the `needsReview` query is scoped exactly like `findDecayCandidateIds` / `recentForContext`; it never crosses scope.
