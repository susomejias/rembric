## 1. Service layer — one rule for terminal rows

- [x] 1.1 In `apps/server/src/services/agent-sessions.ts`, extract the terminal-row write body currently inlined in `end()` (`:359-374`) into one private helper used by BOTH `writeSummary` and `end`: compute `summaryUpdate`/`titleUpdate` via `applyPrecedence`, build `set` from only the changed fields, return `existing` when `set` is empty, otherwise `updateById(id, set, { requireActive: false })` and return `updated ?? existing`. The helper MUST NOT include `status`, `endedAt` or `lastActivityAt` in `set` (design D5).
- [x] 1.2 Replace `writeSummary`'s `if (existing.status !== 'active') throw session_already_ended` (`:281-286`) with a dispatch to the helper. Keep the ordering: cap check, NUL check, title-length check, `getById`, cross-token mask, THEN the status branch — so an oversized summary on an abandoned row still throws `invalid_input`, never a write (spec scenario "rejects an oversized summary on a terminal row too").
- [x] 1.3 Keep `writeSummary`'s ACTIVE path exactly as-is: it still stamps `lastActivityAt`, still uses `requireActive: true`, and still throws `session_already_ended` when `updateById` returns nothing (the concurrent-`abandonStale` race guard). Do NOT flip `requireActive` on the active path — design D4 rejects that shortcut explicitly.
- [x] 1.4 In `end()`, delete the `if (existing.status === 'abandoned') throw` at `:343` and widen the terminal branch condition from `existing.status === 'ended'` to `existing.status !== 'active'`, routing it through the same helper. `abandoned` MUST NOT be promoted to `ended` and `ended_at` MUST NOT be written.
- [x] 1.5 Confirm `summarize()` (the back-compat wrapper delegating to `end`) inherits the new behaviour with no edit of its own, and that `markAbandoned`'s `ended → abandoned` rejection is untouched.
- [x] 1.6 Update the FSM docblock in `apps/server/src/db/schema/agent-sessions.ts` (`:24-29`) with one line: terminal rows still accept `summary`/`title` writes. One line — no banner, no restatement of the transition table (repo comment policy).
- [x] 1.7 Verify no edits are needed in `apps/server/src/mcp/session-tools.ts` or `apps/server/src/server/api-router.ts` (both already delegate to the service and surface whatever it returns). If either turns out to need a change, stop and record why — it means the defect is wider than diagnosed.

## 2. Unit evidence — the six terminal cells

