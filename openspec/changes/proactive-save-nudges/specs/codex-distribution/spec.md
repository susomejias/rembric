## ADDED Requirements

### Requirement: The Codex hook catalog SHALL ship the shared `PostToolUse` save-nudge hook

`apps/plugin/hooks/hooks.codex.json` SHALL declare a `PostToolUse` entry invoking the SAME `${CLAUDE_PLUGIN_ROOT}/scripts/post-tool.sh` used by Claude Code (single-copy discipline — no Codex-specific variant). Because Codex's dispatcher ignores hook matchers, the script self-filters on `tool_name`; the manifest matcher (if any) is advisory.

- The script emits the same throttled `additionalContext` JSON as for Claude Code (every 8th write-shaped tool call).
- Codex renders `additionalContext` as a visible developer message, so the nudge text stays terse.
- Fail-safe behaviour is identical: an unknown/absent `tool_name` exits 0 with no output, so a Codex stdin-shape difference causes silence, never repeated noise.

#### Scenario: Codex reuses the shared script and self-filters

- **GIVEN** the Codex plugin is installed and its `PostToolUse` hook type is trusted in `/hooks`
- **WHEN** Codex fires `PostToolUse` after a write-shaped tool
- **THEN** `post-tool.sh` SHALL apply its own `tool_name` filter and per-session throttle (not relying on the manifest matcher)
- **AND** on the throttle boundary SHALL emit the `additionalContext` save nudge, else nothing

#### Scenario: Single-copy discipline preserved

- **WHEN** the repo is inspected for hook-script duplication
- **THEN** `apps/plugin/scripts/post-tool.sh` SHALL exist exactly once and be referenced by both `hooks.json` and `hooks.codex.json`; no `post-tool.codex.sh` variant SHALL exist
