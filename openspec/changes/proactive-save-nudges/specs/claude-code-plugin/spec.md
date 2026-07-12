## ADDED Requirements

### Requirement: The plugin SHALL ship a `PostToolUse` save-nudge hook

The plugin's hook catalog (`apps/plugin/hooks/hooks.json`) SHALL declare a `PostToolUse` entry that invokes a shared `${CLAUDE_PLUGIN_ROOT}/scripts/post-tool.sh`, reminding the model to persist salient work with `memory.save` after write-shaped tool calls, throttled to avoid noise.

- Matcher: `Edit|Write|MultiEdit|NotebookEdit` (write-shaped tools only; read-only tools never trigger it).
- The script SHALL read `tool_name` and `session_id` from hook stdin.
- The script SHALL maintain a per-session counter of matched calls and emit the nudge only every 8th matched call.
- When it emits, it SHALL write a single JSON object to stdout of the shape `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<nudge>"}}` — the only channel that injects into the model's context on `PostToolUse` (plain stdout is not injected).
- The nudge text SHALL be terse, `rembric:`-prefixed, and imperative (call `memory.save` with title ≤100 + content).
- The script SHALL fail safe: an absent/unknown tool name, unreadable stdin, or any error SHALL exit 0 with no output.
- The script needs no `REMBRIC_SERVER_URL`/`REMBRIC_API_TOKEN` (the nudge is a static local string; no network call).

#### Scenario: Save nudge fires on the throttle boundary after write-shaped tools

- **GIVEN** the plugin is installed and a Claude Code session has issued 7 prior `Edit`/`Write` tool calls
- **WHEN** Claude Code fires `PostToolUse` for the 8th write-shaped tool with stdin `{"tool_name":"Write","session_id":"claude-sess-abc"}`
- **THEN** `post-tool.sh` SHALL write `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"rembric: …memory.save…"}}` to stdout
- **AND** the next model turn SHALL see that reminder in its context

#### Scenario: No nudge for read-only tools or below the throttle

- **WHEN** `PostToolUse` fires with `tool_name` not in the write-shape set (e.g. `Read`, `Grep`), or on any of the first 7 matched calls of a session
- **THEN** `post-tool.sh` SHALL emit no stdout and exit 0
