## Context

`AgentSessionsService` has two write paths that touch `sessions.summary` / `sessions.title`, and they disagree about terminal rows:

| Path                                                  | `active`             | `ended`                                    | `abandoned`      |
| ----------------------------------------------------- | -------------------- | ------------------------------------------ | ---------------- |
| `writeSummary` (`/summary`, `memory.session_summary`) | writes               | **409**                                    | **409**          |
| `end` (`/end`, `memory.session_end`)                  | writes + transitions | writes (`requireActive:false`, `:359-374`) | **409** (`:343`) |

Three of those six cells are refusals and only one of the three is defensible on its own terms. The refusal that produced the reported defect is `writeSummary` on `abandoned`, reached without any agent error: the 30-minute `abandonStale` reaper (`bootstrap.ts:248`) flips any still-live session past `SESSION_ABANDON_AFTER_MS` (default 24h, `config.ts:121`), and a `docker compose pull && up -d` to take a release runs the boot sweep at `bootstrap.ts:104` on top of that.

Two facts make the refusal costly rather than merely wrong:

- **It is invisible.** The per-turn `Stop` transcript sync POSTs `/summary` through `_api.sh`, which traps `ERR` and exits 0 with stderr suppressed (`_api.sh:11-14`). Every turn after abandonment 409s in silence; the stored summary is frozen at the sweep instant.
- **A late write would actually be read.** `recentForContext` (`agent-sessions-repository.ts:177`) filters only on `deleted_at IS NULL` and `sessionHasContentSql({requireCuratedSummary:true})` — i.e. `summary IS NOT NULL AND summary_final = 1`. There is **no status filter**, so an abandoned row carrying a curated summary surfaces in `memory.context` exactly like an ended one. The plumbing downstream of the refused write is already correct.

Nothing in the tree assumes terminal rows are immutable. Verified: `recentForContext` has no status filter; `purgeEmpty` requires the complete absence of summary text _and_ `title_final = false` _and_ no anchored `memory`/`prompts`/`confirmations` (`sessions/spec.md:370-378`), so a row that receives a late summary becomes _less_ purgeable, never more; the dashboard renders abandoned rows in full and gates only the Abandon form on `active`; `touchActivity` (`agent-sessions-repository.ts:173`) already writes `last_activity_at` on terminal rows today with no status filter.

The change is spec-mandatory because the refusal is a _required_ behaviour (`http-api/spec.md:103` + the scenario at `:178-181`, pinned by `api-router.test.ts:326-340`), while `sessions/spec.md` is silent on the `writeSummary` gate and `mcp-api/spec.md:385-432` states no status precondition at all.

## Goals / Non-Goals

**Goals:**

- One rule for `summary`/`title` writes on a terminal row, shared by `writeSummary` and `end`, so no future reader has to reconstruct the six-cell table above.
- Never mutate `status` or `ended_at`. The sweep's judgment is final; `ended_at` stays write-once.
- Make terminality of the status FSM enforced rather than asserted — an invariant test, not a docblock.
- Delete the fictional compensating mechanism from the spec so the contract stops implying a safety net that does not exist.

**Non-Goals:**

- Any change to `SESSION_ABANDON_AFTER_MS`, to `abandonStale`, or to when the reaper runs.
- Making read tools bump `last_activity_at` (see D6).
- Reviving `abandoned → active`, or any new status transition (see D3).
- Retroactive repair of rows already abandoned with a frozen summary (see D7).
- Implementing `composeDerivedSummary` / server-side auto-curate. The spec sentence is removed, not made true — see `archive/2026-07-12-close-session-context-pollution-gap/design.md` Decision 1, which explicitly declined it.

## Decisions

**D1 — Both terminal states, not abandoned-only.**
The reported defect is `abandoned`, and a minimal fix would relax only that. Rejected: `end()` already accepts a late write on `ended` (`:359-374`), so an abandoned-writable-but-ended-not `/summary` would swap one indefensible asymmetry for another, and would leave the same row reachable-or-not depending on which endpoint the client happened to use. The rule is stated over `status IN ('ended','abandoned')` — a single predicate, expressible as one requirement, one test matrix, and one spec sentence.

**D2 — Unbounded lateness. No window, no new config knob.**
Alternative considered: accept late writes only within N of `ended_at`. Rejected on two grounds. First, any defensible N must exceed a realistic resume gap — a conversation left open over a weekend is the _normal_ case that produced this defect — so N lands in days and the bound buys almost nothing while adding a knob whose only observable effect is to reintroduce the defect on the long tail. Second, the thing a bound would protect against (a stale raw transcript clobbering a good summary) is already handled by the `final` precedence: `summary_final = true` makes every subsequent `final:false` write a silent no-op. The bound would be a second, weaker guard over a hazard the first guard already covers.

