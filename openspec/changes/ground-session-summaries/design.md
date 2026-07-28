## Context

Three mechanisms are supposed to guarantee a session leaves a usable trace: the agent's own `memory.session_summary` call, the `UserPromptSubmit` nudge that reminds it, and the `Stop`-time raw sync that writes something when neither happened. Measured against the tree, each has a defect that the others hide.

The raw sync's own comment (`_transcript.sh:86`) reads "Redact before tail-truncation: truncating first could cut off the opening", and line 90 keeps the last `RBR_TRANSCRIPT_MAX_CHARS = 19500`. `truncateSummary` (`agent-sessions.ts:52`) then keeps the first `SUMMARY_MAX_CHARS = 10000`. Both are correct in isolation and wrong composed: the persisted artefact is `[-19500, -9500]` of the transcript. On any session long enough to truncate, the ending is gone.

The nudge's placement is a timing problem, not a wording one. `UserPromptSubmit` fires before the model's turn, so the reminder always arrives while there is more work to do. `Stop` is the only event that fires when the work is actually finished, and rembric's `Stop` entry is `async: true`, which the host documents as fire-and-forget — it cannot influence the turn.

The rubric is six strings. `mcp/instructions.ts:26`, `mcp/server.ts:300`, `.hermes-plugin/__init__.py:127` and `:402`, `.opencode-plugin/plugin.ts:71`, `scripts/post-compact.sh:37`. Five agree on five sections; `server.ts:300` names seven. Nothing asserts they match.

Constraints that bound the design: the MCP tool description is capped at `DESCRIPTION_MAX_LENGTH = 1900` against the host's 2048-unit truncation ceiling, so it has ~80 chars of headroom and cannot carry a longer rubric; the consolidation sweep is contractually deterministic (no LLM, no cron); `summary` is returned in full by `memory.session_get`; and `sessions` rows are append-only apart from the documented `status` / `ended_at` / `summary` / `title` exemptions.

## Goals / Non-Goals

**Goals:**

- Stop discarding the end of a session. One truncation, one direction, one constant.
- Make the no-cooperation fallback worth its storage: structured, grounded facts rather than a transcript dump.
- Put the reminder at the only moment it can still change the outcome, without ever trapping the agent.
- Give the rubric one definition, and make divergence a test failure.

**Non-Goals:**

- Raising the summary cap. Argued and rejected in D2.
- Surfacing uncurated summaries in `memory.context`. Only defensible after the fallback is structured; it needs its own measurement of context growth.
- Model-generated summaries on the server. The sweep is deterministic by contract; introducing an LLM there is a separate decision.
- Per-tool-call observation capture. High volume against a single SQLite file and a large privacy surface, for a marginal gain over an end-of-session extraction that reads the same transcript once.

## Decisions

**D1 — Truncation keeps the tail, and the marker moves to the front.**
`truncateSummary` becomes `…[truncated]` + the last `SUMMARY_MAX_CHARS - marker.length` characters. Rationale: a handoff reader needs the conclusions, the final state and the unfinished items, and those are at the end. The marker must lead, because a reader who sees text starting mid-sentence with no marker cannot tell a whole summary from a fragment — and the current trailing marker is itself unreachable on the raw path, since the head-slice already dropped the end the marker was meant to flag.

Alternative considered: _keep both ends, elide the middle_. Rejected for this change: it needs a policy for how to split the budget and produces an artefact with a discontinuity in the middle, which is worse to read than a clean tail and harder to assert. Recorded as a possible refinement if measurement shows the opening matters.

**D2 — The cap stays at `SUMMARY_MAX_CHARS` and is not raised.**
Two independent reasons. First, `memory.session_get` returns `summary` in full; the cap is therefore also a bound on what a single tool call can inject into an agent's context, and SQLite's `TEXT` limit is not a sane bound for that. Second, a field that may grow without limit is not a summary — it converges on being a second copy of the transcript, which is precisely what the raw path already is, so an unbounded cap would make `summary` redundant with itself.

The composed-truncation defect is not evidence that the cap is too small; it is evidence that the payload is the wrong shape. D3 changes the shape. If, after D3, real sessions still truncate, that is a measurement worth acting on and the constant is one line — but raising it first would remove the pressure that makes D3 worth doing.

**D3 — The deterministic fallback carries extracted facts, not a transcript slice.**
The extraction reads the same transcript the current formatter reads, and emits only what is checkable without a model: files written or edited, commands run with their exit status (failures named explicitly), tools invoked, and the final exchange verbatim. Three properties follow. It is grounded — every line traces to a transcript event, so it cannot hallucinate. It is dense — the same 10 000 characters hold far more of a long session's substance than prose does. And it is stable to truncate — dropping the head of a fact list loses individual facts, not the meaning of the whole.

