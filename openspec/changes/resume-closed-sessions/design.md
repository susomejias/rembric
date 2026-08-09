# Design — resume closed sessions

## Context

`sessions` has been a one-way FSM since it was written: `active → ended | abandoned`, both terminal. Two prior changes have already pushed against that boundary from the outside without moving it.

`2026-07-26-allow-late-summary-on-terminal-sessions` admitted summary/title writes on a terminal row, and its **D3** rejected revival explicitly. `2026-08-09-close-the-end-soft-delete-window` tightened the same write path further. Both treated "the row is closed but the conversation is not" as a _write-permission_ problem. It is not — it is an _identity_ problem, and the three consequences the late-write change could not reach (null `session_id` on every later save, a duplicate row from `memory.session_start`, and purge eligibility) are all downstream of `status` rather than of who may write `summary`.

This change moves the boundary itself, once, minimally: one new transition, reached only by an explicit call naming the row.

## Goals / Non-Goals

**Goals**

- A terminal session can be returned to `active` by an explicit, authenticated, id-targeted operation, over MCP and over HTTP.
- A host conversation reopened after the process that ran it died re-attaches its memories without the operator or the model doing anything, on all five clients, by the same rule.
- The resumed row is the unambiguous auto-attach target for the calling transport, without relying on the ambiguous-resolution fallback.
- The resumed row survives the retirement sweep it would otherwise be eligible for on the next pass.
- Every published requirement that this contradicts is amended in the same change.

**Non-Goals**

- Per-execution epochs, fencing tokens, or any new value travelling to a client (D6).
- An append-only execution/transition audit table (D7).
- A dashboard operator action for resume (D11).
- Consuming any host-supplied resume signal in any client (D10, D16).
- Any change to search ranking, `memory.context` ordering, or scope resolution.
- Raising Claude Code's `SessionEnd` hook timeout (open question 3).

Three pre-existing defects are in scope because this change's own argument depends on them being true or false: Codex CLI's `SessionEnd` (D14), Claude Code's `fork` source (D15), and three false published statements about Hermes (D16).

## Decisions

### D1 — A fourth MCP tool, `memory.session_resume`, with a REQUIRED `sessionId`

The operation is a new tool, not an argument on `memory.session_start` and not a behaviour of `ensure()`. The issue is right about why: both are per-turn idempotent paths (`ensure` is POSTed on every `SessionStart`/`chat.message`/`before_agent_start`), so neither can distinguish a real resume from a hook re-fire, and giving either the power to revive would make every retry a potential revival.

`sessionId` is REQUIRED, with no fallback resolution. This is not a convenience omission — it is forced by the no-guessing rule. There is no "current" terminal session on a transport to fall back to: `memory.session_end` cleared the `SessionRouter` binding on its way out (`session-tools.ts:235`), and `findActiveForTransport` filters `status = 'active'` (`agent-sessions-repository.ts:157`), so any fallback would have to pick a terminal row by recency — exactly the heuristic `findActiveForTransport` refuses on purpose (`sessions/spec.md:832`). The caller always has the id: `POST /api/<slug>/sessions` returns `sessionId` in its response body (`http-api/spec.md:42`), and for every client whose host id is stable, the host id _is_ the Rembric id.

Alternatives considered:

- **`memory.session_start({ resume: true })`.** Rejected: it makes a boolean the difference between adopting and reviving on a tool that agents already call defensively, and `memory.session_start`'s reuse branch has no id to revive — it looks for an _active_ row.
- **Resolve the target by "most recent terminal row for `(token, project)`".** Rejected on the no-guessing rule above. The failure mode is silent and expensive: reviving the wrong conversation attaches every subsequent memory to it.
- **A verb on the HTTP API _instead of_ the tool.** Rejected: the HTTP route cannot pin the `SessionRouter` binding (D4, D13), so it would ship the weaker half. Both exist — the tool for an agent that wants the unambiguous binding, the route for the plugin clients that have no MCP session of their own — and both reach the same service verb.

Contract: `{ sessionId }` in, `{ ok: true, sessionId, status: 'active', startedAt, resumedAt, previousStatus, previousEndedAt, title }` out. Errors: `session_not_found` (absent row, cross-token, cross-project — never `forbidden`, per the established masking rule), `session_deleted`, `invalid_input`. An already-`active` row is a success no-op that still re-pins the binding, so a defensive call never fails.

### D2 — `ended_at` is cleared to NULL on resume — **CLOSED, this is one of the two the change had to settle**

