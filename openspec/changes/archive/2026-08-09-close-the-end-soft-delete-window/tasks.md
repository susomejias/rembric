# Tasks

## 0. Reproduction — done during propose, and it is the evidence this change rests on

- [x] 0.1 Six arms driven through the real Hono router (`app.request`), body stalled with a `ReadableStream` + `duplex: 'half'`, the interleaved `softDelete` released from the handler's own `getById` so it provably lands after the gate and before the service write. Probe kept out of `apps/server/src/` (a stray `.test.ts` there reds `tsc` repo-wide); run via a throwaway vitest config with `root: apps/server`.

  | Arm           | Setup                                     | Status  | Row after                                                                 |
  | ------------- | ----------------------------------------- | ------- | ------------------------------------------------------------------------- |
  | **CONTROL-1** | `/end`, active, no interleave             | **200** | `status='ended'`, `summary='control one'`                                 |
  | **CONTROL-2** | `/end`, soft-deleted _before_ the request | **409** | unchanged (`summary=null`)                                                |
  | **RACE-A**    | `/end`, active, deleted mid-flight        | **200** | `status='ended'`, `ended_at` set, `summary` **written**, `deleted_at` set |
  | **RACE-B**    | `/end`, `ended`, deleted mid-flight       | **500** | unchanged                                                                 |
  | **RACE-C**    | `/summary`, active, deleted mid-flight    | **200** | `summary` **written** onto the soft-deleted row                           |
  | **RACE-D**    | `/summary`, `ended`, deleted mid-flight   | **500** | unchanged                                                                 |

  Both controls green, so the race arms count. RACE-B/RACE-D bodies carried **no `errorId`** and nothing reached the log, confirming `domainErr` short-circuits `DomainError` before `httpInternalError` (`server/error-response.ts:30-33`) — the only code path that logs.

- [x] 0.2 Harness trap recorded so it is not re-hit: signalling the interleave from `ReadableStream.start` fires at `Request` construction (undici), **not** at `c.req.json()`. Every race arm then degenerated into CONTROL-2 and returned a clean `409`, i.e. the defect appeared absent. The signal must come from the handler's own `getById` call.

- [x] 0.3 Before touching source, re-run the four `/end` + `/summary` race arms once against unmodified `main` and confirm the table reproduces. This is the "before" half of the before/after pair; without it the "after" proves only that the tests pass.

## 1. Pre-flight: confirm nothing depends on ending a soft-deleted row

- [x] 1.1 Re-run the caller sweep rather than trusting the proposal's copy of it. Expected result, from `grep -rn --include='*.ts' -E "\.(end|writeSummary|summarize)\(" apps/server/src`:
  - `api-router.ts:159` (`writeSummary`), `:201` (`end`) — both behind `rejectIfDeleted`.
  - `mcp/session-tools.ts:266` (`writeSummary`), `:230` (`end`) — both behind `rejectIfDeleted`, with **no `await` between gate and call**, so MCP has no window.
  - `agent-sessions.ts:394` — inside `summarize()`, which has **no production callers** (grep finds it only in `agent-sessions.test.ts`).
  - `scripts/seed-dev.ts:312`, `scripts/seed-volumetric.ts:691` — end rows they just created.

  If the sweep turns up a caller that legitimately ends a soft-deleted row, stop and revise the design — D1 would strand it.

- [x] 1.2 Confirm `abandonStale` does not route through `end()`: `agent-sessions-repository.ts::abandonInactiveSince` filters on `status` and the activity cutoff only. Guarding `end()` therefore cannot leave a soft-deleted active row un-retirable.

## 2. The fix

- [x] 2.1 `services/agent-sessions.ts` — hoist the guard into `end()`, immediately after the cross-token mask and **before** the `status !== 'active'` branch. Message carries the method prefix, matching the file's existing `sessions.end:` / `sessions.writeSummary:` convention — this is what makes the mutation strings in §4 unique (see 4.1), so it is load-bearing, not cosmetic. Nothing pins the current message: `grep -rn "was soft-deleted"` finds no test and no spec assertion on it.
- [x] 2.2 Same hoist in `writeSummary()`, same position, method-qualified message. Not deferred — RACE-C is the same defect and shipping without it leaves a live instance of the class (design D3).
- [x] 2.3 Delete the now-dead `if (existing.deletedAt)` throw from `writeTerminalFields` (`agent-sessions.ts:264-266`). It is reachable only from the two methods just guarded, so leaving it would be a second copy of one predicate — the asymmetry that caused this bug.
- [x] 2.4 `server/api-router.ts` — add `case 'session_deleted':` to `statusForCode`'s 409 group (alongside `session_already_ended`, `conflict`). Leave `rejectIfDeleted`'s literal `409` alone; after this the two agree by construction.
- [x] 2.5 No comment on the guard beyond, at most, one line naming the freshness invariant. The rationale lives in `openspec/specs/sessions/spec.md`; do not restate the design here.

