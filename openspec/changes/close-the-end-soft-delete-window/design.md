## Context

Two HTTP handlers share one shape:

```
rejectIfDeleted(...)        // reads the row  — api-router.ts:146 (/summary), :190 (/end)
const body = await readJson(c)   // awaits the body stream — :150, :194
deps.agentSessions.writeSummary/end(...)  // re-reads and writes — :159, :201
```

The gate and the write are separated by an `await` on the request body. `sessionEndSchema`/`sessionSummarySchema` admit a 40,000-character `summary`, so the window is a body upload, not a scheduling hiccup. Concurrent `softDelete` is reachable from the dashboard (`dashboard/sessions.ts:478`, `adminBypass`, no status gate).

The service was expected to backstop this, and half does. `end()` and `writeSummary()` both re-read the row (`agent-sessions.ts:356`, `:315`) but only consult `deletedAt` after branching into `writeTerminalFields` (`:264`), which the `status === 'active'` path never reaches. So the backstop covers terminal rows and misses active ones.

Measured on the real router (six arms, both controls green — see `proposal.md`): active rows return `200` and are mutated (RACE-A on `/end`, RACE-C on `/summary`); terminal rows throw and surface as `500` because `statusForCode` (`:335-364`) has no `session_deleted` case, and `domainErr` short-circuits `DomainError` before the only code path that logs.

## Goals / Non-Goals

**Goals:**

- No write path mutates a row whose `deleted_at` is set at the moment of the write, on either status branch, on either endpoint.
- `session_deleted` surfaces as `409` wherever it originates, boundary or service.
- The regression test exercises the interleave, not just a pre-deleted row.

**Non-Goals:**

- Locking, transactions, or optimistic concurrency. The DB connection is single and synchronous.
- Changing what `softDelete` does, or gating it on status.
- Touching the MCP tools: `session-tools.ts:227-230` and `:263-266` have no `await` between gate and write, so no window exists there.
- Deciding `abandonStale`'s relationship to soft-deleted rows (see Open questions).

## Decisions

### D1 — The fresh check is the service's own re-read; hoist the guard to it

Move `if (existing.deletedAt) throw DomainError('session_deleted', …)` out of `writeTerminalFields` and to the top of both `end()` and `writeSummary()`, immediately after the cross-token mask and before the `status !== 'active'` branch. At that point `getById` has just returned, and the `UPDATE` follows in the same synchronous tick.

_Alternative rejected — a second boundary check after `readJson`._ It narrows the window but cannot close it: any check on a different tick from the write reopens it. Worse, it would enshrine the idea that the boundary is authoritative, which is the belief that produced this bug.

_Alternative rejected — wrap read+write in `db.transaction()`._ `better-sqlite3` is synchronous on a single connection; the re-read and `UPDATE` are already un-interleavable. A transaction would add ceremony and change nothing measurable. The defect is a missing predicate, not a missing lock.

_Alternative rejected — keep the check only in `writeTerminalFields` and add one to the active branch._ Two call sites of the same predicate in one method is how the terminal/active asymmetry arose in the first place.

The hoist also subsumes the terminal check: `writeTerminalFields` is only reachable from these two methods, so its own `deletedAt` throw becomes dead and is removed rather than left as a second copy.

### D2 — `session_deleted` joins `statusForCode`'s 409 group

One line: `case 'session_deleted':` alongside `session_already_ended` and `conflict`. This restores what `http-api/spec.md:207-210` already requires for `/summary` and extends the same code to `/end`, which never stated it.

_Alternative rejected — have the service-thrown case re-enter `rejectIfDeleted`'s hand-written response._ That response exists because the mapping was missing; duplicating it keeps two sources of truth for one status. After D2 the boundary's literal `409` and the service's mapped `409` agree by construction, and a future third emitter inherits the mapping for free.

Note what D2 does **not** fix: the missing log line. A `DomainError` legitimately does not go through `httpInternalError`, and once `session_deleted` is a 409 there is nothing anomalous left to log. The absence of an `errorId` stops being a defect the moment the status is right.

### D3 — `writeSummary()` is fixed in this change, not deferred

RACE-C is the same defect, same shape, same file, one handler up. Deferring it would leave a live instance of the class behind a proposal titled "close the window". Both methods get the same three lines.

### D4 — The rule is stated once, in `sessions`

