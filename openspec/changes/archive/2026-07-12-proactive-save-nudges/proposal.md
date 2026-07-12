# Per-turn save + summary nudges across all four clients

## Why

Operators report long working sessions ending with **zero memories saved** and no curated session summary. The server ships a static SAVE/RECALL/SUMMARIZE block once at session start (`instructions.ts::BASE`), but it gets buried and no client reinforces it. The write side of the memory contract has no per-turn reinforcement.

A first version of this change (shipped in PR #232, not yet archived) added a **save** nudge, but with an **asymmetric** design: Claude/Codex fired it on `PostToolUse` (counting write-tool calls), while opencode/Hermes fired it per-turn at different cadences (5 and 3). That split is hard to reason about (tool-calls vs turns are not comparable), and it left a gap: `PostToolUse` only fires after file writes, so save-worthy moments reached by reading/reasoning (a decision, a discovery) never triggered it. It also never addressed the missing **session summary** curation.

This revision unifies everything: **both the save nudge and a new session-summary nudge live on the SAME per-turn channel of every client, with identical turn-based cadences and no asymmetries.** The `PostToolUse` save hook is removed. Curation is delivered without any server-side LLM (honoring the `remove-llm-consolidation` invariant) and token-consciously — the summary is not real-time; it refreshes on a lax cadence, and the model's own judgment gates whether any nudge actually results in a write.

## What Changes

- **Remove the `PostToolUse` save nudge** entirely (`post-tool.sh` and its `hooks.json`/`hooks.codex.json` `PostToolUse` entries). Save moves to the per-turn channel.
- **Unified per-turn nudge, symmetric across all four clients.** On each client's per-turn channel, a single turn counter drives two throttled, model-facing nudges:
  - **save** nudge when `turn % 5 == 0` (call `memory.save` for salient work).
  - **summary** nudge when `turn == 1 || turn % 10 == 0` (call `memory.session_summary({title, summary})` — the turn-1 fire crafts an early title + Goal; later fires refine).
- **Channels** (the only per-platform difference is the hook's _name_; the behavior/cadence is identical):
  - **Claude Code / Codex** — a matcher-less `UserPromptSubmit` hook → one shared `prompt-nudge.sh` emitting plain `rembric:` stdout (the documented `UserPromptSubmit` injection shape; no `additionalContext` JSON needed). Codex ignores the matcher (fires every prompt) and injects plain stdout too — verified against Codex's hooks docs.
  - **opencode** — the existing `chat.message` handler, reusing its `userTurnCounts` counter.
  - **Hermes** — the existing `prefetch()` return, reusing its `_turn_number` counter.
- **Cadences are single named constants**, byte-identical across the four (save=5, summary=10). Nudge texts are byte-identical cross-language copies, fixture-locked.
- **Retained (Hermes-only, platform-unique):** the pre-compaction urgent save reminder (`on_turn_start` reads `remaining_tokens`, arms a one-shot urgent hint below the floor). This is not a cadence asymmetry to eliminate — no other client exposes a `remaining_tokens` signal, so it is a capability bonus Hermes alone can offer, layered on top of the symmetric core.
- **No `Stop` nudge** (Claude/Codex): forced-continuation risk, and Codex's `Stop` only accepts JSON, not plain nudge text. **No server-side LLM curation**, **no** deriving summaries from memories.

## Capabilities

### New Capabilities

(none — this change adds/modifies requirements on existing client-plugin capabilities)

### Modified Capabilities

- `claude-code-plugin`: replace the `PostToolUse` save-nudge hook with a unified `UserPromptSubmit` per-turn nudge (save@5 + summary@10).
- `codex-distribution`: same replacement in the Codex catalog (shared script; matcher ignored).
- `opencode-plugin`: the per-turn `chat.message` nudge carries BOTH save@5 and summary@10 (was save@5 only).
- `hermes-agent-plugin`: `prefetch` appends save@5 (was @3) AND summary@10; the pre-compaction urgent reminder is retained.

## Impact

- `apps/plugin/scripts/prompt-nudge.sh` — NEW shared script (Claude + Codex): per-session turn counter under `${TMPDIR}/rembric-turnnudge/<id>`; emits the save nudge on `%5` and the summary nudge on turn 1 / `%10` as plain `rembric:` stdout lines (0, 1, or 2 lines per turn). No network call; fail-safe exit 0.
- `apps/plugin/scripts/post-tool.sh` — **REMOVED** (its save-nudge role moves to `prompt-nudge.sh`).
- `apps/plugin/hooks/hooks.json` + `hooks/hooks.codex.json` — remove the `PostToolUse` entry; add a matcher-less `UserPromptSubmit` entry for `prompt-nudge.sh` (coexists with the existing keyword-gated recall entry).
- `apps/plugin/scripts/_api.sh` — `rembric_tool_name_from_stdin_json` becomes unused; remove if no other caller.
- `apps/plugin/.opencode-plugin/plugin.ts` — add `SUMMARY_NUDGE_EVERY=10` + a summary nudge text; push it on `turn===1 || turn%10===0`, beside the existing save nudge (`SAVE_NUDGE_EVERY` stays 5). Both are independent `output.parts` pushes.
- `apps/plugin/.hermes-plugin/__init__.py` — `_SAVE_HINT_EVERY` 3→5; add `_SUMMARY_HINT_EVERY=10` + a summary hint appended on turn 1 / `%10`; keep the urgent pre-compaction branch.
- Shared byte-identical fixture extended to cover the summary nudge copies.
- No server change. Plugin version bumps.
- **Coordination**: `close-session-context-pollution-gap` also touches `hooks.json`/`hooks.codex.json`/`plugin.ts`/`__init__.py` — land order and rebase per that change's notes.