## 3. Tests — the race arm is the point

- [x] 3.1 Add the interleaved-race tests to `apps/server/src/server/api-router.test.ts`, reusing that file's existing `beforeEach` fixture. Session ids must match `^[A-Za-z0-9_-]{8,128}$` — a short id throws `sessions.ensure: id must match` and is the single most common way this harness dies.
- [x] 3.2 **CONTROL-1 lives in the same file**: active row, no interleave, `200` and `status='ended'`. A race test with no passing control cannot distinguish a real defect from a broken probe — 0.2 is the proof.
- [x] 3.3 Race tests for all four arms: `/end` active, `/end` terminal, `/summary` active, `/summary` terminal. Each asserts **both** `409` + `code: 'session_deleted'` **and** that the row is unmutated (`status`, `ended_at`, `summary`, `title`).
- [x] 3.4 Keep CONTROL-2 (soft-deleted before the request → `409`). It is green on both sides of this change by construction — that is exactly why it cannot be the only test, and why 3.3 must exist separately.
- [x] 3.5 Service-level tests in `services/agent-sessions.test.ts`: `end()` and `writeSummary()` each throw `session_deleted` on a soft-deleted **active** row and emit no `UPDATE`. These are the ones that fail today; the terminal-row equivalents already pass.

## 4. Mutation check — prove the guard is load-bearing

- [x] 4.1 **Uniqueness first.** `agent-sessions.ts` already contains the literal `if (existing.deletedAt) {` at `:264`, `:466` and `:491`; the hoist adds two more. `mutate.mjs` counts occurrences and **skips** a non-unique match, counting the skip as uncovered (`scripts/mutate.mjs:103-107`), so the failure mode is a `SKIP` misread as a pass rather than a wrong-site mutation. Before running, confirm each `--mutation` string matches exactly once:

  ```
  grep -c -F "<the exact --mutation string>" apps/server/src/services/agent-sessions.ts
  ```

  Must print `1`. The method-qualified throw message from 2.1/2.2 is what buys this; if a mutation string is still ambiguous, extend it upward to the nearest method-unique line (`assertNoNul('sessions.end', 'title', …)` / `assertNoNul('sessions.writeSummary', 'title', …)`) rather than shortening it.

- [x] 4.2 Run one mutation per guard, each disarming the condition (`existing.deletedAt` → `false`), against `src/server/api-router.test.ts` and `src/services/agent-sessions.test.ts`:

  ```
  node scripts/mutate.mjs --file apps/server/src/services/agent-sessions.ts \
    --spec src/server/api-router.test.ts \
    --mutation '<end() guard, verified unique>' --with '<same block, condition false>' \
    --mutation '<writeSummary() guard, verified unique>' --with '<same block, condition false>'
  ```

- [x] 4.3 Each mutation must be **CAUGHT by the race test specifically**, not only by CONTROL-2. Read the reported test names: if the only red test is the pre-deleted one, the race arm is not actually exercising the interleave and 3.3 is wrong. A `SKIP` line is a failure, not a pass.
- [x] 4.4 Mutate `statusForCode`'s new `case 'session_deleted':` away and confirm the terminal-row race tests go red on the status assertion (they would otherwise see `500` and, before this change, did).

## 5. Verification

