## Context

Five clients, three session-close outcomes. Claude Code POSTs `/end` from its `SessionEnd` hook (`apps/plugin/hooks/hooks.json` → `apps/plugin/scripts/session-end.sh`); Hermes POSTs `/end` from `on_session_end` (`apps/plugin/.hermes-plugin/__init__.py:580`); Codex cannot (its harness declares no `SessionEnd` — `apps/plugin/hooks/hooks.codex.json` has five event types and the `plugin-session-protocol` spec records the absence); opencode deliberately does not; **Pi does not, with no reason recorded anywhere**. The two clients that do not end are the two that route through the shared core `apps/plugin/bin/rembric-plugin-core.mjs`, which has no `/end` path in it — the omission is structural, not a per-client oversight.

Two server facts constrain everything below.

**Terminal is terminal.** `openspec/specs/sessions/spec.md:66`: "No path SHALL transition a session back to `active`", with two CI invariant tests bounding the structure. `AgentSessionsService.ensure` bumps `last_activity_at` and nothing else. So an end issued on a session that keeps running is not a cosmetic error — it is `session_id = NULL` on every subsequent `memory.save` and `session_not_found` from `memory.session_summary` for the rest of that process's life.

**Precedence flips at the terminal boundary.** Active rows are last-final-wins; terminal rows are first-final-wins (`apps/server/src/services/agent-sessions.ts:270-280`). So `/end` followed by a curated `memory.session_summary` silently drops the curated text. Any client-side `/end` must therefore be the last write of that session's life.

The `/end` endpoint itself was measured in-process against a migrated fixture with the real schema and real auth: idempotent (second call → 200 with byte-identical `ended_at`); an `abandoned` row stays `abandoned` and is not promoted; the body is entirely optional (`{}` and no body both accepted); a soft-deleted row → 409 `session_deleted`; a wrong token or wrong project → 404 `session_not_found`. Nothing in this change needs the server to move.

## Goals / Non-Goals

**Goals:**

- Remove the `findActiveForTransport` ambiguity that follows `/new`, `/resume` and `/fork` in Pi, so the new session attributes its memories.
- End the session on exactly the shutdown reasons that are real closes, and provably not on the one that is not.
- Keep the exit latency a quitting user pays inside the budget the suite already asserts.
- Put Pi and opencode into the authoritative per-client lifecycle matrix, which currently has a row for neither.

**Non-Goals:**