**Decision: clear it.** `ended_at` means "when this row's current terminal state began". A row that is not in a terminal state has no such instant, so on an `active` row the column is NULL. The biconditional `ended_at IS NOT NULL ⟺ status ≠ 'active'` is preserved, and every read surface stays internally consistent.

The alternative — preserve it, and accept an `Ended` timestamp on an `active` row — was rejected because **it does not actually preserve anything**. Three write sites put a fresh `ended_at` on the row at its _next_ close, and all three match on `status = 'active'`, which a resumed row now is:

- `end()`'s active branch: `endedAt: ts` (`agent-sessions.ts:374`)
- `markAbandoned`: `{ status: 'abandoned', endedAt: this.now() }` (`:554`)
- `abandonInactiveSince`: `.set({ status: 'abandoned', endedAt })` (`agent-sessions-repository.ts:219`)

So the preserved value survives only until the resumed conversation ends, and is then overwritten regardless. Preserving buys nothing durable and costs a contradiction on every surface in the interim, all of which render `endedAt` unconditionally: the dashboard list (`dashboard/sessions.ts:110`), the dashboard detail (`:380`), `memory.context` (`memory-tools.ts:1306`), `memory.session_get` (`session-tools.ts:335`) and the `/end` response (`api-router.ts:211`). Clearing costs one honest spec amendment; preserving costs five lying surfaces and loses the value anyway.

What is genuinely given up: the instant of the _first_ close is not retained anywhere. That is accepted, and it is the same thing criterion 8 would have bought (D7). It is mitigated only at the moment of the call — the resume response returns `previousEndedAt` and `previousStatus`, so a client or a smoke test can observe what was discarded.

**Consequence for the spec:** `sessions/spec.md:11` says `ended_at` is written "at most once". That clause is amended to write-once-per-terminal-transition and cleared-on-resume. This is the one **BREAKING** contract change in this proposal, and it is unavoidable under either option — the preserve branch would break it too, one close later and silently.

### D3 — Resume behaves identically on `ended` and `abandoned`; the death classification resets — **CLOSED, the second of the two**

**Decision: one predicate, `status IN ('ended','abandoned')`.** No branch, no different outcome, no different error.

Restricting resume to `ended` was the tempting narrow option, and it fails on the population. `abandoned` is the documented steady state for Codex CLI and opencode, neither of which ever posts `/end` (`plugin-session-protocol/spec.md:271`), and the stale-active sweep flips any client's live row at the 24h window. A resume that refuses `abandoned` would refuse the majority of the rows that need it, and would swap one indefensible asymmetry for another — the exact reasoning that settled D1 of `2026-07-26-allow-late-summary-on-terminal-sessions` ("the rule is stated over `status IN ('ended','abandoned')` — a single predicate, one requirement, one test matrix, one spec sentence").

**On the death classification.** `markAbandoned` refuses `ended → abandoned` today (`agent-sessions.ts:548`, `session_already_ended`), on the ground that the sweep's classification is the audit record of how the session died. Resume does not weaken that guard, and the guard is not bypassed: `markAbandoned` still evaluates it against whatever the row's status is when it is called.

What resume does is make the question different. `ended → active → abandoned` is reachable in two explicit calls, and the resulting `abandoned` is **not a laundered reclassification of the first death** — it is a correct classification of the _second_ one. Resume interposes a real live span: the row was `active`, `last_activity_at` advanced, memories may have attached to it, and then the sweep found it stale. Recording that as `abandoned` is true. The only thing lost is the earlier `ended_at`, which D2 has already accepted.

The prohibition that remains, unchanged and unweakened: no single call reclassifies a death. `markAbandoned` on an `ended` row still throws; `end()` on an `abandoned` row still refuses to write `status` or `ended_at`.

**Consequence:** `previousStatus` in the resume response is what preserves the distinction at the call site for anyone who needs it, since nothing persists it.

### D4 — Resume pins the `SessionRouter` binding, and that is why it lives on the MCP transport

After reviving the row, the handler calls `deps.router.setActiveSession(key.tokenId, key.mcpSessionId, session.id)` — the same call `handleSessionStart` makes at `session-tools.ts:189`, which is the only site in the codebase that writes that binding (`clearSession` at `:235` is the only site that removes it).

This is load-bearing, not decorative. `resolveSessionId` consults the router entry _before_ `findActiveForTransport` (`_shared.ts:320-333`), so a pinned transport never reaches the ambiguous-resolution fallback at all. That is what makes attribution unambiguous even when the operator genuinely has two live conversations in one project.

