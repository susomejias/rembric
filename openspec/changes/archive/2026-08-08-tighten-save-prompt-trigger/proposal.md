# Stop `memory.save_prompt` firing on every session's first turn

## Why

The operator reported that in Pi the first message of a session does the right things — `memory.context` and the rest — and then also saves a prompt, which makes no sense. It reproduces on essentially every session.

Nothing is mechanically broken. What reaches the model on turn 1 was measured:

- `nudgesForTurn` emits three lines because `summaryFires = turn === 1` (`apps/plugin/bin/rembric-plugin-core.mjs:142`), and the sessionId reminder rides along with the summary nudge. Both are required behaviour — `openspec/specs/plugin-session-protocol/spec.md:201` and `:239-243`.
- That reminder is the **only** text on that turn naming the tool: `apps/server/src/mcp/instructions.ts` mentions `save_prompt` zero times, and so do the four packaged slash commands.
- `memory.save_prompt`'s own description said: _"Call this when the user states a goal or constraint worth remembering."_

The description is the cause. A session's first message states a goal almost by definition, so that trigger is satisfied once per session **by construction** — the tool was doing exactly what it was told, once per session, forever. The reminder only puts the tool in front of the model; the description is what makes calling it look correct.

Two things follow, and both matter for where the fix goes:

- **It is not a Pi defect.** The same reminder text ships in `apps/plugin/scripts/prompt-nudge.sh` (Claude Code, Codex) and in Hermes's Python copy, and the description is server-side, so every client is exposed. It is not deterministic either — a Claude Code session received the identical reminder and did not call the tool. Model-dependent, which is why it surfaced in one client first.
- **The description was already looser than its own spec.** `mcp-api/spec.md:1385` says the tool is "for persisting **curated** user prompts". Curation is exactly what the trigger dropped.

## What changes

`apps/server/src/mcp/server.ts` — the `memory.save_prompt` description now constrains _when_ to call, not only what to pass:

- the prompt must be worth **reusing**, and the library is curated, not a log;
- calling it routinely, or once per session as a matter of course, is forbidden;
- the bar is an explicit request from the user, or text that is plainly a reusable artifact (a template, a standing instruction, a wording to run again);
- a stated goal is called out as **not** sufficient, naming the false positive directly rather than hoping restraint is inferred;
- the two adjacent intents are redirected: `memory.save` for decisions, fixes and discoveries; `memory.session_summary` for what happened in a session;
- "when in doubt, do not call this" — the default the old text lacked.

`openspec/specs/mcp-api/spec.md` gains the calling discipline as a requirement, so the trigger is no longer unspecified prose that can drift back. The requirement also records why the nudge cadence is not the cause, so a future reader does not "fix" the wrong layer.

## What this change does not do

It does not touch the nudge. The sessionId reminder that names this tool on turn 1 is required behaviour with copies in three languages, fixtures and an invariant test, and rewording it would not remove the false positive — the description is what licenses the call. Whether that line's imperative shape ("pass it explicitly to A/B/C **now**", next to two lines that do say "you MUST call X now") deserves a separate readability pass is a real question, left for its own change.

It also does not delete prompts already saved by the old trigger. Prompt rows are soft-deleted through the dashboard; deciding which of the operator's existing rows are worth keeping is theirs, not this change's.

## Impact

One tool description. No schema change, no migration, no tool added or removed, no client release needed — the description is served from `tools/list`, so every one of the five clients picks it up as soon as the server is updated. `DESCRIPTION_MAX_LENGTH` is 1900 and the description grows; the ceiling assertion in `mcp-integration.test.ts` is what confirms it fits, not an estimate here.
