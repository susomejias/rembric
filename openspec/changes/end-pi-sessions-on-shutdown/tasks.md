# Tasks

## 1. The shared core gains the session-end verb

- [x] 1.1 `apps/plugin/bin/rembric-plugin-core.mjs` — add an awaited `endSession(sessionId)` next to `flushSessionSummary` (`:217`): skip sub-agent and unknown sessions on the same conditions, build the body with the existing `buildSummaryBody` (`:208`), substitute `{}` when it returns `null`, and POST `/api/${slug}/sessions/${sessionId}/end` through the existing `rembricPost` so it inherits the `POST_TIMEOUT_MS` bound and the one-stderr-line diagnostic. Add it to the returned object (`:271-289`).
- [x] 1.2 `apps/plugin/bin/rembric-plugin-core.d.mts` — declare `endSession(sessionId: string): Promise<void>` on `SessionProtocol` (`:33-51`).
- [x] 1.3 Confirm no second `fetch` against a `/sessions/` path appears anywhere under `apps/plugin/` outside the core: `git grep -n "sessions/" -- apps/plugin/'*.ts' apps/plugin/'*.mjs'` and check every hit is either the core or a test.

## 2. The Pi handler reads the event

- [x] 2.1 `apps/plugin/.pi-plugin/index.ts` — declare a local `SessionShutdownEvent` type alongside the other locally-declared event types (`:42`, `:49`), with `reason?: string` and `targetSessionFile?: string`. **Not** the harness's five-member union: a union types the unknown-reason branch out of existence, which is the branch design D4 exists to keep.
- [x] 2.2 Widen the locally-declared `ExtensionContext.sessionManager` (`:36`) with `getSessionFile?: () => string | undefined`. Optional, for the same reason `ui` is optional — the extension runs in whatever harness version the operator has.
- [x] 2.3 Rewrite the `session_shutdown` handler (`:328-335`) to branch on the reason: an explicit end-set `{quit, new, resume, fork}` selects `core.endSession(sessionId)`, anything else selects today's `core.flushSessionSummary(sessionId)`. Keep the `Promise.all` with `mcp?.close()` and keep `core.forgetSession(sessionId)` after it on both branches.
- [x] 2.4 Add the self-resume guard: compare `event.targetSessionFile` to `ctx.sessionManager.getSessionFile?.()` **only when `targetSessionFile` is a non-empty string**, and fall to the flush branch on a match. A bare `!==` suppresses the end whenever both sides are `undefined`, which is the `quit` case — design D3.

## 3. Per-reason coverage at the handler boundary

The suite already stands up the real server, a real SQLite file and real auth (`plugin.test.ts:1-40`), so every assertion below reads the row through the repositories rather than a mock.

- [x] 3.1 `plugin.test.ts` — `makeHarness` accepts an optional session-file string and stubs `sessionManager.getSessionFile`. `fire` already takes a payload (`:138-142`), so no change is needed there.
- [x] 3.2 One arm per end-set reason (`quit`, `new`, `resume`, `fork`): fire `session_shutdown` with that reason and assert the row has `status === 'ended'` and a non-null `ended_at`.
- [x] 3.3 **The discriminating control**: fire `session_shutdown` with `reason: 'reload'` and assert the row is still `status === 'active'` with `ended_at` unset — **and** that the accumulated transcript still reached the server (`summary` non-null), so a handler that simply did nothing cannot pass this arm.
- [x] 3.4 Self-resume arm: `reason: 'resume'` with `targetSessionFile` equal to the harness's stubbed session file → row still `active`.
- [x] 3.5 Unknown-reason arm: `reason: 'teleport'` (and one with `reason` absent) → row still `active`. This is also what keeps the pre-existing `{}` firings meaningful.
- [x] 3.6 Empty-accumulator arm: fire `quit` on a session with no turns and assert the end POST carried an empty JSON body and the row is `ended` with `summary` still null.
- [x] 3.7 One-request arm: on a `quit`, assert exactly one session-write request reached the server for that id and that it was the end path — no `/summary` POST alongside it.

## 4. Mutation-check both halves of the gate

A guard is not covered until the tests naming it go red without it. Both runs must exit non-zero-findings-free — i.e. `mutate.mjs` must report each mutation reddening something.

- [x] 4.1 Widen the reason filter to always-true and confirm the `reload` arm (3.3) reds:

  ```
  node scripts/mutate.mjs --file apps/plugin/.pi-plugin/index.ts \
    --spec apps/plugin/.pi-plugin/plugin.test.ts \
    --mutation '<the end-set membership expression>' --with 'true'
  ```