- Any server change. No new MCP tool, no migration, no schema edit, no SQL.
- Making opencode end its sessions (D6).
- Correcting the false Ctrl-C claim in the shipped `pi-plugin` spec and README (out of scope by decision; the evidence is one pty run away, see the proposal's out-of-scope list).
- Fixing the two latent server defects around `/end` found while measuring it.
- Any attempt to make a resumed Pi session re-attach automatically (D5 records why, and what would be required).

## Decisions

### D1 — End on `quit`, `new`, `resume`, `fork`; never on `reload`

`SessionShutdownEvent { type: "session_shutdown"; reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string }` (`dist/core/extensions/types.d.ts:462-468`, `@earendil-works/pi-coding-agent@0.84.1`). The doc comment — "Fired before an extension runtime is torn down due to quit, reload, or session replacement" — is the whole story: the event name says nothing about the process, and four of five reasons are session replacement inside a surviving process. Every emit site supplies `reason` unconditionally.

`reload` is the same session continuing, so ending it is the unrecoverable case above.

The gate is written as **membership in an explicit end-set**, not as `reason !== 'reload'`. The two are equivalent today and diverge the moment the harness adds a sixth reason: exclusion would end an unknown reason, membership would not. Not ending is recoverable — `abandonStale` flips the row to `abandoned` after `SESSION_ABANDON_AFTER_MS` (default 24 h) and the per-turn flush has already carried the summary. Ending wrongly is recoverable by nothing.

**Alternative rejected: end unconditionally.** This is what the event name invites and what a reading of the handler at `index.ts:328` would suggest is harmless. It ends a live session on every `/reload`.

**Alternative rejected: end only on `quit`.** It is the safest possible gate and it does not fix the defect: `/new`, `/resume` and `/fork` are precisely the transitions that leave two `active` rows behind.

### D2 — One atomic `POST /end {summary, title, final:false}`, not `/summary` then `/end`

The end POST carries the body the per-turn flush would have sent, sourced from the same `buildSummaryBody` (`rembric-plugin-core.mjs:208`). That builder returns `null` on an empty transcript, so the empty case is handled explicitly with `{}` — a session with no turns still ends.

Three reasons, in order of weight:

1. **Exit latency is the real regression risk, not a dropped summary.** Pi awaits the handler in every mode with no timeout, so nothing is lost by awaiting; what the user feels is the wait. Every core POST is bounded by `AbortSignal.timeout(POST_TIMEOUT_MS)`, `POST_TIMEOUT_MS = 3000` (`:8`). Two sequential POSTs against an unreachable server take ~6 s and break the existing assertion at `apps/plugin/.pi-plugin/plugin.test.ts:719-723` (`elapsed < POST_TIMEOUT_MS * 2`, which also covers the concurrent MCP `DELETE`). One POST keeps the budget as measured.
2. **It removes the ordering question.** With two calls one must decide whether a failed `/summary` should still be followed by `/end`, and whether a failed `/end` after a successful `/summary` leaves a coherent row. With one call the row is either updated-and-ended or untouched.
3. **It is the shape with production mileage.** `apps/plugin/scripts/session-end.sh:52-64` has been posting exactly this endpoint, in three body shapes of one contract, for as long as Claude Code has shipped.

**Alternative rejected: `/summary` then `/end`.** Costs the budget above and buys nothing: `/end` already accepts `{summary, title, final}`.

**Alternative rejected: `/end` with no body.** It would leave the final turn out of the summary whenever the debounce timer had not yet fired, which is exactly the window the awaited flush exists to close.

### D3 — Suppress the end when `targetSessionFile` names the file the session manager currently holds

`targetSessionFile` is documented as "Destination session file when shutting down due to session replacement". Resuming the session already open emits `reason: "resume"` and comes back with the **same** id: `dist/core/session-manager.js:632`, `this.sessionId = header?.id ?? createSessionId()`, reads the id out of the resumed file's header. So the reason alone does not distinguish "replaced by another session" from "replaced by itself", and the second is the `reload` hazard wearing a different reason. `getSessionFile` is available on the readonly context — `ReadonlySessionManager` is a `Pick<SessionManager, … | "getSessionFile" | …>` (`dist/core/session-manager.d.ts:140`) returning `string | undefined`.

The comparison **only runs when `targetSessionFile` is a non-empty string**. A bare `event.targetSessionFile !== ctx.sessionManager.getSessionFile()` reads as the obvious guard and has a hole: on `quit` the field is absent, so if `getSessionFile()` also returns `undefined` the guard evaluates `undefined !== undefined` → `false` and suppresses the end on the single most important reason. Guarding on the string presence makes the absent-field case fall through to "end", which is what `quit` needs.

`getSessionFile` is declared optional on the extension's locally-typed context (`.pi-plugin/index.ts:36`), because the extension is installed into whatever harness version the operator has — the file already carries that reasoning for `ui`. A harness with no `getSessionFile` therefore ends on all four reasons, self-resume included; that is the same recoverable-vs-unrecoverable trade as D1, in the direction of the observable failure.

### D4 — An unrecognised or absent `reason` does not end

Typed `reason?: string` in the extension's local event declaration, checked against the end-set at runtime. Declaring the harness's five-member union instead would let TypeScript treat the fallback branch as unreachable and invite its removal, which is precisely the branch that protects a future sixth reason.

This has a convenient side effect on the existing suite: it fires `session_shutdown` with `{}`, so every current assertion keeps its current meaning and the new arms are the ones that name a reason. It is a side effect, not the reason for the decision.

### D5 — The regression on resume is accepted, and reactivation is rejected

Ending at `quit` means a later resume of that id lands on a terminal row: auto-attach is off and a `memory.save` without an explicit `sessionId` writes `session_id = NULL`. Today, a resume within 24 h works because the row is still `active`.

Accepted, for two reasons. First, it is not a new class of problem: Claude Code has ended on `SessionEnd` since it shipped and lives with exactly this, through the same server code path. Second, the two failures are not symmetric — the `/new` attribution loss is silent, immediate and invisible to the user, whereas the resume case is visible in `/dashboard/sessions` (the row reads `ended`) and recoverable by passing `sessionId` explicitly, which terminal rows accept for the remainder of their life (`openspec/specs/sessions/spec.md`, "Terminal session rows MUST accept late summary and title writes").

**Alternative rejected: let `ensure` reactivate an ended row.** It crosses the terminal FSM contract that two invariant tests bound, and it would resurrect a row whose curated summary is already protected by first-final-wins — the resumed session's own `memory.session_summary` would then be dropped instead. Needs its own change if ever wanted.

### D6 — opencode keeps today's behaviour; the verb still lives in the core

The `/end` verb goes into `rembric-plugin-core.mjs` because `plugin-session-protocol`'s single-implementation requirement puts the session HTTP client in exactly one JS/TS module. Only Pi calls it.

opencode does not, and this is not symmetry neglect. Its dispose flush is fire-and-forget by measurement — the host kills the subprocess before async handlers settle, recorded in the core itself at `:237` — so an `/end` issued there would frequently not land, and no requirement could promise `ended` without overclaiming. The no-end decision was taken twice, and the durable reason is resumability (`openspec/changes/archive/2026-05-19-add-opencode-session-summary-on-dispose/design.md:92`). What this change does add for opencode is its **row in the lifecycle matrix**, describing today's behaviour, so the absence is documented rather than inferred.

### D7 — `reload` and self-resume keep the current `/summary` flush

They do not end, but they must still flush: the extension runtime is torn down and the in-memory transcript accumulator does not survive it. So the handler branches into `endSession(...)` or `flushSessionSummary(...)`, never neither. `mcp.close()` and `forgetSession(...)` run on both branches exactly as today.

### D8 — Coverage is stated by what it does not cover

SIGKILL runs no handler. A single-press Ctrl-C reaches none (as the shipped spec records, and this change does not revisit). Print mode registers only `SIGTERM`, with `SIGHUP` wired separately. Every one of those leaves the row `active` until `abandonStale`. The spec text says this explicitly rather than implying that ending on shutdown makes Pi rows reliably terminal, because a requirement that overclaims is worse than a missing one.

## Risks / Trade-offs

- **[Risk] The fake harness cannot prove the harness actually delivers `reason`.** The whole gate is a function of a field the test suite supplies itself. → Mitigation: a mandatory real-`pi` validation task (the CLI is installed in this environment) issuing `/new` then `/quit` and asserting two distinct rows with the expected statuses against a **local** stack. Without that arm the unit tests only prove the branch, not the input.
- **[Risk] A guard nobody can red is a guard nobody has.** → Mitigation: `scripts/mutate.mjs` on both halves — widening the reason set to always-true must red the `reload` test; removing the `targetSessionFile` comparison must red the self-resume test. A test green on both sides of the change is this repo's default outcome, not the exception.
- **[Trade-off] Empty Pi rows become purge-eligible at ~1 h instead of ~25 h.** `purgeEmpty` runs inside the consolidation sweep, and its predicate needs `ended_at < now − SESSION_PURGE_GRACE_MS` (1 h). Today a content-free Pi row has no `ended_at` until `abandonStale` writes one at 24 h. → Accepted because the predicate also requires no summary, no `title_final` and no referencing memory, prompt or confirmation: only rows with nothing in them qualify, and the whole point of the purge is to reclaim them.
- **[Trade-off] A resumed Pi session no longer auto-attaches within 24 h.** → Accepted per D5: the failure it replaces is silent, this one is visible and has a workaround the server already supports.
- **[Risk] Exit latency against an unreachable server.** The end POST is awaited in the teardown handler, so a user quitting with the server down waits on it. → Mitigation: one POST rather than two (D2), the existing `POST_TIMEOUT_MS` bound, and a re-measured end-to-end quit wall-clock quoted as its own figure — not the isolated POST's timing, which is a different instrument.
- **[Risk] `forgetSession` after an end that did not happen.** The handler's existing comment notes the call is only safe on a teardown the process survives, because a pending debounce would otherwise re-POST. → Mitigation: the branch structure keeps `forgetSession` where it is, after whichever POST ran; neither branch leaves a live timer.

## Migration Plan

No server deployment step, no migration, no derived-data invalidation (`memory_fts`, `memory_vec` and the three entity tables are untouched). The change ships in a `plugin` release; Pi users pick it up with `pi install npm:@rembric/pi` (unpinned, per `pi-plugin`'s no-version-pin requirement).

First run after upgrade: nothing happens until a shutdown. Sessions already `active` from the previous version behave as before until their next `session_shutdown`, at which point they end if the reason qualifies.

Rollback: reverting `@rembric/pi` restores today's behaviour immediately. Rows already `ended` stay `ended` — the FSM working as specified, not damage; those sessions keep accepting late summary and title writes, and a user who resumes one can still attribute memories by passing `sessionId`.

## Open Questions

- **Does `pi` deliver `reason` on the interactive `/quit` path specifically, or only on the programmatic shutdown?** Every emit site in 0.84.1 supplies it unconditionally, so the default is yes and the tasks proceed on that default; the real-`pi` validation arm is what confirms it rather than a source reading. If it turns out absent on some path, D4 makes the failure "did not end", not "ended the wrong session".
- **Can `reload` be triggered from the CLI at all?** If it can, the real-`pi` run should carry a `reload` arm asserting the row stays `active`. If it cannot be reached from outside, the unit-test arm plus its mutation check is the whole evidence, and the task says so rather than leaving an unrun arm ticked.