**D3 — `status` and `ended_at` are never written on a terminal row; `end()` on `abandoned` does not become `ended`.**
`sessions/spec.md:11` makes `ended_at` write-once, and the FSM's terminality (`schema/agent-sessions.ts:24-29`) is what `findActiveForTransport`, `abandonStale`, `markAbandoned` and `sessions.active` all read. Reviving `abandoned → active` was considered and rejected concretely, not on principle: it produces two `active` rows for one `(token_id, project_id)`, `findActiveForTransport` then returns `undefined` by its own deliberate no-guessing rule (`sessions/spec.md:732`), and session auto-attach silently stops for _every_ subsequent write on that transport — a far worse failure than the one being fixed. `abandoned → ended` was also rejected: it would rewrite `ended_at` and overturn a sweep decision that is itself the audit record of how the session died. A late summary is a write to two mutable columns; it is not a lifecycle event.

**D4 — Converge on one precedence-apply path; the terminal branch is `end()`'s existing `ended` branch, generalised.**
`end()`'s `:359-374` block is already exactly the desired behaviour: compute precedence, build the `set` from only the fields that changed, return `existing` unchanged when `set` is empty, and `updateById(..., { requireActive: false })`. `writeSummary`'s terminal branch is that same block; `end()`'s condition widens from `status === 'ended'` to `status !== 'active'`. The alternative — flipping `requireActive` to `false` on the single existing `writeSummary` update — was rejected because it silently discards the concurrent-transition guard on the `active` path (`if (!updated) throw session_already_ended`), which is the only thing preventing a race between a `/summary` POST and a concurrent `abandonStale` from being reported as an active-session write.

**D5 — The terminal branch does NOT stamp `last_activity_at`; the active branch still does.**
The comment on the active path states the reason it stamps: "a per-turn sync hit means the session is live" (`agent-sessions.ts:300-301`). On a terminal row that claim is false — the row is closed, and `last_activity_at` exists solely to drive stale-active retirement and transport resolution, both of which filter `status = 'active'` and will never read it again. Matching `end()`'s `ended` branch, which stamps nothing, is what "one rule" means here and makes the regression assertion clean: on a terminal row, `status`, `ended_at` and `last_activity_at` are byte-identical before and after. Noted for the reader: `resolveSessionId`'s explicit-id path already calls `touchActivity` with no status filter (`_shared.ts:130`), so other tools do write `last_activity_at` on terminal rows today. That pre-existing looseness is out of scope and is not a reason to add more of it.