- [x] 4.2 Delete the `targetSessionFile` comparison and confirm the self-resume arm (3.4) reds, with the same invocation shape and `--with ''`.
- [x] 4.3 If either mutation reddens nothing, the arm is asserting the wrong thing — fix the test, not the mutation. Record in this file which arm each mutation reddened.

  Three mutations run against `apps/plugin/.pi-plugin/index.ts` with `--spec ../plugin/.pi-plugin/plugin.test.ts` (the spec path is relative to `apps/server`, which is the cwd `mutate.mjs` runs vitest from). All three CAUGHT; the file restored byte-identically each time.

  | Mutation                                                                                                                       | Arms it reddened                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
  | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `CLOSING_SHUTDOWN_REASONS.has(event.reason ?? '')` → `true` (4.1)                                                              | 5: `does not end the session on reason reload, and the transcript still lands` (3.3), `does not end the session on an unrecognised reason` (3.5), `does not end the session when the event carries no reason` (3.5), `the control — without the end, both rows stay active and the save attributes nothing` (5.2), and the pre-existing `the shutdown flush deregisters the session, so a later debounce cannot re-POST it` (it fires `{}` and asserts one `/summary` POST) |
  | `return target === ctx.sessionManager.getSessionFile?.();` → deleted (4.2)                                                     | 1: `does not end the session when the resume names the session file already open` (3.4)                                                                                                                                                                                                                                                                                                                                                                                     |
  | `if (typeof target !== 'string' \|\| target.length === 0) return false;` → deleted, i.e. the bare comparison design D3 forbids | 8: all four end-set reason arms (3.2), the empty-accumulator arm (3.6), the one-request arm (3.7), the successor-attribution arm (5.1) and the teardown-budget arm (6.1). This is the `undefined === undefined` hole: with the string-presence check gone every reason with no `targetSessionFile` reads as a self-resume and nothing ends.                                                                                                                                 |

## 5. The ambiguity fix, with the control that must fail

This is the defect the change exists for, so it gets its own arm rather than being inferred from 3.2.

- [x] 5.1 Sequence: register session `A`, accumulate a turn, fire `session_shutdown` with `reason: 'new'`, register session `B` on the same token and project, then `memory.save` through the extension without naming a `sessionId`. Assert the saved row's `session_id === B` **and** that the count of memories attributed to `B` is non-zero — an equality against an empty result set proves nothing.
- [x] 5.2 **The control that must fail**: the same sequence with the shutdown fired as `reason: 'reload'`, so `A` stays `active` inside `TRANSPORT_STALENESS_MS`. Assert `session_id` is `NULL` and the count attributed to `B` is zero. This is what distinguishes the fix from a test that would pass either way.

## 6. Re-measure the teardown budget — one instrument, named

- [x] 6.1 `plugin.test.ts:719-723` — re-run the existing budget arm with `reason: 'quit'` so it measures the branch a quitting user actually takes, and re-assert `elapsed < POST_TIMEOUT_MS * 2` against the half-dead server the arm already stands up.
- [x] 6.2 Quote the **end-to-end handler wall-clock** in this file, not the isolated POST's timing. Those are two instruments and mixing them has produced a wrong ratio in this repo before. State the number measured, the arm it came from, and whether it moved relative to the pre-change run.

  **3004 ms and 3003 ms** on two runs (`Date.now()` either side of `await harness.fire('session_shutdown', { reason: 'quit' })`, the whole awaited teardown handler), from the arm `shutdown teardown budget > bounds the quit teardown by the flush budget, not the discovery one`. Budget is `POST_TIMEOUT_MS * 2 = 6000 ms`; it holds with ~2× headroom. The stub was strengthened while re-running the arm: it now swallows the session write as well as the transport `DELETE`, and the arm registers one turn first, so the measured teardown is a real `/end` POST **and** the `DELETE` both hanging against a server that answers neither — the worst case a quitting user can face.

  Pre-change comparison, same instrument in the same arm shape: **3001 ms / 3002 ms** for a `session_shutdown` with `{}` on an unregistered session, which is byte-identically the old code path (flush branch, early return, only the `DELETE` outstanding). So the figure **did not move** — as D2 predicts, because the end POST and the `DELETE` are concurrent inside one `Promise.all` and each is bounded by the same `POST_TIMEOUT_MS`. Two sequential POSTs would have put this at ~6 s and broken the assertion.

  Not the isolated POST's timing: that request never completes here at all (the stub holds it until the client's own `AbortSignal` fires), so its own duration is the timeout constant rather than a measurement.

