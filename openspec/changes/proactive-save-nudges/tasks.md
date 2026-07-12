> **Note:** v1 of this change (PR #232, merged, not archived) shipped a `PostToolUse` save nudge (`post-tool.sh`) + per-turn save nudges on opencode/Hermes. This revision unifies everything onto one per-turn channel per client and REMOVES the `PostToolUse` path. Tasks below supersede the v1 task list; items touching merged code are re-opened.

## 1. Shared nudge texts (byte-identical, authored once)

- [x] 1.1 Author the two nudge strings, `rembric:`-prefixed: **save** (`memory.save`, title ≤100 + content) and **summary** (`memory.session_summary({title≤100, summary})`, Goal · Discoveries · Accomplished · Next Steps · Files). These are the source of truth for the bash/TS/Python copies.
- [x] 1.2 Fix cadence constants: save = 5, summary = 10 (turn 1 + every 10). Name them consistently: bash inline in `prompt-nudge.sh`; `SAVE_NUDGE_EVERY`/`SUMMARY_NUDGE_EVERY` in TS; `_SAVE_HINT_EVERY`/`_SUMMARY_HINT_EVERY` in Python.
- [x] 1.3 Extend the cross-language lock-step fixture (already covering `stripPrivateTags`/`_redact_private` and the v1 save nudge) to assert the bash/TS/Python copies of BOTH the save and summary nudges are byte-identical.

## 2. Remove the PostToolUse save nudge (Claude + Codex)

- [x] 2.1 Delete `apps/plugin/scripts/post-tool.sh`.
- [x] 2.2 Remove the `PostToolUse` entry from `apps/plugin/hooks/hooks.json` and `apps/plugin/hooks/hooks.codex.json`.
- [x] 2.3 Remove the now-unused `rembric_tool_name_from_stdin_json` helper from `apps/plugin/scripts/_api.sh` if no other caller references it (grep first).
- [x] 2.4 Delete the v1 `post-tool.sh` test.

## 3. Unified `prompt-nudge.sh` (Claude + Codex)

- [x] 3.1 Add `apps/plugin/scripts/prompt-nudge.sh`: source `_api.sh`; read `session_id` from stdin; sanitize; maintain a per-session turn counter file under `${TMPDIR:-/tmp}/rembric-turnnudge/<safe-id>` (mirror the old counter logic, SEPARATE dir); increment; emit the plain `rembric:` save line on `count % 5 == 0` and the summary line on `count == 1 || count % 10 == 0` (0/1/2 lines). NO network call. `set -u` + `trap 'exit 0' ERR`; fallback session key on empty/unparseable stdin.
- [x] 3.2 Add a matcher-less `UserPromptSubmit` entry invoking `prompt-nudge.sh` to `hooks.json` (coexists with the keyword-gated `prompt-search.sh` entry).
- [x] 3.3 Add the same `UserPromptSubmit` entry to `hooks.codex.json` (matcher advisory — Codex ignores it and fires every prompt; the script self-throttles).
- [x] 3.4 Add a test (co-located with `prompt-search.test.ts`): plain `rembric:` stdout (NOT `hookSpecificOutput` JSON); save on turn 5 not 1–4; summary on turn 1 and 10 not 2–9; both lines on turn 10; counter persists in its own dir; empty stdin exits 0.
- [x] 3.5 Verify single-copy discipline: `git ls-files apps/plugin/scripts/prompt-nudge.sh` shows exactly one file, referenced by both manifests; no `*.codex.sh` variant.

## 4. opencode — add summary to the existing `chat.message` nudge

- [x] 4.1 In `apps/plugin/.opencode-plugin/plugin.ts`, add `SUMMARY_NUDGE_EVERY = 10` and a `SUMMARY_NUDGE` const (byte-identical). In the existing `chat.message` handler, reusing `userTurnCounts`, push the summary part on `turn === 1 || turn % SUMMARY_NUDGE_EVERY === 0`, beside the existing save push (`SAVE_NUDGE_EVERY` stays 5). Keep the `subAgentSessions` early return.
- [x] 4.2 Update `plugin.test.ts`: summary pushed on turn 1 and turn 10, absent on 2–9; save still on turn 5; both parts pushed on turn 10; subagent sessions push none.

## 5. Hermes — bump save cadence, add summary, keep urgent reminder

- [x] 5.1 In `apps/plugin/.hermes-plugin/__init__.py`, change `_SAVE_HINT_EVERY` 3→5; add `_SUMMARY_HINT_EVERY = 10` and a `_SUMMARY_HINT` string (byte-identical). In `prefetch`, append the summary hint on `_turn_number == 1 or _turn_number % _SUMMARY_HINT_EVERY == 0`, as a separate line, additive to the save-hint / urgent branches. Keep the urgent pre-compaction branch unchanged (fires once, in place of the normal save hint).
- [x] 5.2 Update Python tests: save hint on turn 5 (not 3); summary hint on turn 1 and 10; save+summary coexist as separate lines on turn 10; urgent reminder still fires once and does not suppress the summary hint; counter resets on session end/switch.

## 6. Cross-change coordination

- [x] 6.1 Reconcile `close-session-context-pollution-gap`'s `claude-code-plugin` hook-catalog delta: it currently describes `PostToolUse` as the `memory.save` nudge channel. When both changes land, that catalog text MUST be updated to drop the `PostToolUse` save-nudge line and reference the matcher-less `UserPromptSubmit` unified nudge instead. Agree land order with that change and rebase the shared manifests (`hooks.json`, `hooks.codex.json`) and `plugin.ts`/`__init__.py`.

## 7. Validation

- [x] 7.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 7.2 `pnpm test` clean (TS + Python), including all new/updated tests and the byte-identical fixture.
- [x] 7.3 `openspec validate --strict proactive-save-nudges` clean.
- [ ] 7.4 Plugin version bump (plugin-tree change; confirm no `server` image rebuild). NOTE: per CLAUDE.md this is release-please automated via conventional commits on merge (extra-files lock-step) — not a manual edit during implementation. Left unchecked pending the commit/merge step.
- [ ] 7.5 Cross-client e2e (`rembric-plugin-development` walkthrough against `pnpm run dev:docker:up`): on each client confirm the save nudge fires ~every 5 turns and the summary nudge on turn 1 + every 10; the turn-1 summary fire yields a curated title (`title_final=1`); turn latency unaffected (injection-only). Record observed behavior and tune N if the model ignores nudges (fatigue) or sessions end just under a boundary.