`http-api/spec.md:223` already forbids RACE-A. The `sessions` capability owns the service-layer contract (`sessions/spec.md:60` already says the rejection is evaluated "at that boundary AND in the service"), so the freshness clause and the both-branches scope go there, under **Sessions MAY be soft-deleted while preserving the audit trail**. `http-api`'s `/end` requirement gains only the 409 mapping and a race scenario, and points at `sessions` for the rule — mirroring how it already delegates the terminal-row rule.

`sessions/spec.md:60`'s existing sentence is amended in the same delta. Read verbatim it is not violated by the current code (the service check _is_ evaluated, for terminal rows), but it sits under a requirement about terminal rows and reads as scoping the service check there. Leaving it would leave the contract describing a guard location that no longer exists after D1.

### D5 — The regression test must interleave, and must ship with a control

A test that soft-deletes _before_ the request passes both before and after D1 — it exercises `rejectIfDeleted`, which was never broken. The regression test therefore stalls the body and interleaves the `softDelete`, and CONTROL-1 (active row, no interleave → `200`, `ended`) lives in the same file, because with only a failing arm a broken harness is indistinguishable from a real defect. The reproduction harness already proved this: a first attempt signalled the interleave from `ReadableStream.start`, which undici pulls at `Request` construction rather than at `c.req.json()`, so every race arm silently degenerated into CONTROL-2 and returned a clean `409`. The signal must come from the handler's own `getById`.

## Risks / Trade-offs

- **A caller that legitimately ends a soft-deleted row starts failing.** → Re-verified by sweep, not assumed: all four production callers of `end()`/`writeSummary()` pre-check (`api-router.ts:159`, `:201`; `session-tools.ts:230`, `:266`); `summarize()` has no production callers; the two seed scripts operate on rows they just created; `abandonStale` never routes through `end()` (`agent-sessions-repository.ts:216-228` filters on `status` only). Task 1.1 re-runs the sweep before the hoist lands.
- **`mutate.mjs` mutates the wrong site.** → `agent-sessions.ts` already contains the literal `if (existing.deletedAt) {` at `:264`, `:466` and `:491`; the hoist makes a fourth and fifth. `mutate.mjs` does a literal replace, so a bare `--mutation 'if (existing.deletedAt) {'` would silently disarm `softDelete`'s idempotency instead of the new guard and "prove" coverage that does not exist. Every mutation string in `tasks.md` carries the enclosing throw line to be unique, and the task asserts a single match before running.
- **The 409 is a behaviour change for clients.** → The plugin hooks suppress output and exit 0 (the same reasoning `http-api/spec.md:203` records for the `/summary` 409), and the only way to observe the new code is to lose a race an operator started. Nothing retries into a loop.
- **The fix is three lines and could look untested.** → The measurement in `tasks.md` names the exact arms and their required statuses, and the mutation step proves the guard is load-bearing on the interleaved path specifically.

## Migration Plan

None required. No schema change, no migration file, no derived-data invalidation (`memory_fts`, `memory_vec` and the three entity tables are regenerable from `memory` and no `memory` row is involved). First boot after upgrade behaves identically to the last boot before it. Rollback is a code revert; because the change only ever prevents an `UPDATE` that should not have occurred, no row written under the new code is unreadable by the old.

## Open Questions

1. **Should `abandonStale` skip soft-deleted rows?** Deliberately deferred, not silently decided. `abandonInactiveSince` (`agent-sessions-repository.ts:216-228`) filters on `status` and the activity cutoff only, so it retires soft-deleted active rows. Once D1 lands, `end()` refuses a row that the sweep will still transition — a visible asymmetry. It is left alone because the sweep is the safety net against zombie rows (a soft-deleted row that stays `active` forever still occupies `findActiveForTransport` reasoning), and because `sessions/spec.md:579` constrains that family to writing `status` and `ended_at` only. Changing it is a behaviour change to the reaper and deserves its own evidence. Recorded here so the asymmetry is a known position rather than an oversight.
2. **Should `summarize()` be deleted?** Its docstring (`agent-sessions.ts:383-388`) already says "remove in a follow-up change once those are migrated", and the sweep for this change found the migration is complete — it has no production callers. Deleting it is out of scope here (it would need its own spec delta), but this change confirms the precondition its own docstring names. Default if nobody objects: a separate cleanup change.