- [x] 6.3 If the figure exceeds the budget, do **not** raise the budget: the one-request design (D2) exists precisely to keep it, so an overrun means the handler is issuing two requests somewhere.

## 7. Real-`pi` validation (mandatory, not optional)

The fake harness supplies `reason` itself, so it cannot prove the harness delivers it. `pi` 0.84.1 is installed in this environment with `@rembric/pi` from npm, so this runs — it is not a rig to be built.

- [x] 7.1 **Point the run at a local stack, never at a real deployment.** The operator's shell exports `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` for a live server; a naive `pi` run in this repo files probe sessions into a production project. Export both explicitly for the run, against either `pnpm run dev:docker:up` or an in-process server on a temp SQLite file, with its own token and its own project slug in `.rembric`. Verify before starting that `REMBRIC_SERVER_URL` resolves to the local stack.
- [x] 7.2 **`dev:docker:up` wipes and reseeds `data-dev` on every boot** — the reset lives in the container command, not in `package.json`, so it is invisible from the script name. Assume no corpus survives between runs, and never point it at a directory holding data anyone cares about.
- [x] 7.3 Run real `pi` in a scratch repo with a valid `.rembric`: one prompt, `/new`, one more prompt, `/quit`. Assert two distinct `sessions` rows for that token and project, the first `ended` with `ended_at` set, the second `ended` too, and each carrying its own summary. Record the row ids and statuses here.
- [x] 7.4 Add a `reload` arm if `reload` is reachable from the CLI. If it is not, say so explicitly in this file — an unrun arm must not be ticked, and design OQ2 names this as the open question it answers.
- [x] 7.5 Assert the memory attribution end-to-end: a `memory.save` in the post-`/new` session lands with that session's id, not `NULL`. This is 5.1 through the real client.
- [x] 7.6 This run doubles as the **Docker smoke** required for anything touching production HTTP behaviour. Use the real stack (`dev:docker:up`) rather than the in-process server for at least one pass, and confirm the dashboard's `/dashboard/sessions` shows both rows with the expected statuses.

  **7.5 took two runs, and the first failure is the better evidence.** The probe saves a memory over MCP with no explicit `sessionId`, fired 40 s into a TUI run so it lands while the post-`/new` session is live. First attempt: `session_id = NULL`. The cause was the bench, not the change — the control run from `git HEAD` had left its row `active` (old code never ends), so two rows were `active` for the same token and project and `findActiveForTransport` refused to guess. That is the defect this change exists to fix, reproduced by accident: **one un-ended session poisons attribution for everything after it.** After ending the leftover row, the probe attached to the session whose transcript is `user: segunda viva` — the one created by `/new`. Recorded because a reader who sees only the passing second run would miss why the arm is worth having.

  **Measured against the real `pi` 0.84.1 CLI and the Docker stack**, with `HOME` pointed at a scratch dir so the operator's `~/.pi` was untouched, the extension loaded per-run via `pi -e <path>` (never installed), `REMBRIC_SERVER_URL=http://127.0.0.1:8788` with a project-scoped dev token, and `--api-key` deliberately invalid so no real model call was billed. Four rows resulted, `agent='pi'`, project `demo`:

  | #   | Run                                                                            | `status` | `ended_at` | `summary`             |
  | --- | ------------------------------------------------------------------------------ | -------- | ---------- | --------------------- |
  | 1   | print mode, new code                                                           | `ended`  | set        | `user: di hola`       |
  | 2   | **control** — print mode, code from `git HEAD` (0 occurrences of `endSession`) | `active` | NULL       | `user: control viejo` |
  | 3   | TUI, first session, closed by `/new`                                           | `ended`  | set        | `user: hola`          |
  | 4   | TUI, second session, closed by `/quit`                                         | `ended`  | set        | `user: segundo`       |

  Row 2 is the discriminating control and it failed in the required direction: same bench, same flow, only the loaded extension and core differing. Both control and treatment wrote a transcript, so neither is a "handler did nothing" artefact. Rows 3 and 4 are task 7.3 exactly — one prompt, `/new`, one prompt, `/quit`, two distinct rows both ended, each carrying its own summary — and they are what proves `reason` is genuinely delivered by the harness, which the fake test harness cannot establish.

  **7.4 — `reload` is NOT reachable from the CLI.** Pi's own invalidation message enumerates the replacement paths: `dist/core/agent-session.js:567` reads "Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload()." All four are extension APIs; no slash command or flag reaches `reload()`. The arm is therefore unrunnable through the real client and stays covered at the handler boundary by the mutation-proven unit arm (3.3). Recorded rather than ticked as if run — design OQ2 asked exactly this.

