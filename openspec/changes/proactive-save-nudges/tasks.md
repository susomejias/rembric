## 1. Shared PostToolUse script (Claude + Codex)

- [x] 1.1 Add a `rembric_tool_name_from_stdin_json` helper to `apps/plugin/scripts/_api.sh` extracting `tool_name` (Claude) with a `toolName` fallback (Codex/camelCase), mirroring the existing `session_id`/`sessionId` extractor.
- [x] 1.2 Add `apps/plugin/scripts/post-tool.sh`: read stdin, self-filter to write-shaped tools (`Edit|Write|MultiEdit|NotebookEdit`), maintain a per-session write counter file under `${TMPDIR}/rembric-savenudge/`, and every 8th write emit `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<terse save nudge>"}}` on stdout. Fail safe (unknown/absent tool → exit 0, no nudge). No server URL/token needed.
- [x] 1.3 Wire a `PostToolUse` entry (matcher `Edit|Write|MultiEdit|NotebookEdit`) invoking `post-tool.sh` into `apps/plugin/hooks/hooks.json`.
- [x] 1.4 Wire a `PostToolUse` entry invoking `post-tool.sh` into `apps/plugin/hooks/hooks.codex.json` (no meaningful matcher — Codex ignores it; the script self-filters).
- [x] 1.5 Add a test (co-located with the existing `apps/plugin/test/prompt-search.test.ts` harness) asserting: no nudge for a read-only tool; no nudge for the first 7 write calls; a well-formed `additionalContext` JSON on the 8th; unknown/empty tool → no output.

## 2. opencode periodic save nudge

- [x] 2.1 Add a `SAVE_NUDGE` constant and a per-session `Map<string, number>` turn counter to `apps/plugin/.opencode-plugin/plugin.ts`; in the existing `chat.message` handler (after `appendUserMessage`, skipping subagents as it already does), push the save nudge on every 5th user turn. Independent of the recall nudge (both may fire).
- [x] 2.2 Evict the counter entry in the existing `session.deleted` cleanup.
- [x] 2.3 Add unit tests to `plugin.test.ts`: the nudge fires on the 5th user message and not before; it does not fire for a subagent session; recall + save nudges can both fire on the same turn.

## 3. Hermes per-turn + pre-compaction save reminder

- [x] 3.1 Add `on_turn_start(self, turn_number, message, **kwargs)` to `apps/plugin/.hermes-plugin/__init__.py`: store the turn number; when `remaining_tokens` (from kwargs) is an int below `_COMPACTION_TOKEN_FLOOR` and not already warned, arm `_compaction_imminent`.
- [x] 3.2 Extend `prefetch` to append a terse save-hint to the cached recall string every 3rd turn, and — when `_compaction_imminent` is armed — emit the urgent pre-compaction reminder instead, then mark warned (fires once). Still returns `""`-plus-hint semantics without a network call.
- [x] 3.3 Reset `_compaction_imminent`/`_compaction_warned` (and the turn counter) in the existing session-end and session-switch cleanup paths.
- [x] 3.4 Add `on_turn_start` to `apps/plugin/.hermes-plugin/plugin.yaml`'s `hooks:` array (the array gates override invocation).
- [x] 3.5 Add Python tests: `on_turn_start` arms the flag only below the floor; `prefetch` emits the urgent reminder once then reverts; the normal hint appends on cadence; the recall cache still flows through.

## 4. Validation

- [x] 4.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 4.2 `pnpm test` clean (TS + Python), including all new tests.
- [x] 4.3 `openspec validate --strict proactive-save-nudges` clean.
- [ ] 4.4 Claude Code live check: drive ≥8 file edits in one session, confirm the save nudge appears in the model's context (not just the transcript) on the throttle boundary and nowhere else.
- [ ] 4.5 **Operator-gated (Codex + opencode not installed in this environment):** verify Codex `PostToolUse` fires, its `tool_name` values match the write-shape filter, and `additionalContext` is injected; verify the opencode 5th-turn nudge against a live session. Same gating pattern as the opencode e2e in `improve-recall-and-plugin-parity`.
