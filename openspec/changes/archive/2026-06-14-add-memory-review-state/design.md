## Context

Rembric currently has exactly one staleness mechanism: the deterministic decay pass in the consolidation sweep (`apps/server/src/consolidation/{decay,runner}.ts`). Decay archives an `active` memory when `last_seen_at < now - thresholdMs` **and** `confirmationCount < confidenceFloor`. It is keyed entirely on `last_seen_at` (touched on every `get` / `search` / `confirm`) and on confidence (count of `confirmations` rows).

That design answers one question well — _"is this an untrusted memory nobody looks at anymore?"_ — and archives it. It structurally cannot answer a different question: _"is this a trusted memory that may simply have gone out of date?"_ The confidence floor that makes decay safe (it won't archive something confirmed even once) is exactly what lets a confirmed-but-stale memory live forever as `active`.

These are two orthogonal axes:

```
                 confidence / access  (DECAY — already exists)
                 "untouched + untrusted → archive"
                          ▲
                          │  keyed on last_seen_at (moves on ANY read)
   never re-affirmed  ────┼────────────────────────────▶  affirmation  (REVIEW — this change)
                          │                                "shelf life elapsed → flag for re-verify"
                          │  keyed on confirmation event_ts (moves ONLY on create / confirm / save)
```

A memory read every day has a fresh `last_seen_at` (decay never fires) yet can be eight months past its last affirmation. Nothing surfaces it. This change adds the affirmation axis as a **derived read-time signal** — not a new sweep, not a new table, not a new mutation verb.

## Goals / Non-Goals

**Goals:**

- Surface, on read, that an `active` memory has not been re-affirmed within its type's shelf life (`reviewState = 'needs_review'`).
- Keep the time math in **one** pure, unit-tested place (`deriveReviewState`) with a single TTL source (`REVIEW_TTL_MS`).
- Resolve a `needsReview` item through **verbs that already exist** (`confirm` / `save+topic_key` / `judge`), so no new agent-facing tool and no new lifecycle mutation are introduced.
- Add zero background work: the state is derived in the read projection; there is no sweep, cron, or persisted column.

**Non-Goals:**

- **No `mark_reviewed`-style verb.** Re-affirmation is `memory.confirm`, which already exists, is already journaled (append-only `confirmations` event), and is already reversible. Adding a dedicated reset verb would be an un-journaled lifecycle `UPDATE` — rejected as an invariant violation (see D4).
- **No change to decay.** Decay stays the sole _archival_ authority. `needs_review` never archives anything; it only annotates and surfaces.
- **No persisted `review_after` column.** Persisting it would require a sweep or write-path to keep it current and a migration; the derived form is strictly cheaper and cannot drift.
- **No re-ranking / filtering by review state.** It is metadata. Search ordering, scope isolation, and `includeArchived` semantics are untouched.
- **No new sync / cross-device concern** — Rembric is a single SQLite file; there is no wire format to extend.

## Decisions

### D1: Review state is derived at read time, never persisted

**Choice:** `reviewState` and `reviewAfter` are computed in the read projection from `(type, created_at, status, latest confirmation event_ts)`. No column is added to `memory`.

**Why:** A persisted `review_after` would need either a background sweep or a write on every confirm to stay correct, plus a table-rebuild migration. The derived form is a pure function of data we already store, costs one extra read-side computation, and can never be stale relative to the confirmations table. It also keeps the change free of the append-only / migration machinery entirely.

**Cost:** the `needsReview` context query and the `search` / `get` projections must know each memory's latest confirmation timestamp. We already compute `countConfirmations` in `get`; this adds a sibling "latest event_ts" read (batched for `search` / context).

### D2: Baseline is the affirmation timestamp, not `last_seen_at`

**Choice:** `reviewBaseline = max(created_at, latest confirmation event_ts)`.

**Why:** `last_seen_at` is touched on every `get` and `search` (`touchLastSeenBatch`), so deriving review from it would mean _reading_ a memory resets its review clock — reading is access, not affirmation, and would make the signal nearly impossible to ever trigger for popular memories. `last_seen_at` is already the decay axis; reusing it here would collapse the two orthogonal axes back into one. The confirmation `event_ts` moves only on `create` (the row's own `created_at`) and on `memory.confirm` (and, for a superseding `save`, the new row's `created_at`) — exactly the "this was affirmed true" events.

**Consequence:** `memory.confirm` is, by construction, the canonical "mark reviewed" action — it inserts a confirmation event whose `event_ts` advances the baseline past `now`, clearing `needs_review`, while also raising confidence (which protects the memory from decay). One verb, both axes served, already journaled.

### D3: TTL is per-`type`, in one source, pushed into SQL as a generated CASE

**Choice:** `REVIEW_TTL_MS: Partial<Record<MemoryType, number>>` in `apps/server/src/services/review.ts`. Defaults (tunable, soft re-verify nudges — not hard expiries):

| `type`      | shelf life | rationale                                                                                                                              |
| ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `project`   | 3 months   | work context (goals, constraints, in-flight decisions) churns fastest                                                                  |
| `feedback`  | 6 months   | working-style guidance drifts but slowly                                                                                               |
| `user`      | 12 months  | who-the-user-is changes rarely                                                                                                         |
| `reference` | _none_     | a pointer (URL, dashboard, ticket) — staleness shows up as a broken link on use, not on a clock; periodic re-verify nags are low value |

A type absent from the map (or mapped to `undefined`) never produces a `reviewAfter` and is always `fresh`. The full `MemoryType` enum is `user | feedback | project | reference`; `reference` deliberately opts out, which also exercises the no-TTL contract path with a real type.

**SQL duplication avoided:** `findNeedsReviewIds` builds its `CASE WHEN type = ? THEN ?` ladder by iterating `REVIEW_TTL_MS` entries, so the map remains the only place the numbers live. The pure `deriveReviewState` helper reads the same map for the projection path. The numbers are never typed twice.

**Open decision for review:** the exact month values are a soft default. The operator may want them shorter (more aggressive re-verification) or some types set to "never". Captured as a follow-up to confirm during the joint review, not a blocker.

### D4: `needsReview` is unary and resolves via existing verbs — it is NOT a second judgment channel

**Choice:** `needsReview[]` carries single memories (`{ id, type, title, snippet, reviewAfter, ageMs }`), and its documented resolution is `confirm` / `save+topic_key` / `judge`. We do **not** add a `mem_review`-style tool, a `mark_reviewed` verb, or fold review items into `pendingJudgments`.

**Why not a dedicated review tool + reset:**

- It would open a **second** agent-facing "aged items" channel parallel to `pendingJudgments[]`, with different close semantics — cognitive and architectural duplication.
- A `mark_reviewed` reset is a lifecycle-affecting write with **no journal entry and no reversibility**, violating "every consolidation op journaled and reversible" and the broader rule that lifecycle transitions are either deterministic-and-journaled (the sweep) or judged-with-a-verdict (`memory.judge`).

**Why not reuse `pendingJudgments`:** that list is **pairwise** (`sourceId ↔ targetId`) and is closed by a relation verdict (`memory.judge`). A stale single memory has no counterpart and no verdict to record — confirming or superseding it is the natural close. Forcing it through a pairwise channel would distort relation semantics. The two lists are kept separate and never overlap.

**Why this is sufficient:** every exit from `needs_review` already has a home — `confirm` (still true), `save+topic_key` (changed), or the existing save-time `candidates[]` → `judge` flow (contradicts another memory). The feature is purely _derive + surface + teach_; it adds no mutation machinery.

### D5: Read-only repository additions, scoped like decay

**Choice:** `findNeedsReviewIds` mirrors `findDecayCandidateIds` exactly in scoping (`scope`/`projectId` filter, `status = 'active'`) and shape (returns ids; the service hydrates via `unsafeGetByIds`). Latest-confirmation lookup is a read-only join over `confirmations`.

**Why:** keeps scope enforcement identical to the existing, audited path; no new SQL surface outside `db/`; the data-access confinement invariant (`invariants.test.ts`) is satisfied because all SQL stays in the repository.

## Data flow

```
memory.context
   ├─ recentSessions / recentPrompts / recentMemories   (unchanged)
   ├─ pendingJudgments[]   pairwise, aged, → memory.judge          (unchanged)
   └─ needsReview[]        unary, shelf-life elapsed, ≤5, oldest first   (NEW)
            │
            │ agent reads with fresh context
            ▼
      still true ──────────▶ memory.confirm        (event → baseline advances → fresh; +confidence)
      changed ─────────────▶ memory.save+topic_key (supersedes prior row)
      contradicts another ─▶ candidates[] → memory.judge   (pairwise, existing)
            │
            ▼
   all journaled / reversible — no new mutation path
```

## Risks / Trade-offs

- **Noise:** if a scope has many old memories, `needsReview` could surface a steady drip. Mitigated by the ≤5 cap, oldest-first ordering, and tunable TTLs (D3). It never blocks or mutates; worst case is an ignorable hint.
- **Confirmation cost on read paths:** `search` and context now need latest-confirmation timestamps. Mitigated by batching (one query per id-set) and by the fact that `get` already pays a confirmations read.
- **Month-as-fixed-ms approximation:** `REVIEW_TTL_MS` treats a "month" as a fixed span. For a soft re-verify nudge this is immaterial; it is documented as approximate, not a calendar computation.

## Migration / rollout

None required. No schema change, no data backfill, no migration. The feature is additive on read: existing clients that ignore `reviewState` / `needsReview` are unaffected; the fields simply appear in responses.
