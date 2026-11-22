## Why

Claude Code sessions stopped saving memories (issue #439). The evidence, re-checked before this change:

- `server-gated-session-nudges` replaced the five clients' periodic save reminder (`SAVE_NUDGE` every 5 turns: "you MUST call memory.save now") with one server notice that carries **no save clause** — `session-nudges` records this ("As shipped the notice carries no save clause at all") and left adding it to "a change of its own". The only remaining prompt to save is the one `SAVE:` line in `initialize.instructions`.
- Server data for this project since 2026-10-28: the Claude Code working session `0cb8731e` made 3 `memory.session_summary` calls and 0 `memory.save` calls, while every recent memory came from Pi sessions. The reported 4h38m session made 20 `memory.session_summary` calls (each answering a notice) and 0 `memory.save`.
- No client composes a save line any more (grep over the hook scripts, the shared core and the Hermes provider: the only mentions are the `sessionId=` attachment line and Hermes's pre-compaction hint).
- Pi saved because of what surrounds the model there, not because of the plugin: its extension receives the same server notice. That is not a property the protocol can rely on.

Two further defects from the same report, both reproduced:

- **Fallback titles.** `stop-report.sh` delivers the first prompt as a `final: false` title on `/turn`; `session-end.sh` and `pre-compact.sh` then send the first assistant message as a `final: false` title, which replaces it. Executed through `AgentSessionsService`: after `/turn` the title is `Fix the Supabase timeouts`, after `/end` it is `Los errores son timeouts de 10 s en las llamadas`; the control (a curated `final: true` title) survives.
- **MCP without a host plugin.** Such a connection receives no notices at all, so `initialize.instructions` is its whole protocol — and `memory.session_summary` there answers `session_not_found` with no remedy named.

## What Changes

- **The notice gains a save clause** (`session-nudges`). A turn report also evaluates a save condition: tool work (`last_work_at`) later than the session's newest memory (`last_memory_at`, derived at read time from memory rows carrying the session id in the session's project scope — no column, no migration) and no earlier than the previous notice. The clause shares the one floor and `last_nudge_at`, travels first, names the elapsed time, asks rather than asserts, and is never elided inside the 640-byte bound. Because it is server-composed, every client — including already-deployed plugin versions — receives it on the next server release.
- **`initialize.instructions` teaches the whole loop** (`mcp-api`, `hermes-agent-plugin`): an opening line (only what you write outlives the conversation; run the loop yourself, never wait for host reminders), RECALL → SAVE → SUMMARIZE in that order, SAVE timed "as soon as it is settled, not at the end" with one fact per memory and "a session summary never replaces it", and the `session_not_found` → `memory.session_start` recovery. `INSTRUCTIONS_MAX_LENGTH` rises 1000 → 1500 (measured 1432 unscoped / 1436 with a 64-char slug), 548 below the 2048 Claude Code ceiling verified in 2.1.220. The Hermes `system_prompt_block` copy stays byte-identical.
- **Fallback titles keep the first prompt** (`plugin-session-protocol`): one helper, `rembric_fallback_title`, used by `session-end.sh` and `pre-compact.sh`.

Not in scope: the dashboard `prompts` stat (issue #439 item 2). Nothing captures prompts automatically — the count is fed only by `memory.save_prompt`, which is curated by design — so whether to capture, hide or relabel it is a product decision recorded separately.

## Capabilities

### Modified Capabilities

- `session-nudges` — ADDED the save condition and clause; MODIFIED the save-reminder requirement (the clause is no longer absent).
- `mcp-api` — MODIFIED the `initialize.instructions` requirement (loop framing, SAVE timing, no-host recovery, cap 1500) and the merge-clause requirement (cap reference).
- `hermes-agent-plugin` — MODIFIED the two requirements that pin the mirrored block to 1000 characters.
- `plugin-session-protocol` — ADDED the fallback-title rule.

## Impact

- **Server:** `packages/core/src/services/session-nudge.ts` (gate + clause), `packages/core/src/services/agent-sessions.ts` (`reportTurn` reads `last_memory_at`; the service's repository `Pick` gains `memory`), `packages/db/src/repositories/memory-repository.ts` (`lastCreatedAtForSession(scope, sessionId)`, served by `memory_session_idx`), `packages/mcp/src/instructions.ts`.
- **Plugin:** `apps/plugin/scripts/{_transcript.sh,session-end.sh,pre-compact.sh}`, `apps/plugin/.hermes-plugin/__init__.py`.
- **No schema change, no new endpoint, no client protocol change.** Rollback is a plain revert.
- **Overlap with active changes.** `improve-hermes-chat-session-summaries` replaces the summary gate requirement this change sits beside; its "if and only if" is scoped here to the summary directive. `proactive-entity-recall` also carries a MODIFIED copy of the `initialize.instructions` requirement at the 1000 cap; whichever archives second reconciles the cap.