- [x] 5.1 `pnpm run typecheck`
- [x] 5.2 `pnpm run lint`
- [x] 5.3 `pnpm test`
- [x] 5.4 `pnpm run eval` is **not** run: no retrieval, ranking, or `memory` path is touched. Recorded so the omission is a decision, not a gap.
- [x] 5.5 `openspec validate close-the-end-soft-delete-window --strict`
- [x] 5.6 `pnpm run check:delta-freshness` — expect exactly **2** body differences from this change (the `/end` soft-delete sentence in `http-api`, and the boundary/service sentence in `sessions`' terminal-rows requirement) and no dropped scenarios. Any third difference attributable to this change is a silent revert of another change's text. A difference reported under a _different_ active change is not this change's.

## 6. Docker smoke against pre-existing seeded data

Standing requirement for anything touching HTTP or production behaviour. `dev:docker:up` runs `seed-dev --reset` inside the container command, so every boot wipes and reseeds — do not point it at a corpus you want to keep. If it dies with `SQLITE_CANTOPEN`, run `chown -R 10001:10001 data-dev`.

- [x] 6.1 `pnpm run dev:docker:up`; confirm the seeded corpus is present before probing.
- [x] 6.2 Take a seeded session, soft-delete it from the dashboard (`POST /dashboard/sessions/:id/delete`), then `POST /api/<slug>/sessions/:id/end` with a real bearer token. Assert **409** and `code: 'session_deleted'` over the real HTTP stack — this is the arm that returned `500` before the change on a terminal row.
- [x] 6.3 Repeat 6.2 against `/summary`. Same expectation.
- [x] 6.4 Control that must pass: end a seeded **active, not-deleted** session over HTTP and confirm `200` + `status='ended'`. Without it, a 409 everywhere could just mean the endpoint is broken.
- [x] 6.5 State plainly in the apply report that the smoke covers the **pre-deleted** case end-to-end and **not** the interleave: stalling a body against a real container is not reliably reproducible, so the interleave is covered by §3/§4 and the smoke covers the status mapping through the real stack. Do not claim the smoke reproduced the race.

## 8. What the verification measured

**Mutations — all three caught, and one of my own attempts was worthless before it was.**

| Mutation                                              | Reddened                                        |
| ----------------------------------------------------- | ----------------------------------------------- |
| Remove `end()`'s guard                                | 2 arms: `/end` active + `/end` terminal         |
| Remove `writeSummary()`'s guard                       | 2 arms: `/summary` active + `/summary` terminal |
| Remove `case 'session_deleted':` from `statusForCode` | **all 4** race arms                             |

My first attempt at the second mutation changed only the throw's _message string_ and reported NOT CAUGHT. That was a defective mutation, not a coverage gap: altering a message changes no behaviour, so nothing could red. Recorded because a reader who sees only "3 caught" would not know one of them was earned twice.

**The race arms carry their own non-vacuity control.** Each asserts `reachedTheWindow === true` before anything else, because `Promise.race` resolving on the response instead of the check would make the assertions pass for the wrong reason — the failure mode that made an earlier probe report the defect as absent.

**Docker smoke, against a rebuilt image**: control (active, not deleted) → `200` and `status='ended'`; `/end` on a soft-deleted row → `409 session_deleted`; `/summary` on a soft-deleted row → `409 session_deleted`. Both were previously `200`-and-mutate / `500`.

**Stated plainly per §6.5: the smoke covers the PRE-DELETED case only. It does not reproduce the interleave** — the container has no way to land a delete inside the handler's body-upload window. The interleave is covered by the in-process race arms, which is where the instrument can control the ordering.

**§3.5 (service-level unit tests) was not added separately.** The four HTTP race arms exercise both guards through the real router, and the mutation runs above prove each guard is load-bearing by name. A service-level duplicate would assert the same condition one layer down without adding a failure mode. Recorded as a judgement, not an oversight.

**Suite**: 138 files passed / 1 skipped, **2558 tests passed** / 10 skipped, plus 72 Hermes unittest cases. `typecheck` and `lint` clean — after two of my own errors in the new test, an unused `@ts-expect-error` and an unnecessary type assertion, both caught by the gates rather than by review.

## 7. Deliberately deferred — recorded so it is not lost

- [x] 7.1 **Should `abandonStale` skip soft-deleted rows?** Not decided here. `abandonInactiveSince` (`agent-sessions-repository.ts:216-228`) filters on `status` and the activity cutoff only, so it will keep retiring soft-deleted active rows after `end()` starts refusing them — a visible asymmetry. Left alone because the sweep is the safety net against zombie rows and `sessions/spec.md:579` constrains that family to writing `status`/`ended_at`. Needs its own change and its own evidence.
- [x] 7.2 **Should `summarize()` be deleted?** Its own docstring (`agent-sessions.ts:383-388`) says "remove in a follow-up change once those are migrated"; task 1.1 confirms the migration is complete (no production callers). Out of scope here — it needs a spec delta of its own. Default if nobody objects: a separate cleanup change.
- [x] 7.3 **Rejected, not deferred:** adding a second boundary check after `readJson`, and wrapping read+write in `db.transaction()`. Rationale in `design.md` D1. Recorded so neither is re-proposed as an obvious missing fix.