It also settles the objection that killed revival in the archived D3 — see D8.

### D5 — `last_activity_at` is stamped; `started_at` is not

Resume writes `lastActivityAt = now` in the same `UPDATE` as `status` and `endedAt`. Without it the row is immediately stale: `abandonInactiveSince` compares `COALESCE(last_activity_at, started_at)` against the cutoff (`agent-sessions-repository.ts:73`, `:216-228`), and a session resumed hours after it closed is already past the 24h window, so the very next sweep pass — at most 30 minutes later — would retire it again.

`started_at` is _not_ re-stamped, even though doing so would fix the `memory.context` ordering complaint (open question 2). It is immutable by contract (`sessions/spec.md:11`) and grep-enforced (`invariants.test.ts:105-114`), and "resumed at 14:00" is not "started at 14:00" — rewriting it would make the row lie about a fact nothing else records.

### D6 — Rejected: per-execution epochs and a fencing token (issue point 2)

The issue asks for an epoch column and a fencing value carried by the client, so a delayed `/end` from the previous execution cannot close a newly resumed one. Rejected on two independent grounds.

**The window it guards is 3 seconds.** Both shared client implementations cap the POST: `--max-time 3` (`apps/plugin/scripts/_api.sh:79`) and `POST_TIMEOUT_MS = 3000` (`apps/plugin/bin/rembric-plugin-core.mjs:8`). Pi and Hermes additionally _await_ the close before the process dies, so for them the ordering is guaranteed, not probabilistic. A resume happens when a human restarts a conversation; it is not within three seconds of the previous process's death.

**The structural cost has already been measured, and paid, and reverted.** `openspec/changes/archive/2026-07-12-fix-cross-session-misattribution/design.md` Decision 2 records a mechanism of exactly this shape — a new `sessions` column, a new HTTP header, a per-connection local file, and edits to every client codebase — that "worked and was tested end-to-end (server + all four clients), but was reverted after reconsidering the cost/benefit". Fencing is the same shape for a rarer hazard. Proposing it again without new evidence would be re-litigating a decision the repo already bought and returned.

**What we do instead:** nothing, deliberately. A `/end` that lands on a resumed row after the resume closes it, correctly, and the agent's next turn can resume again. That is a self-correcting three-second race, not a corruption.

### D7 — Rejected/deferred: an append-only execution audit (issue point 3, criterion 8)

No `session_executions` table, no transition journal, no new column. Deferred rather than declined, but with the reason stated: it has no concrete consumer today. Nothing in the dashboard, MCP surface or HTTP API asks "how many times was this session resumed", and the cost is a new table (SQLite table-rebuild rules do not apply to a _new_ table, but the FK to `sessions` does), a new repository file, and an entry in the repository-classification set-equality invariant (`invariants.test.ts:747-758`) plus the unscoped-read inventory (`:760-767`).

`consolidation_ops` was considered as a home for the journal instead of a new table, and rejected: it is scoped to memory consolidation and its op-type union is exhaustively classified as undoable/terminal/orphan-promotion/inert (`consolidation/spec.md:287-291`), so a session-lifecycle op would have to be classified into a taxonomy it does not belong to.

The partial substitute is D2's `previousStatus` / `previousEndedAt` in the response — observable at the call, not persisted. When a consumer appears, it will need its own change and its own evidence.

### D8 — This nominally amends D3 of `2026-07-26-allow-late-summary-on-terminal-sessions`

That decision rejected revival, and its reasoning must be answered rather than ignored. Verbatim:

> Reviving `abandoned → active` was considered and rejected concretely, not on principle: it produces two `active` rows for one `(token_id, project_id)`, `findActiveForTransport` then returns `undefined` by its own deliberate no-guessing rule (`sessions/spec.md:732`), and session auto-attach silently stops for _every_ subsequent write on that transport.

The mechanism is real. The attribution of it to _resume_ is not, on two counts.

**First, resume adds no incremental risk.** Two `active` rows for one `(token_id, project_id)` is the consequence of working in two places in the same project at once, and opening a fresh session while another is live produces the identical collision today — which is precisely what happens now, because `memory.session_start` mints a duplicate row when it cannot adopt (`session-tools.ts:159-180`). The current behaviour _already_ creates the second active row; resume replaces the duplicate with the original rather than adding one. Resume is the strictly-fewer-rows option.