Alternative considered: _keep the transcript slice and simply fix its direction_ (D1 alone). Rejected as insufficient: it makes the artefact less wrong without making it useful, and it leaves the raw path as the dead weight it is today — retained by the purge predicate, never surfaced anywhere.

**D4 — The end-of-turn entry reminds with non-interrupting feedback, throttled by the counter that already exists.**
The existing `stop-sync.sh` entry stays asynchronous — it is a pure side effect and must not delay the turn. A new non-async entry performs one bounded request asking whether a curated summary is owed, and when it is, emits the host's non-interrupting feedback carrying the long rubric plus the extracted facts from D3.

**Not blocking, deliberately.** The host does support a blocking decision, and a loop guard for it exists (`stop_hook_active`, true when the current stop is happening because a previous hook blocked). Blocking was rejected anyway, on the stronger ground: a memory server is an optional accessory to its host, and a mechanism that can hold an agent's turn open has a failure mode the alternative does not. Non-interrupting feedback delivers the identical text at the identical moment, and it removes the loop guard from the design entirely — there is no loop to guard — which in turn removes the per-host risk that a client lacking such a flag would be unsafe to wire.

**Throttled by the existing counter, not a new one.** The end-of-turn event fires once per turn, so an unthrottled reminder injects its payload into every turn of a long session. `prompt-nudge.sh` already owns a per-session turn counter (`rembric_turn_count`) and already fires the summary reminder on the first turn and every `SUMMARY_NUDGE_EVERY` turns thereafter. The end-of-turn entry reuses that counter and that cadence rather than introducing a second one, because two independently-tuned cadences for one obligation is two things to keep in step. What changes is not _how often_ the reminder fires but _where in the turn_ it lands, and what it carries.

Alternative considered: _remind only on `SessionEnd`_. Rejected — `SessionEnd` fires when the session is already closing, so no model turn remains to act on the feedback. That is why the current `SessionEnd` wiring can only write, never ask.

**D5 — The rubric has one definition and a fixture that proves the copies agree.**
The long form lives in one exported constant; the terse pointer that fits inside `DESCRIPTION_MAX_LENGTH` lives beside it, derived or asserted against it. Every client surface — the MCP instructions block, the Hermes provider, the opencode plugin, `post-compact.sh` — carries the same text, and a test enumerates the call sites and fails when one drifts. This is the same lock-step failure the plugin discipline already names for shared resources: six copies of one string with no fixture is how five of them came to disagree with the sixth.

**D6 — The subagent-completion event contributes to the same extraction, and parity is bounded by cost.**
Delegated work is currently invisible: a subagent's edits and commands never appear in the parent's summary, so a session that did all of its work through agents can look empty. Where a host exposes a subagent-completion event, it appends the subagent's extracted facts to the parent session's record and emits no feedback — a subagent finishing is not the moment a handoff is owed.

Parity across the four clients is pursued only where it needs no per-host logic beyond the seams that already exist. Where a host exposes no end-of-turn or subagent-completion event, that absence is recorded for that client rather than emulated: an emulation would be exactly the per-client complexity this repository's plugin discipline exists to prevent.

## Risks / Trade-offs

- [Risk] A synchronous end-of-turn hook adds latency to every turn's end → Mitigation: one request with a short timeout, a single indexed read, and the request skipped entirely on turns the counter does not fire on. Budget the added latency and record it.
- [Risk] An end-of-turn reminder costs tokens on every turn it fires → Mitigation: it fires at the existing counter's cadence, not every turn, and never when a curated summary already exists or the session has nothing worth summarising.
- [Risk] Fail-open means the reminder silently does nothing when the server is unreachable → Accepted deliberately: the failure mode of a missing reminder is a thinner summary, and there is deliberately no failure mode in which the host is degraded.
- [Risk] Tail-keeping changes what existing rows would have contained → No migration: truncation happens at write time and stored rows are never rewritten (append-only). Rows written before this change keep their head-slice, which is why the marker's position must distinguish the two.
- [Risk] The extraction reads a host-specific transcript format → Mitigation: it is already per-host (`rembric_format_transcript_<parser>`); the extraction extends the existing per-parser seam rather than adding a new one, and the fallback for an unparseable transcript is the current behaviour, not an error.

## Open Questions

- ~~**Does the host's `Stop` payload carry a loop-guard flag?**~~ **Answered before implementation: yes — `stop_hook_active`, a boolean that is true when the current stop is happening because a previous hook blocked.** It is moot, because D4 does not block.
- **Should the extraction include diffs, or only paths?** Default: paths and exit statuses only. Diffs would blow the cap and duplicate what git already holds.
- **Does the enriched rubric measurably improve summaries?** Unmeasurable inside this change with the corpus available, so it is not claimed. What IS asserted is that the rubric has one source and that the copies agree.