## 8. Documentation

- [x] 8.1 `apps/plugin/.pi-plugin/README.md` — the "Session close" section (`:87-95`) gains the reason table: `quit`/`new`/`resume`/`fork` end the session, `reload` and a self-resume do not, and a resumed ended session needs an explicit `sessionId` for attribution. Do **not** touch the Ctrl-C paragraphs — that correction is a separate change (task 10.1).
- [x] 8.2 `docs/agents.md:409-413` — the Pi "Session close is awaited" section says the handler writes the final summary and nothing about ending. Add the reason split and the resume consequence, in the same register as the Claude Code section.
- [x] 8.3 Confirm no doc or spec surface now claims Pi sessions never end or that only two clients POST `/end`: `git grep -n "never POSTs\|two of the clients\|abandonStale" -- docs openspec/specs apps/plugin` and check each hit. `openspec/specs/mcp-api/spec.md:539`'s "two of the clients" stays correct — it means Codex and opencode, and Pi leaving that set is exactly what this change delivers, closing the open question `fix-stale-client-count-surfaces` deliberately left.

## 9. Verification

- [ ] 9.1 `pnpm run typecheck` · `pnpm run lint` · `pnpm test` all green. The Pi arm runs only because `apps/server/vitest.config.ts::include` lists `'../plugin/.pi-plugin/*.test.ts'` — confirm the new arms actually executed by reading the reported test count, not by assuming.
- [ ] 9.2 `pnpm run eval` is **not** required: retrieval, ranking and the entity pipeline are untouched. State it rather than skipping it silently.
- [ ] 9.3 `pnpm vitest run apps/server/src/test/invariants.test.ts` — the single-JS/TS-implementation invariant derives its file list by search, so confirm it still passes with `endSession` added and that it would flag a second copy (the mutation in 4.x does not cover this; a hand check of one deliberately-duplicated line is enough, restored immediately).
- [ ] 9.4 `openspec validate end-pi-sessions-on-shutdown --strict` passes.
- [ ] 9.5 `pnpm run check:delta-freshness` reports exactly **3 requirements** whose detail lists **4 body lines** total — the two counts the tool prints in different places: its summary line counts requirements, the `REVIEW` detail counts lines. The four are `pi-plugin`'s import enumeration (1), the lifecycle matrix's two preamble lines (2), and the shared-core enumeration (1). A fifth line, or a fourth requirement, means a delta silently reverted text another change published.
- [ ] 9.6 `pnpm run check:spec-provenance` green (CI is the gate; run it locally before pushing).

## 10. Deferred, recorded so it is not lost

- [ ] 10.1 **Open a separate change for the false Ctrl-C claim.** `openspec/specs/pi-plugin/spec.md:221-223` and `apps/plugin/.pi-plugin/README.md:89-95` state Ctrl-C is not a session-close path; `dist/modes/interactive/interactive-mode.js:3046-3056` has `handleCtrlC()` calling `void this.shutdown()` on a second press inside 500 ms, and `shutdown()` awaits `runtimeHost.dispose()` before `process.exit(0)`, with Pi's own comment at `:3089` reading "Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown())". The evidence is **one pty run away** with the installed CLI (two presses inside 500 ms, plus the >500 ms spacing as the control that must fail) — not an open question, just a published measurement whose retraction deserves its own change and its own scenarios.
- [ ] 10.2 **Two latent server defects around `/end`, out of scope here.** `session_deleted` is absent from `statusForCode` (`apps/server/src/server/api-router.ts:335-364`), so it surfaces as 500 through the TOCTOU window between `rejectIfDeleted` and the service call; and the soft-delete guard for `/end` lives only in the HTTP handler, so `svc.end()` on an active soft-deleted row succeeds. Neither is on this change's path and both are server-side.
- [ ] 10.3 **Rejected, not deferred: letting `ensure` reactivate an ended row.** It crosses the terminal FSM contract two invariant tests bound (`openspec/specs/sessions/spec.md:66`) and would let a resumed session's `memory.session_summary` be dropped by first-final-wins instead. If the resume regression (design D5) ever proves worse than the attribution loss it replaces, that is the change to open — recorded so nobody re-derives it.
