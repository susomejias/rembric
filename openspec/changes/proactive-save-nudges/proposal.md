# Proactive save nudges across all four clients

## Why

Operators report long working sessions (30–40 min) ending with **zero memories saved**. The server ships a static SAVE/RECALL/SUMMARIZE instruction block once at session start (`instructions.ts::BASE`), but it gets buried as the conversation grows, and no client reinforces it afterward. Every client today nudges only **recall** (keyword-triggered) — none nudges **saving**. The write side of the memory contract has no per-turn reinforcement.

An audit of each provider's plugin API found a proven, model-facing injection channel per client that can carry a throttled save reminder using **real provider hooks/APIs** — no polling, no timers:

- **Claude Code / Codex CLI** — the `PostToolUse` hook injects `hookSpecificOutput.additionalContext` into the model's context after a tool runs.
- **opencode** — the `chat.message` hook pushes a text part the model reads (the same channel already used for the recall nudge).
- **Hermes** — `prefetch()`'s return value is injected as `<memory-context>` every turn; `on_turn_start`'s `remaining_tokens` signals imminent compaction.

## What Changes

- **Claude Code + Codex**: add a `PostToolUse` hook wired to one shared `post-tool.sh` that, after a write-shaped tool (Edit/Write/MultiEdit/NotebookEdit), emits a throttled `additionalContext` save reminder. Throttled to every Nth write-type call per session (counter file), so it nudges occasionally, not on every edit.
- **opencode**: add a per-session user-turn counter to the existing `chat.message` handler; every Nth non-subagent user turn, push a save reminder text part (independent of the recall nudge).
- **Hermes**: `prefetch()` appends a terse save-hint line on a turn cadence; `on_turn_start` sets an "urgent" flag when `remaining_tokens` falls below a threshold, so the next `prefetch` emits a **pre-compaction save reminder** — targeting the exact failure mode (a long session hitting compaction with nothing saved).

Out of scope (dead ends confirmed by the audit): Codex `Stop` (cannot inject context, only forces continuation), opencode `experimental.chat.system.transform` (mutations silently discarded), `tui.showToast`/`session.idle` (user-facing, not model-facing), and a Claude `Stop` hook (deliberately not wired — forced-continuation risk, per the `claude-code-plugin` spec).

## Impact

- Affected specs: `claude-code-plugin`, `codex-distribution`, `opencode-plugin`, `hermes-agent-plugin` (each gains one save-nudge requirement).
- Affected code: `apps/plugin/scripts/post-tool.sh` (new, shared), `apps/plugin/hooks/hooks.json` + `hooks/hooks.codex.json` (new `PostToolUse` entry), `apps/plugin/.opencode-plugin/plugin.ts`, `apps/plugin/.hermes-plugin/__init__.py` + `plugin.yaml`.
- No server change. All nudges are static client-local strings; no new endpoint.
- Single-copy discipline preserved: one `post-tool.sh` for both shell clients (the platform delta stays at the manifest env-prefix/matcher level).
- Plugin version bumps (touches `apps/plugin/`), so Claude Code re-fetches the hook.
