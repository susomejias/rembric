## ADDED Requirements

### Requirement: The Codex hook catalog SHALL ship the shared unified `UserPromptSubmit` per-turn nudge hook

`apps/plugin/hooks/hooks.codex.json` SHALL declare a `UserPromptSubmit` entry invoking the SAME `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-nudge.sh` used by Claude Code (single-copy discipline — no Codex-specific variant). It SHALL NOT declare a `PostToolUse` save-nudge entry (the prior `post-tool.sh` approach is removed). Codex's behavior on this event is verified against its official hooks docs: the matcher is not used for `UserPromptSubmit` (the hook fires on every prompt), and plain text on stdout is added as extra developer context.

- Any manifest matcher is advisory — Codex fires the hook on every prompt regardless, and the script's own per-session turn counter is the sole throttle.
- The script emits the SAME plain `rembric:` save (every 5th turn) and summary (turn 1 / every 10th) nudge lines as for Claude Code, as PLAIN stdout — NOT a JSON object. On `UserPromptSubmit`, plain stdout is the correct injection shape (unlike `PostToolUse`, where plain stdout is ignored and only JSON is honored).
- Fail-safe behavior is identical: unreadable/empty stdin exits 0 with no output.

#### Scenario: Codex reuses the shared script and self-throttles

- **GIVEN** the Codex plugin is installed and its `UserPromptSubmit` hook type is trusted in `/hooks`
- **WHEN** Codex fires `UserPromptSubmit` on the 5th and the 10th prompt of a session
- **THEN** `prompt-nudge.sh` SHALL emit the save nudge on turn 5 and BOTH the save and summary nudges on turn 10, using its own per-session counter (not any manifest matcher)

#### Scenario: Plain stdout, never JSON, on this event

- **WHEN** the script emits on a firing turn under Codex
- **THEN** it SHALL write plain `rembric:`-prefixed text (no `hookSpecificOutput` wrapper), which Codex injects as extra developer context
- **AND** the `rembric:` prefix SHALL keep Codex's `looks_like_json` heuristic from flagging it

#### Scenario: No PostToolUse save-nudge entry

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is inspected
- **THEN** it SHALL contain no `PostToolUse` entry emitting a `memory.save` reminder

#### Scenario: Single-copy discipline preserved

- **WHEN** the repo is inspected for hook-script duplication
- **THEN** `apps/plugin/scripts/prompt-nudge.sh` SHALL exist exactly once and be referenced by both `hooks.json` and `hooks.codex.json`; no `prompt-nudge.codex.sh` variant SHALL exist