**Second, D4 removes the failure path entirely for the resuming connection.** `resolveSessionId` reads the router entry before it ever calls `findActiveForTransport` (`_shared.ts:320-333`), so a transport that just resumed is bound by id and never consults the ambiguous fallback. The "auto-attach silently stops" outcome requires a transport with no router entry; the resuming one has just been given one.

D3's other two clauses stand and are honoured: `end()` on an `abandoned` row still does not become `ended`, and a _late write_ still never touches `status` or `ended_at`. What is overturned is only the narrow claim that revival is unreachable safely.

For the record, D3 cited `sessions/spec.md:732` for the no-guessing rule; that requirement is now at `sessions/spec.md:832`. The text is unchanged.

### D9 — `ensure()` and `memory.session_start` are unchanged, and the spec says so explicitly

`ensure()` keeps returning a terminal row untouched apart from the activity touch (`agent-sessions.ts:205-217`), and `memory.session_start` keeps adopting only `active` rows. Neither gains a resume path.

This is a _silence being made explicit_, because the silence is now dangerous: `http-api/spec.md:38` says an existing `(token_id, id)` returns "the existing row unchanged", which a reader could take as licence to make it smarter now that reviving is legal. One sentence is added stating that the ensure path SHALL NOT resume and that resume is reachable only by the explicit tool.

Note the one behaviour that changes for free and is _wanted_: once a row is `active` again, `memory.session_start` adopts it through the ordinary `findActiveForTransport` branch and reports `reused: true`. No code change; the adoption path already does the right thing on an active row.

### D10 — One uniform client rule: resume once per session id per process, after the first ensure, unconditionally

**Decision: every one of the five clients POSTs `/api/<slug>/sessions/<id>/resume` exactly once per session id per process, immediately after the FIRST `/sessions` ensure for that id, with no condition on any host signal.**

The measured client matrix is what forces the uniform form rather than a per-client one. Every column below was verified rather than argued:

| Client      | Cold-start resume signal                                                                                                                                                                                                                                                                                                         | Id stable across a host resume?                                                                                                                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `source: "resume"` on `SessionStart` — but the hook re-fires for `--resume`/`--continue`/`/resume`, which are in-process-or-not indistinguishably; the signal exists and is not the problem                                                                                                                                      | **Yes**, measured: `claude -p --output-format json`, note the id, then `--resume <id>` → same id. Corroborated by contrast — `--fork-session` is documented as "create a new session ID instead of reusing the original"                                  |
| Codex CLI   | `source: "resume"` on `SessionStart`                                                                                                                                                                                                                                                                                             | **Yes** for the thread id, measured: `codex exec --json` → `codex exec resume <id>` → same `thread_id`, and `~/.codex/sessions/**/rollout-*-<id>.jsonl` carries it in the filename. Whether the hooks' `session_id` is that same value is open question 4 |
| Hermes      | `reason="resume"` with `reset=False` on `on_session_switch` — but that fires only for an in-process switch, never for a cold start                                                                                                                                                                                               | Rotates on `/resume` and `/branch`; unchanged on in-place compression, `/undo` and the gateway rewind (D16)                                                                                                                                               |
| opencode    | **None.** `session.created` fires exactly once in the life of an id (the host's `create` is idempotent and returns before the `publish`); reopening a persisted session keeps the id and emits nothing                                                                                                                           | **Yes** — the id is the persisted session's                                                                                                                                                                                                               |
| Pi          | **None.** `pi -r`, `pi -c` and `pi --session <f>` all deliver `reason: "startup"` (`dist/main.js:675-679` does not pass `sessionStartEvent`; `dist/core/agent-session.js:152` substitutes `startup`). `getEntries()` is not a discriminator either: a header-only persisted file yields zero entries, exactly like a new session | **Yes** — `dist/core/session-manager.js:632` reads the id from the file header                                                                                                                                                                            |

Three properties make the unconditional rule correct rather than lazy:

1. **Resume on an `active` row is a documented no-op** (D1's already-active branch), so the client never needs to know which case it is in. The cost of an unnecessary call is one local request per session start.
2. **No client has a cold-start signal**, and a cold start is the case the issue is about. Claude Code, Codex and Hermes each expose a resume signal, but all three fire for a session change **inside a living process** — where the client's own in-memory state already keeps attribution correct and there is nothing to repair. Building the emitter on those signals would have produced three implementations, two clients with none, and would still have missed every cold start.
3. **The ordering is ensure-then-resume, and it is load-bearing.** `purgeEmpty` may physically remove a terminal row with no memories once its grace elapses; the ensure recreates it `active` and the resume then no-ops against the row the ensure just made. One order handles the purge case for free; the other reports `session_not_found` for a conversation about to be perfectly healthy.

The once-per-id gate is not new machinery. `ensureSession` in `apps/plugin/bin/rembric-plugin-core.mjs` already early-returns on a known id, so putting the resume on its newly-known branch makes "exactly once per id per process" structural for opencode and Pi with no client-side edit at all. For the two bash clients a hook invocation _is_ the process, and the only two scripts that ensure — `session-start.sh` and `post-compact.sh` — each fire once per host event, so "first ensure in this process" is trivially every ensure. Hermes gets a process-scoped set of its own, because Python keeps its own implementations by the existing cross-language rule.

Alternatives rejected:

- **Gate on the host signal where one exists.** Rejected: it covers only in-process switches, which are already correct, and produces a different rule per client. That is the asymmetry this repo has repeatedly paid for.
- **Have `ensure` revive implicitly.** Rejected — it is the AgentMemory anti-pattern the issue itself rejects, and the published scenario "an ensure against a terminal row does not resume it" stands unchanged.
- **A `attach: true` field on the ensure body instead of a route.** Rejected on a measured property of the schema, not on taste — see D13.

**A defect this closes as a side effect.** `apps/plugin/scripts/post-compact.sh:22-24` carries the comment "This covers the edge case where the row was abandoned by the stale sweep between the pre-compact moment and the post-compact resume — re-create silently", and the ensure path returns a terminal row untouched. Both clients that wire that hook have been running a recovery that could not work. The resume is what makes the comment true.

### D13 — The HTTP route, and why it is a route rather than a field

`POST /api/<slug>/sessions/:id/resume` is added here rather than deferred, because D10 gives it callers: the five plugin clients speak HTTP for session lifecycle and have no MCP session of their own.

**Why not a field on `POST /api/<slug>/sessions`.** `sessionPostSchema` is a plain non-strict `z.object(...)` (`apps/server/src/server/api-router.ts:60-65`), so zod discards properties it does not declare. An `{ id, attach: true }` body sent to a server that predates the field — the normal state of affairs, since the plugin and the server are independent release tracks — would be accepted with `200`, `created: false`, and a response byte-identical to the correct case. The client cannot tell success from silent no-op, on exactly the path where it is trying to repair attribution. A `404` from a route it does not have is loud, and every client already funnels that into the one stderr diagnostic `plugin-session-protocol` requires. This is why the new route's own body schema is **strict**: an unknown property there is a `400`, not a shrug.

**What the route cannot do, stated rather than hidden.** It does not pin the `SessionRouter` binding, because the binding is keyed on `(tokenId, mcpSessionId)` and an HTTP request has no `mcpSessionId`. D4's pin stays exclusive to `memory.session_resume`. The consequence is real and bounded: a session resumed over HTTP is reachable by auto-attach only through the sole-active-session lookup, which declines when a second session is live for the same `(token, project)`. That is strictly better than today, where the row is terminal and the lookup finds nothing at all; and an agent that needs the unambiguous binding calls the tool, which is a normal thing for it to do.

### D14 — Codex CLI has `SessionEnd`, the repo says otherwise in ~10 places, and the event's budget is 1–3 seconds

**Decision: correct the claim and wire the event.**

The claim is false at HEAD. `learn.chatgpt.com/docs/hooks`, which is where `developers.openai.com/codex/hooks` — the URL `codex-distribution/spec.md:65` cites as its verification — now redirects: `SessionEnd` "runs for the main thread when you archive or delete a conversation that's still open, when Codex closes normally, or after a conversation has been idle and isn't open in any connected client for 30 minutes. It won't run for subagents." Its stdin carries `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `reason`; `matcher` filters `reason`, whose only current value is `other`.

It belongs in _this_ change rather than a follow-up because `abandoned` being Codex's steady state is half the population resume exists to serve, and the proposal's own "Why" leans on that fact. Correcting the resume story while leaving the cause in place would ship a spec that argues from a premise the same change knows is false.

**The budget is the non-obvious part and it is not optional.** Verbatim: "If `timeout` is omitted, Codex uses 600 seconds for most hooks. `SessionEnd` uses `1` second by default and supports up to `3` seconds." `apps/plugin/scripts/_api.sh:79` allows a POST `--max-time 3`. So an entry with no declared timeout is killed at one second, before the request can finish; and an entry declaring the maximum `"timeout": 3` still lets a single slow request eat the whole budget, leaving nothing for the transcript read or the failure diagnostic. Both halves are therefore required: `"timeout": 3` on the entry, and `REMBRIC_POST_MAX_TIME=2` on that one command, against a helper default of 3 that nothing else restates.

**What is honestly not promised.** If the handler is killed before its POST lands, nothing is written and the row stays `active` until `abandonStale` retires it. That is the pre-existing behaviour, unchanged, and the spec says so instead of promising a transition it cannot guarantee inside three seconds.

**The tests that encode the falsehood are named, not left to be discovered.** `apps/plugin/test/hook-manifests.test.ts` asserts it four times — the five-event set (`:87-91`), the eight-handler count (`:93-95`), `expect(codexHooks.SessionEnd).toBeUndefined()` (`:97-100`), and the ordered invocation list (`:196-207`). The `codex-distribution` delta states what replaces each, and each replacement stays an exact set or exact count: a `toContain` cannot catch a manifest claiming an event is absent, which is the whole defect class.

**One script, not two.** `session-end.sh` gains an optional agent-name argument selecting the transcript parser, exactly as `pre-compact.sh <agent>` already does. Both manifests pass it explicitly, so `hooks.json`'s bare invocation becomes `session-end.sh claude-code` — a bare call on one client and an argument on the other is the shape that lets the two drift.

### D15 — Claude Code's fifth `SessionStart` source, `fork`, is unhandled and belongs in the registration group

**Decision: the matcher becomes `startup|resume|clear|fork`.**

`code.claude.com/docs/en/hooks` lists five matchers: `startup`, `resume`, `clear`, `compact`, `fork` — the last for "a new session forked from an existing one: `--fork-session` with `--resume` or `--continue`, the `/fork` background copy, or `/branch`", with "Before v2.1.214, forked sessions reported source `\"resume\"`". `apps/plugin/hooks/hooks.json:5` declares `startup|resume|clear` and `:14` declares `compact`, so a `fork` matches neither group and **no hook of this plugin fires at all**: no row is registered, no first-prompt nudge is emitted, and every `memory.save` for the life of that conversation persists `session_id = NULL`. The version note explains why nobody noticed — before v2.1.214 the same action arrived as `resume` and was matched.

`fork` goes in the registration group, not a group of its own, because a forked session is a **new** session: `--fork-session` is documented as "When resuming, create a new session ID instead of reusing the original". So the correct response is exactly what `startup` gets — register the new id — and the resume that follows no-ops against the row just created. A fork must not revive the session it forked from; the spec says so explicitly, because "fork" reads like a resume and the wrong reading is one line of code away.

Codex has no `fork` source (its documented values are `startup`, `resume`, `clear`, `compact`), so `hooks.codex.json` keeps `startup|resume|clear`. The asymmetry between the two manifests is the hosts', and the spec records it so a future reader does not "fix" it.

### D16 — Hermes: correct the three false statements, consume neither `reason` nor `rewound`

Verified against `hermes_agent` 0.19.0 (PyPI wheel), not inferred.

**(1) The id does not always rotate.** `hermes-agent-plugin/spec.md:377` is titled "…to rotate session ids cleanly" and `:391`'s scenario generalises from a rotating case. Three of the seven `on_session_switch` call sites pass the id the provider already holds: in-place context compression (`agent/conversation_compression.py:1403`, whose own comment says "in-place uses the same id as parent"), `/undo` (`cli.py:7517`, `rewound=True`), and the gateway rewind (`tui_gateway/server.py:13396`, identical). The ABC documents `rewound` as "`True` if session_id is unchanged but the transcript was truncated". The requirement is RENAMED to "…to track the agent's current session id" and its body states the measurement.

**(2) `parent_session_id` is not empty on `/reset` and `/new`.** `apps/plugin/.hermes-plugin/__init__.py:606-608` asserts they use `parent_session_id=""` "by upstream contract". `cli.py:7292` passes `parent_session_id=old_session_id or ""`, and `memory_manager.py:905` forwards the same on the with-history path — populated on exactly the case the comment calls empty. The real clean-restart discriminator is `reset=True`, which only those two sites pass. Note that the _behaviour_ is already correct: the code keys off `old_id != new_session_id`, which is the right discriminator and is what makes the same-id calls in (1) no-ops. Only the justification was wrong, and the published spec's steps 2 and 5 describe a `parent_session_id`-keyed algorithm the code does not implement. Both are corrected to the algorithm that actually runs.

**(3) The host passes a `reason` kwarg that the provider discards.** Five of the seven call sites send `reason` — `"new_session"` (twice: inline and via `commit_session_boundary_async`), `"resume"`, `"branch"`, `"compression"` — and the two `rewound=True` sites send none. `__init__.py:611`'s `del kwargs` destroys it.

**Decision on (3): do not consume it, and correct only the false statements.** Three reasons, in order of weight. It is not in the `MemoryProvider` ABC signature (`agent/memory_provider.py:176-184` declares `new_session_id, *, parent_session_id, reset, rewound, **kwargs`), so reading it couples this provider to a keyword the contract does not promise and only some call sites send. Under D10 the only thing it could buy is skipping a resume that is already a no-op on an `active` row — an optimisation on a no-op. And `reason="resume"` fires exclusively for an in-process switch, never for the cold start the rule exists to cover, so it does not reach the case that matters. `rewound` is discarded for the same reasons. The spec pins this positively with a scenario asserting the provider's HTTP behaviour is identical with any `reason`, with `rewound=True`, and with neither — so a future contributor who "wires up" the kwarg goes red rather than quietly changing behaviour.

### D11 — No dashboard resume action

The dashboard gets no Resume button. Resume exists to restore _attribution for a live agent transport_, and an operator pressing a button in a browser has no transport to bind (D4). A dashboard resume would revive a row that nothing is attached to, which is the useless half of the operation.

Consequently `dashboard/spec.md:876`'s modal copy — "This transition is not reversible from the dashboard" — remains literally true and is left unchanged. The Abandon form reappearing on a revived row is correct: `status === 'active'` is exactly the condition that requirement specifies.

### D12 — No migration, no schema change

`ended_at` is already nullable (`schema/agent-sessions.ts:63`); `status` already admits `'active'`. Nothing is added, widened or constrained, so the SQLite table-rebuild dance is not engaged — which matters here because `sessions` is the FK parent of `memory.session_id`, `prompts.session_id` and `confirmations.session_id`, and a rebuild would hit the `DROP TABLE` FK hazard documented in `CLAUDE.md` (regression-tested at `apps/server/src/db/migrations.test.ts:565-606`).

The schema _docstring_ at `schema/agent-sessions.ts:15-37` describes the FSM and calls `ended_at` "mutable once"; it is updated in the same change, because it is the first thing a reader of the table sees.

## Risks / Trade-offs

- **[Trade-off]** `ended_at` stops being write-once, and the instant of the first close is not retained. **Accepted because** it was never durably retained under the alternative either (D2: the next terminal transition overwrites it on the active branch), and the honest option costs one spec amendment while the dishonest one costs five contradictory read surfaces.
- **[Trade-off]** `ended → active → abandoned` becomes reachable in two explicit calls, which `markAbandoned` refuses in one. **Accepted because** the resulting `abandoned` describes a second, real death rather than reclassifying the first (D3), and the two-call path requires write authorisation on the owning token plus the row's id.
- **[Trade-off]** `memory.stats.sessionsByStatus` stops being monotonic — `ended` and `abandoned` can decrease between two reads. **Accepted because** the counters are point-in-time gauges, not cumulative counters, and no consumer treats them as monotonic (`observability-tools.ts:261`, `bootstrap.ts:565`, `:593` all read them for display).
- **[Risk]** A resumed conversation still sorts by `started_at` in `memory.context`, so a long-running resumed session can rank below a newer, shorter one. **Mitigation**: named as an accepted limitation in the proposal and in a spec scenario, so it is a documented property rather than a surprise. Open question 2 records what changing it would take.
- **[Risk]** The `terminal rows are terminal` runtime test (`apps/server/src/services/agent-sessions.test.ts:923-957`) drives eight mutating verbs and asserts no status/`ended_at` movement. Adding a ninth verb that _is_ allowed to move both is exactly the kind of edit where a weakened assertion passes silently — its own header records that a counting invariant already passed under mutation on this terrain. **Mitigation**: the test is restructured so `resume` is asserted positively in its own block rather than added to the refusal list, and `scripts/mutate.mjs` is run against both the new guard and the surviving eight (tasks 6.4-6.6).
- **[Trade-off]** Every session start on every client now costs one extra local HTTP request, which is a no-op on a fresh row. **Accepted because** the alternative is a per-client signal that covers only the case already working (D10), and because the two hosts with a tight budget are unaffected: the extra request is on `SessionStart`, whose budget is 600 s on Codex and the ordinary command default on Claude Code, not on `SessionEnd`.
- **[Risk]** Wiring Codex's `SessionEnd` changes production behaviour for an entire client: rows that used to reach `abandoned` now reach `ended`, and the handler runs inside a 3-second ceiling it may not always meet. **Mitigation**: the spec promises only what fits — a handler killed by its budget leaves the row `active` and `abandonStale` retires it, exactly as today — and the ceiling is enforced from both sides (`"timeout": 3` plus a 2-second POST budget). The Docker smoke exercises the wired hook against a real server rather than asserting the manifest alone.
- **[Risk]** A new plugin talking to an older server gets `404` on every resume. **Mitigation**: this is the failure mode the route was chosen _for_ (D13) — it is loud, it is already funnelled into the required stderr diagnostic, and the ensure that preceded it landed normally, so the client's behaviour degrades exactly to today's. A body field on the ensure would have failed silently instead. Covered by a spec scenario and a task.
- **[Risk]** A `/end` from a dying previous execution can land within ~3s of a resume and re-close the row (D6). **Mitigation**: none by design, and stated as such — the agent's next turn can resume again, and the alternative was measured as not worth its cost. The 3s bound is what makes "none" defensible; if a client ever raises its POST timeout materially, this decision needs revisiting.

## Open Questions

1. ~~**Does Claude Code's `session_id` survive `--resume`?**~~ **CLOSED, measured.** `claude -p --output-format json` reports a session id; `claude --resume <id>` on the same conversation reports the same id. The documentation corroborates by contrast: `--fork-session` is "When resuming, create a new session ID instead of reusing the original", a flag that would be meaningless if a plain `--resume` already minted one. Claude Code is therefore a valid resume target and D10 applies to it unchanged.
2. **Should `recentForContext` order by `COALESCE(last_activity_at, started_at)` instead of `started_at`?** This is a genuine judgement call, not a defaulted one: `started_at DESC` answers "which conversations began most recently", and activity ordering answers "which are most alive". Resume makes the two diverge for the first time by a large margin, and D10 makes the divergence routine rather than rare, since every reopened conversation on every client now takes the resume path. Changing it touches every `memory.context` consumer's ranking and needs measurement against a real corpus, plus `pnpm run eval`. **Default taken in this change:** leave `started_at DESC` unchanged and document the consequence (D5, and a spec scenario). Recorded here so a later change starts from the question rather than from the symptom.

3. **Claude Code's `SessionEnd` hooks "share a 1.5-second budget" while `_api.sh` allows the POST 3 seconds.** Verbatim from `code.claude.com/docs/en/hooks`: "`SessionEnd` hooks share a 1.5-second budget; if your settings set a longer per-hook `timeout`, Claude Code raises the budget to match, up to 60 seconds". `apps/plugin/hooks/hooks.json`'s `SessionEnd` entry declares no `timeout`, so the plugin's own POST is permitted to outlive the budget that contains it. Found while verifying the Codex budget (D14), which is the same defect class on the other host. **Deliberately not fixed here**, and not because it is believed harmless — it is a pre-existing condition on a path this change does not otherwise touch, and I have no measurement of how often the handler is actually killed. **The measurement it needs:** run a Claude Code session against a server with an injected delay, and count how often `/end` lands at 0 ms, 500 ms and 2 s of server latency, with and without `"timeout": 5` on the entry. Fixing it is one JSON key; justifying the key is the part that needs the number. **Default until then:** unchanged.

4. **Is Codex's `thread_id` the same value the hooks receive as `session_id`?** Measured so far: `codex exec --json` then `codex exec resume <id>` reports the same `thread_id`, and the rollout file is named `rollout-*-<id>.jsonl`. Strongly indicated but not proven: the hooks documentation's own `SessionEnd` example payload is `{"session_id": "thr_123", …}`, and `thr_` is the thread-id prefix. It is **not** yet measured end to end — nobody has captured the `session_id` a real Codex hook receives before and after `codex exec resume`. It matters because if the two are different identifiers, Codex's ensure registers a new row per resume and its resume POST no-ops forever, which is today's behaviour rather than a regression. **The probe:** register a Codex session through the real hook, capture the id POSTed to `/api/<slug>/sessions`, close Codex, `codex exec resume <id>`, and compare the id the hook posts on the second run. Named in `tasks.md` as a task with a result to record, not as an assumption.
