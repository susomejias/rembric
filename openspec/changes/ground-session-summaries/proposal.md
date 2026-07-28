## Why

A session's summary is the only artefact the next session reads back. Today it depends entirely on the agent choosing to call `memory.session_summary`, and when the agent does not, three separate mechanisms each fail in a way that is invisible.

The raw fallback loses the part that matters. `_transcript.sh` deliberately keeps the **last** 19 500 chars — its own comment says "redact before tail-truncation" — and then `truncateSummary` keeps the **first** 10 000. Composed, the stored artefact is a middle window of the session and the last ~9 500 chars are discarded: the conclusions, the final state and the next steps, which are exactly what a handoff needs.

The reminder never fires when it would work. The nudge is on `UserPromptSubmit`, i.e. while work is still happening. At the moment the session actually ends, the only wiring is `stop-sync.sh` with `async: true` — and an async hook is fire-and-forget, so the strongest lever the host offers at that point is structurally unavailable.

The instruction is thin and duplicated. One rubric — `Goal · Discoveries · Accomplished · Next Steps · Files` — is restated in six places and has **already diverged**: the MCP tool description names seven sections, the other five name five.

## What Changes

- **Truncation keeps the tail, in one place, against one constant.** The end of a session carries the conclusions; the beginning carries the setup. `truncateSummary` becomes tail-keeping so the server stops discarding what the plugin deliberately selected, and the plugin's wire bound stops being a second, larger, independently-maintained number — it is derived from the server cap and cuts at a record boundary rather than mid-message, so the artefact stays parseable. The truncation marker moves to the front (`…[truncated]` prefix), because a reader must be able to tell a whole summary from the tail of a long one.
- **The cap stays bounded at `SUMMARY_MAX_CHARS`, and is deliberately NOT raised.** Rejected: growing the column toward what SQLite can hold. `memory.session_get` returns `summary` in full, so an unbounded field is an unbounded blob handed to an agent's context window; and a summary that may grow without limit stops being a summary and becomes a second copy of the transcript, which is what the raw path already is. Raising the cap treats the symptom — the payload is a dump — instead of the cause. The fix is to change what the fallback _is_, not how much of it fits.
- **The fallback becomes structured facts instead of a transcript dump.** A deterministic pass over the transcript extracts what is checkable without a model: files touched, commands run and which of them failed, tools used, and the last exchange. Facts survive a character cap far better than prose, they are grounded by construction, and they give the next reader something usable even when no model ever curated the session. This is the change that makes the existing raw path earn the storage it already consumes.
- **The end-of-turn event gains a synchronous entry that reminds, and never interrupts.** Split from the existing async sync: a second, non-async entry checks whether a curated summary is owed and, if so, emits **non-interrupting feedback** — not the host's blocking decision. The payload is where the _detailed_ rubric lives, because it has no length budget and arrives at the one moment the model can still act on it. **It reuses the per-session turn counter the start-of-turn nudge already owns, at the same cadence**: the end-of-turn event fires once per turn, not once per session, so an unthrottled reminder would inject into every turn — and the repository already has exactly one "remind every N turns" mechanism, so a second tuned cadence would be a second thing to keep in step. Not blocking also removes the loop guard entirely: there is no loop to guard. **Fail-open is absolute** — any error, timeout, non-2xx or unreadable counter exits silently.
- **The rubric gets one source of truth.** It is currently six copies, already divergent. The enriched rubric — work done, decisions and their reasons, what was verified and how, what was left unfinished, files — is defined once and every client surface derives from it, with a fixture asserting they agree. The MCP tool description is exempt from carrying the long form: it is hard-capped by `DESCRIPTION_MAX_LENGTH = 1900` against the host's truncation ceiling, so it keeps a terse pointer and the long form travels in the end-of-turn payload.
- **The subagent-completion event is wired, because delegated work is currently invisible.** A subagent's file edits and commands never reach the parent session's summary, so a session that delegated everything can look empty. Its contribution feeds the same extracted facts, and it emits no feedback of its own. Client parity is pursued only where it needs no per-host logic beyond the existing seams; where a host has no such event, that is recorded rather than emulated.

Deliberately **not** in scope: surfacing uncurated summaries in `memory.context`. That is only defensible once the fallback is structured facts rather than a dump, so it belongs in a follow-up that can measure the effect on context size — not in the change that makes the fallback structured. Also out of scope: server-side model summarisation of a session that ended raw. The consolidation sweep is contractually deterministic with no LLM and no cron; adding one is a separate decision about cost and latency, not a side effect of this change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `sessions` — truncation direction and its single constant; the rubric's single source and the tool description's exemption from carrying it; what the deterministic fallback contains.
- `plugin-session-protocol` — the end-of-turn gate, its fail-open contract, and the subagent-completion event.
