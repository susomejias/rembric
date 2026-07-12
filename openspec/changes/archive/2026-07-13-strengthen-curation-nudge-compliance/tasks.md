# Tasks

## 1. Decide the calibrated-imperative wording

- [x] 1.1 Draft the new **summary** nudge text: a directive ("you MUST / don't end without …") conditioned on real memorable work, preserving skip-discretion for trivial turns, keeping the `title ≤100 (the work, not cwd)` + `Goal · Discoveries · Accomplished · Next Steps · Files` structure. Keep it terse.
- [x] 1.2 Draft the new **save** nudge text (already work-conditioned today) in matching imperative tone.
- [x] 1.3 Draft the updated `instructions.ts` `BASE` SUMMARIZE/SAVE lines and confirm both variants stay ≤1000 chars (`instructions.test.ts`).

## 2. Apply the text in lock-step (Part A — all four clients + server)

- [x] 2.1 Update `apps/plugin/test/nudge-fixtures.json` (`save`, `summaryCore`, `summary`; keep `summary === "rembric: " + summaryCore`).
- [x] 2.2 Update `apps/server/src/mcp/instructions.ts` `BASE`.
- [x] 2.3 Update `apps/plugin/scripts/prompt-nudge.sh` (`SAVE_NUDGE`, `SUMMARY_NUDGE`) to match the fixture (Claude Code + Codex).
- [x] 2.4 Update `apps/plugin/.opencode-plugin/plugin.ts` (`SAVE_NUDGE`, `SUMMARY_NUDGE`) to match the fixture.
- [x] 2.5 Update `apps/plugin/.hermes-plugin/__init__.py` `_SAVE_HINT` / `_SUMMARY_HINT` (summary wrapped as `<memory-hint>${summaryCore}</memory-hint>`) AND `system_prompt_block()` — keep the latter byte-identical to `instructions.ts` `BASE`.
- [x] 2.6 Do NOT change any cadence constant (`SAVE_NUDGE_EVERY`, `SUMMARY_NUDGE_EVERY`, the `turn === 1` summary trigger).

## 3. Hermes per-turn title parity (Part B)

- [x] 3.1 In `apps/plugin/.hermes-plugin/__init__.py` `sync_turn`, derive the title with the existing `_derive_title_from_messages` over the session's accumulated `messages` and add it to the `/summary` POST body with `final:false`; OMIT the `title` key when derivation yields an empty string.
- [x] 3.2 Leave `on_pre_compress` unchanged (still no title); confirm `on_session_end` title behavior unchanged.
- [x] 3.3 Confirm no server change is needed (server already accepts `title` on `POST /:slug/sessions/:id/summary`; `writeSummary` runs `applyPrecedence` on title).

## 4. Tests

- [x] 4.1 Update `apps/plugin/test/nudge-fixtures.test.ts` for the new strings (bash turn-1 = `summary`, turn-5 = `save`; Python `_SUMMARY_HINT` = `<memory-hint>${summaryCore}</memory-hint>`; cadence lock-step unchanged).
- [x] 4.2 Update/confirm `instructions.test.ts` (substrings present; both variants ≤1000 chars).
- [x] 4.3 Update Hermes tests to assert `sync_turn` now sends a derived `title` with `final:false`, and omits it before any assistant message.
- [x] 4.4 Grep for any other test asserting the OLD nudge/hint strings and update them.

## 5. Verification

- [x] 5.1 `pnpm run typecheck` · `pnpm run lint` · `pnpm test` all green.
- [x] 5.2 Confirm the nudge parity/lock-step invariant tests pass (`nudge-fixtures.test.ts`, any `invariants.test.ts` nudge checks).
- [x] 5.3 e2e against `pnpm run dev:docker:up` per the `rembric-plugin-development` skill: run a real (non-trivial) work session and confirm (a) the imperative nudge fires on its cadence, (b) Hermes shows a derived (non-placeholder) title from an early turn even without `on_session_end`.
- [x] 5.4 Single unified `plugin` version bump handled by release-please (no manual version edits beyond what the plugin discipline requires).

## 6. Docs / follow-up

- [x] 6.1 Fix the incorrect repo gotcha (`.agents/skills/rembric-plugin-development/references/per-client-gotchas.md`) claiming the Hermes `plugin.yaml` `hooks` array gates `system_prompt_block`/method invocation — it does not for memory providers (verified against `NousResearch/hermes-agent`). Keep this scoped to a doc correction.