**D6 — Reads still do not touch activity, and the abandon window is unchanged.**
A read-heavy session — `memory.search`, `memory.context`, `memory.get` — advances `last_activity_at` on nothing, so a session that is genuinely alive but only reading is swept at 24h. That is a real defect and a plausible contributing cause here. It is _not_ fixed in this change, because bumping activity on reads weakens precisely the zombie signal that `sessions/spec.md:778` and `findActiveForTransport` are built on (a SIGKILLed client's row must stop advancing), so the fix needs its own design and its own evidence. Tracked separately. Widening `SESSION_ABANDON_AFTER_MS` was likewise rejected: it moves the cliff, it does not remove it, and the reported defect fires on a release deploy regardless of the window.

**D7 — Forward-only. The change does not claim retroactive repair.**
A production baseline count of abandoned rows carrying content measures **forward incidence only**. The transcripts behind rows already abandoned are gone — the plugin holds no durable buffer, so there is nothing to replay. No backfill, no migration, no repair script; the proposal says so explicitly so the baseline number is never read as a repair target.

**D8 — Excise the `composeDerivedSummary` sentence rather than implement it.**
`sessions/spec.md:606` describes an auto-curate path that exists nowhere in the tree; it survived from an abandoned branch whose design was explicitly declined in `archive/2026-07-12-close-session-context-pollution-gap/design.md` Decision 1. It matters here because it is the only thing in the spec that would have compensated for a refused late write — a reader auditing this area is told a safety net exists. Removing the sentence is in scope for this change precisely because this change is the one that makes the absence load-bearing. Implementing auto-curate is a separate product decision with its own context-pollution trade-off, already litigated once and declined.

**D9 — MCP session resolution is unchanged; the residual `session_not_found` case is accepted.**
`memory.session_summary` reaches its row through `resolveSessionId` (`_shared.ts:122`): explicit `sessionId` → `SessionRouter` entry → `findActiveForTransport`. The first two are status-blind, so the reported path — the plugin's nudge injects `sessionId="…"` and instructs the agent to pass it explicitly (`prompt-nudge.sh:14`) — reaches an abandoned row and, after this change, succeeds. The third filters `status = 'active'`, so an agent that passes no id _and_ has no router entry still gets `session_not_found`. That is correct and stays: relaxing `findActiveForTransport` to consider terminal rows would let a write silently attach to a closed session chosen by recency, which is the guess the spec forbids. The tests pin `session_not_found` (not `session_already_ended`) for that case so the distinction does not erode.

## Risks / Trade-offs

- **[Risk] A stale per-turn transcript sync overwrites a good summary after the fact.** An abandoned session whose `Stop` hook keeps firing will now succeed instead of 409ing, and could replace a curated summary with raw transcript → **Mitigation**: it cannot. The hook posts `final:false` (`stop-sync.sh`), and `summary_final = true` makes every `final:false` write a silent skip. This is the pre-existing `final` precedence, unchanged; the terminal-row test matrix asserts the skip explicitly for both statuses.
- **[Trade-off] An abandoned row's `summary` can change long after `ended_at`.** An operator reading the dashboard may see a summary newer than the row's own end timestamp → **Accepted because** this is already true of `ended` rows via `end()`'s late-write branch, and the alternative is the current behaviour where the summary is simply wrong. `status`/`ended_at` remaining untouched is what keeps the row's lifecycle history honest.
- **[Risk] `purgeEmpty`'s 1-hour grace period becomes racy in a new direction.** A terminal row with no summary can be purged 1h after `ended_at`, and a genuinely late write then hits a deleted row → **Mitigation**: it surfaces as `session_not_found`, the same as any purged row, and purge requires _zero_ summary text plus `title_final = false` plus no anchored rows, so any session that had content to lose was never purgeable. An earlier draft claimed this makes `sessions/spec.md:377`'s rationale ("to avoid racing with late-arriving summary writes") coherent for the first time. That is backwards, and it is worth saying so plainly because it is the same species of spec fiction D8 exists to excise. A 1-hour grace is a real bound on that race only while the sole legal late write is `end()` on `ended`. With lateness now unbounded (D2), the grace period cannot bound it at all — it merely narrows the window in which a still-empty row is purgeable. The sentence in `sessions/spec.md` is left as-is: it is not made false by this change, only less load-bearing, and rewriting a rationale we are not otherwise touching belongs in its own change.
- **[Risk] Widening the write surface on terminal rows invites a future change to widen it further** (status revival, `ended_at` rewrite) → **Mitigation**: two new invariant tests, neither currently present — no code path sets `sessions.status` back to `'active'`, and `ended_at` is never written twice. The guard is executable, not a comment.
- **[Trade-off] `api-router.test.ts:326-340` flips from asserting a 409 to asserting a 200.** A pinned behaviour is being deliberately unpinned → **Accepted because** that is exactly what the spec change authorises; the replacement assertion is strictly stronger (200 _and_ `status`/`ended_at`/`last_activity_at` unchanged) rather than merely inverted.
- **[Risk] Rollback re-imposes the 409.** After a downgrade, writes that had begun succeeding start failing again → **Mitigation**: no data written under the new behaviour is invalid under the old one (`summary`/`title` were always legal values for those columns), there is no migration and no derived data to invalidate, so rollback loses future writes only — never stored state.

## Migration Plan

None. No schema change, no migration file, no table rebuild, so the migration runner's FK-off / `foreign_key_check` wrapper is not involved. No derived data is invalidated: `memory_fts`, `memory_vec` and the three entity tables are regenerated from `memory`, and no `memory` row is read or written here.

First boot after upgrade is an ordinary restart. The boot `abandonStale` sweep runs exactly as before and abandons exactly the same rows; the only difference is that a subsequent `/summary` or `memory.session_summary` against one of them succeeds. Existing installations carrying hundreds of sessions need no operator action.

Rollback is a plain image downgrade (see the last risk above).

## Open Questions

- **Should the dashboard signal that a terminal row's summary was written after `ended_at`?** There is enough information to render it (`summary_final` plus the timestamps), and an operator seeing a fresh summary on a day-old abandoned row may reasonably wonder. Deliberately left open: it is presentation-only, needs no spec change to add later, and adding a column or badge now would drag the locked dashboard tokens into a service-layer fix. Default if nobody decides: no change to the dashboard.
- **Is `writeSummary`'s active-path concurrent-transition error still the right code?** With terminal writes legal, `if (!updated) throw session_already_ended` on the `active` path can now only fire on a genuine race with `abandonStale`, where retrying would succeed. Arguably it should retry once through the terminal branch rather than surface an error the caller cannot act on. Not resolved here because the window is a single synchronous transaction on one connection and the failure is self-healing on the next turn — but if the e2e in task group 5 ever observes it, that is the signal to revisit.