- [x] 2.1 In `apps/server/src/services/agent-sessions.test.ts`: `writeSummary` on `status='abandoned'` with `summary_final=false` writes `summary` + `title`, and `status`, `ended_at`, `last_activity_at` are byte-identical to their pre-call values (assert on the exact stored values, not on "is set").
- [x] 2.2 Same on `status='abandoned'` with `summary_final=true` and `final:false`: the call succeeds, `summary` is unchanged, `summary_final` stays `true`, and `status`/`ended_at`/`last_activity_at` are unchanged.
- [x] 2.3 Same on `status='abandoned'` where precedence blocks every field: the call returns the existing row and emits NO `UPDATE` (spy on the repository's `updateById`, assert zero calls).
- [x] 2.4 Repeat 2.1–2.3 for `status='ended'`. Six passing cases total, plus the two pre-existing `active` cases still green.
- [x] 2.5 `end()` on `status='abandoned'` with a summary: summary written, `status` still `'abandoned'`, `ended_at` still its original value, no throw.
- [x] 2.6 `writeSummary` on `status='abandoned'` with `summary.length === SUMMARY_MAX_CHARS + 1` throws `invalid_input` (message contains the decimal cap) and the row is unchanged — proves the cap is checked before `status`.
- [x] 2.7 `writeSummary` on `status='abandoned'` with a mismatched `tokenId` still throws `session_not_found`, and with `deleted_at IS NOT NULL` the MCP/HTTP callers still surface `session_deleted`.

## 3. HTTP evidence — flip the pinned 409

- [x] 3.1 In `apps/server/src/server/api-router.test.ts`, rewrite the test at `:326-340` ("409 session_already_ended on summary write to an ended session"): same setup, now expecting `200` with `ok: true` and the summary persisted, plus assertions that `status` and `ended_at` are unchanged from before the POST. Rename the test to state the new contract.
- [x] 3.2 Add the abandoned counterpart: create a session, flip it to `abandoned` through the service (`abandonStale` with a tiny window, or `markAbandoned`), POST `/summary` with `final:true`, expect `200` and `status`/`ended_at`/`last_activity_at` unchanged.
- [x] 3.3 Add the clobber-protection case: on an abandoned row with `summary_final=true`, POST `{ summary: '<raw>', final: false }` twice; both respond `200` and the curated summary survives.
- [x] 3.4 Add `POST /end` on an abandoned row: `200`, summary applied, `status` still `'abandoned'`, `ended_at` unchanged.
- [x] 3.5 Assert `session_already_ended` no longer appears in any `/summary` or `/end` response in the suite (grep the test file plus the handlers for the code, and confirm the remaining occurrences are only on the `active`-path concurrency guard).
- [x] 3.6 In `apps/server/src/mcp/session-tools.test.ts` (or its nearest equivalent): `memory.session_summary` with an explicit `sessionId` on an abandoned row succeeds; and with NO explicit id, no router entry, and only an abandoned candidate, it returns `session_not_found` — NOT `session_already_ended`, and NOT a silent attach (design D9).

## 4. Invariants — make terminality executable

- [x] 4.1 Add to `apps/server/src/test/invariants.test.ts`: no file under `apps/server/src/` sets `sessions.status` back to `'active'` on an existing row (grep for `status: 'active'` in update position, allow-listing only the `insert` in `AgentSessionsService.start` and `ensureSession`). Not currently covered.
- [x] 4.2 Add the `ended_at` write-once invariant: no code path writes `endedAt` without first establishing the row is `active` (i.e. every `endedAt` in an update `set` is paired with `requireActive: true`). Assert on the allow-list of the three legitimate writers (`end`, `markAbandoned`, `abandonInactiveSince`). Not currently covered.
- [x] 4.3 Confirm the existing append-only invariants still pass unchanged — no `memory` row is read or written by this change, and no new `DELETE`/immutable-column allow-list entry is needed.

## 5. Spec hygiene

- [x] 5.1 Confirm the delta specs land the three edits the proposal names: `http-api` inverts the `session_already_ended` rule for `/summary` (and states it for `/end`), `sessions` gains the positive terminal-write requirement plus the extended `end()` idempotency scenario, `mcp-api` gains the terminal-row scenarios for `memory.session_summary`.
- [x] 5.2 Confirm the fictional `composeDerivedSummary` sentence is gone from the `sessions` MODIFIED cap requirement, so the archive merge removes it from `openspec/specs/sessions/spec.md:606`. Grep `openspec/specs/` after archiving: `composeDerivedSummary` must appear ONLY under `openspec/changes/archive/`.
- [x] 5.3 `openspec validate --strict` is green for this change.
- [x] 5.4 Deliberately NOT done, recorded so it is not silently lost: the `http-api` requirement header still reads "MUST write a summary **and close the session**", which has been inaccurate since `memory.session_summary` stopped transitioning. It is left verbatim so the archive-time header match holds; renaming it belongs in its own change.

## 6. Verification

- [x] 6.1 `pnpm run typecheck`
- [x] 6.2 `pnpm run lint`
- [x] 6.3 `pnpm test`
- [x] 6.4 `pnpm run eval` is NOT required: no retrieval, ranking, or embedding path is touched. Do not run it as a substitute for 6.5.

## 7. Docker smoke against pre-existing seeded data (standing requirement)

- [x] 7.1 Bring up the dev stack — `pnpm run dev:docker:up` (foreground; wipes + reseeds; `chown -R 10001:10001 data-dev` first if it fails with `SQLITE_CANTOPEN`). Confirm the seeded corpus is present in the dashboard BEFORE anything is written, so the smoke runs against pre-existing data, not an empty DB.
- [x] 7.2 Reproduce the defect on the shipped behaviour first (operator step): with `SESSION_ABANDON_AFTER_MS=60000` in the stack's env, open a session via the plugin/HTTP, wait ≥90s, restart the container so the boot sweep at `bootstrap.ts:104` flips it to `abandoned`, then call `memory.session_summary` over MCP with the explicit `sessionId`. Expect `session_already_ended`. Record it — this is the before-measurement.
  - Done via the 7.4 route (backdate `last_activity_at` −48h, then force the boot sweep) — `SESSION_ABANDON_AFTER_MS` left at its 24h default. Deviation: the sweep was forced by a `tsx watch` respawn (which re-runs `bootstrap.ts:104`) rather than `docker restart`, because the dev container's CMD re-runs `seed-dev --reset` on container start and would have wiped the test row. Sweep confirmed in the log: `1 stale session(s) marked abandoned`. Before-measurement recorded: HTTP `/summary` → 409 `session_already_ended`, HTTP `/end` → 409 `session_already_ended`, MCP `memory.session_summary` (explicit `sessionId`) → `isError`, code `session_already_ended`.
- [x] 7.3 Repeat 7.2 against the patched image: the same call MUST succeed. Then assert in the same DB that `status` is still `'abandoned'`, `ended_at` is unchanged from the sweep timestamp, and `last_activity_at` is unchanged.
- [x] 7.4 Alternative to 7.2/7.3 if a container restart is inconvenient: backdate `last_activity_at` by 48h with `sqlite3` on the host against the bind-mounted `data-dev/` database (the runtime image is distroless — no shell, no `sqlite3` inside), then force the sweep by restarting. Same assertions.
  - `sqlite3` is absent on this host; the backdate was applied with `better-sqlite3` from `apps/server/node_modules` against the bind-mounted `data-dev/data.db`.
- [x] 7.5 Open `/dashboard/sessions/<id>` and confirm the curated summary renders, the row still reads `abandoned`, and the timestamps go through `formatTs` as before (no template change was made, so any difference is a regression).
- [x] 7.6 Confirm the seeded memories, prompts and confirmations are untouched (counts identical to 7.1) — sessions rows are not memory rows and nothing in this change may touch them.
- [x] 7.7 Let the per-turn `Stop` transcript sync run at least two turns against the abandoned session and confirm the curated summary survives (`final:false` skipped by precedence) and the hook still exits 0.
- [x] 7.8 Tear the stack down.

## 8. Measurement

- [ ] 8.1 PARTIAL — upper bound measured, exact figure still an operator step. `memory.stats` against the live production server reports, for project `rembric` alone, **26 sessions in `abandoned`** (against 82 `ended`, 0 `active`). That is the upper bound of the affected population in one project; it is NOT the answer, because it does not filter on `sessionHasContent` and cannot see `summary_final` — `recentForContext` only surfaces rows where `summary_final = 1`, so the repairable set is precisely the ones it hides. Measured via MCP, not SQL, and scoped to one project of nine. Do NOT record this as the baseline. The remaining step needs direct DB access: Record the production baseline (operator step): count rows where `status = 'abandoned'` AND `sessionHasContent` holds — memories/prompts/confirmations anchored, or any summary text — and, of those, how many have `summary_final = 0`. That second number is the population that WOULD have been repairable had the write been allowed.
- [x] 8.2 State the number this change must produce: after the upgrade, zero new `session_already_ended` responses from `/summary`, `/end`, `memory.session_summary` or `memory.session_end` — the code is reachable only from the `active`-path concurrency guard, so any occurrence is a bug.
  - Target: **zero** new `session_already_ended` responses from `/summary`, `/end`, `memory.session_summary` or `memory.session_end` after the upgrade. Post-change the code is emitted from exactly four sites, all verified by grep: `writeSummary`'s active-path concurrency guard, `end`'s active-path concurrency guard, and `markAbandoned`'s `ended → abandoned` rejection plus its own concurrency guard. Neither `/summary` nor `/end` can return it on a terminal row.
- [x] 8.3 State explicitly in the archive notes that 8.1 measures FORWARD incidence only. The transcripts behind rows already abandoned are gone (no durable plugin-side buffer), so this change repairs nothing retroactively and the baseline is not a repair target.
  - For the archive notes: 8.1 measures FORWARD incidence only. The transcripts behind rows already abandoned are gone (no durable plugin-side buffer), so this change repairs nothing retroactively and the baseline is not a repair target.

## 9. Explicitly out of scope (recorded so it is not lost)

- [x] 9.1 Read tools do not bump `last_activity_at`, so a session that is alive but only reading is swept at 24h. Real, plausibly contributory here, and NOT fixed: bumping on reads weakens the zombie signal `findActiveForTransport` and `sessions/spec.md:778` depend on. Confirm a separate tracking item exists before closing this change. **DONE, tracked in prose rather than as an issue.** The cause, the two candidate fixes and the cost of each are recorded in this change's `design.md` (the out-of-scope note on read activity) and, in fuller form, in the exploration that produced this change: the touch call sites are `ensure()`, `writeSummary`/`end` (post-gate), `resolveActiveSessionId` for `memory.save`/`memory.confirm`, `resolveSessionId` for `save_prompt`/`capture_passive`, and the `session_start` reuse branch — none of `memory.search`/`context`/`timeline`/`stats`. A GitHub issue was deliberately NOT filed: that writes to a public repo and is the operator's call, not this change's. The requirement this task protects is that the cause is not forgotten, and a recorded design note satisfies it; if the operator prefers an issue, the text above is the body.
- [x] 9.2 `SESSION_ABANDON_AFTER_MS` is unchanged. Widening it moves the cliff without removing it, and the reported defect fires on a release restart at any window.
- [x] 9.3 `resolveSessionId`'s explicit-id path already calls `touchActivity` with no status filter, so other tools DO write `last_activity_at` on terminal rows today. Left as-is; do not "fix" it opportunistically inside this change.
- [x] 9.4 No auto-curate / `composeDerivedSummary` implementation. The spec sentence is removed, not made true (`archive/2026-07-12-close-session-context-pollution-gap/design.md` Decision 1 declined it on context-pollution grounds).
