## Why

Issue #497: every turn pays for Rembric's protocol and tool schemas whether or not it uses memory, and the cost had never been measured. Measured over the real `createMcpServer` (`tools/list` and `initialize` over an in-memory transport) and a Pi host model that declares every active tool:

- The server publishes 26 tools whose model-visible declarations (name, description, parameters) total 45,459 bytes. The nine rarely used tools named in the issue — all nine exist — account for 11.4 KB of that.
- Pi registered every tool with the default `direct` exposure and appended the 1,431-byte instructions on every run, suppressed sub-agent runs included: 46,890 bytes per request in a main session and the same in a sub-agent run.
- Pi 1.x can defer a tool until its `tool_search` loads it. Claude Code, Hermes and Codex already defer MCP schemas host-side, so the server's tool definitions stay as they are.
- opencode 2.x kept the previous turn's block when a prompt computed an empty one, so stale one-shot nudges were re-sent on every later request (reproduced by a test before the fix).

## What Changes

- **Pi defers the rarely used tools** (`pi-plugin`) where the host has a `tool_search` that can load them, and activates `tool_search`. On any other host every tool registers as before. The deferral set lives in the shared core.
- **Pi skips the instructions on suppressed runs** (`pi-plugin`). Primary runs keep the instructions and the save and summary reminders unchanged (#439).
- **opencode 2.x replaces the cached block with an empty one** (`opencode-plugin`).

Measured per Pi request after the change on a host with `tool_search`: 36,206 bytes in a main session (−10,684) and 34,775 bytes in a sub-agent run (−12,115), counting the `tool_search` declaration the change activates. On a host without `tool_search` a main session is unchanged and a sub-agent run drops the 1,431-byte instructions. A real Pi 1.4.0 run (`pi -p` against a local capture provider and a scratch dev server) recorded whole outbound request bodies of 54,342 → 43,403 bytes in a main session and 53,908 → 41,523 bytes in a sub-agent run, with nine Rembric tools left out and `tool_search` declared.

Not in scope, left as follow-ups: an environment switch that turns instruction injection off, trimming tool descriptions, and server-side `_meta` deferral hints.

## Capabilities

### Modified Capabilities

- `pi-plugin` — MODIFIED the tool-discovery requirement (the deferral set is the one exception to the no-inventory rule); ADDED the deferral requirement and the suppressed-run instructions requirement.
- `opencode-plugin` — ADDED the cache-replacement rule for the V2 plugin.

## Impact

- **Plugin:** `apps/plugin/bin/rembric-plugin-core.{mjs,d.mts}` (`RARELY_USED_TOOLS`), `apps/plugin/.pi-plugin/index.ts`, `apps/plugin/.opencode-plugin/plugin.ts`, and their tests. One unified `plugin` release; no server change.
- **No schema, endpoint or protocol change.** Rollback is a plain revert.
- A model that calls a deferred tool directly before loading it gets the host's "tool not found" result; the `tool_search` description directs it to search first. The server instructions still name `memory.session_get_batch` and `memory.about`.
- **Overlap with active changes.** `fix-pi-subagent-sessions` defines the suppression signals this change reuses; its "tools stay available inside a suppressed process" scenario still holds. `add-opencode-v2-plugin` defines the V2 cache this change refines.
