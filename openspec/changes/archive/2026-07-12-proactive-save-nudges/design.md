# Design — unified per-turn save + summary nudges

## Context

Sessions end under-saved and under-curated because the server's one-shot instruction block gets buried and no client reinforces it per turn. The v1 of this change (PR #232, merged, not archived) added a save nudge but split it asymmetrically: `PostToolUse` (write-tool-counted) on Claude/Codex, per-turn on opencode/Hermes at 5 and 3. This revision unifies both a save nudge and a new session-summary nudge onto ONE per-turn channel per client, with identical cadences and no behavioral asymmetry, and removes the `PostToolUse` path.

Binding constraints (owner): zero server-side LLM reasoning (`remove-llm-consolidation`); no per-turn latency; token-conscious (the summary need NOT be real-time); and **no asymmetries** across clients.

## Goals / Non-Goals

**Goals:**

- One per-turn nudge mechanism per client carrying BOTH nudges: save@5, summary@10 (turn 1 + every 10), turn-counted, identical everywhere.
- Curation (`memory.session_summary`, model-authored, `final:true`) induced during sessions without any server LLM and without depending on compaction.
- An early crafted title + Goal from the turn-1 summary fire.
- Remove the asymmetric `PostToolUse` save nudge.

**Non-Goals:**

- Any `Stop`-based nudge (Claude/Codex): forced-continuation risk; Codex `Stop` accepts only JSON, not plain text.
- Server-side LLM curation, or deriving summaries from anchored memories.
- Making the Hermes pre-compaction urgent reminder symmetric — no other client exposes a `remaining_tokens` signal, so it is a Hermes-only capability bonus, not a cadence to replicate.

## Decision 1 — One per-turn channel per client; the only difference is the hook's name

The core intent (a throttled, model-facing reminder every N turns) is implemented on each client's per-turn injection channel. Behavior and cadence are identical; only the platform's hook _name_ differs — which is not a behavioral asymmetry.

| Client      | Per-turn channel                                      | Injection shape         | Verified                                                                                                                                 |
| ----------- | ----------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `UserPromptSubmit` (matcher-less) → `prompt-nudge.sh` | plain `rembric:` stdout | Claude honors matchers; absent matcher ⇒ every prompt; `prompt-search.sh` already injects plain stdout here                              |
| Codex CLI   | `UserPromptSubmit` (shared script)                    | plain `rembric:` stdout | Codex docs: _"matcher isn't currently used for this event"_ (fires always); _"Plain text on stdout is added as extra developer context"_ |
| opencode    | `chat.message` → `output.parts.push`                  | text parts              | source-confirmed; already the recall/save channel                                                                                        |
| Hermes      | `prefetch()` return (appended lines)                  | string                  | already the save-hint channel; `_turn_number` set by `on_turn_start`                                                                     |

Verified that opencode exposes only `chat.message`/`experimental.session.compacting` and Hermes only per-turn provider hooks — **neither can observe the agent's file-write tools**, so per-turn is their only option regardless. Moving Claude/Codex off `PostToolUse` onto `UserPromptSubmit` therefore _levels the four into symmetry_ rather than degrading anything.

### Rejected channels (confirmed dead ends, retained from v1)

- **Claude/Codex `Stop`** — forced-continuation risk (Claude) and Codex `Stop` only accepts JSON, not plain nudge text.
- **opencode `experimental.chat.system.transform`** — mutations discarded upstream (non-operational).
- **`tui.showToast` / `session.idle`** — user-facing / observation-only; never reach the model.

## Decision 2 — Remove the `PostToolUse` save nudge; both nudges ride the per-turn channel

`PostToolUse` counted write-tool calls (not turns), so it was incomparable to the other clients' per-turn cadence AND missed save-worthy non-write moments (a decision reached by reading). Removing it and putting the save nudge on the per-turn channel makes the system uniform and improves coverage. `post-tool.sh` is deleted; its `hooks.json`/`hooks.codex.json` entries removed. The save nudge's copy and throttle move into the unified `prompt-nudge.sh` (Claude/Codex) and the existing `chat.message`/`prefetch` handlers (opencode/Hermes).

**Alternative considered:** keep `PostToolUse` for its immediacy (fires right after a write, high-signal) and add summary separately. Rejected — the owner explicitly required removing it and eliminating asymmetries; the immediacy gain does not justify a permanently split, unit-mismatched system, and per-turn coverage is strictly broader.

## Decision 3 — Cadences: save@5, summary@10 (turn 1 + every 10); token- and fatigue-conscious

`save fires on turn % 5 == 0`; `summary fires on turn === 1 || turn % 10 == 0`. Single named constants per file, byte-identical across clients.

- **Why the summary is laxer (10) than save (5):** a `{title, summary}` regeneration (~250–350 output tokens) is heavier than a `memory.save`, and the owner explicitly does NOT need a real-time summary. Ratio 1:2 keeps it simple.
- **Token cost is gated by the model's judgment, not the cadence.** Both nudges are advisory — the model evaluates "is there anything worth saving/curating? if not, continue." A fire on a low-progress turn costs only a cheap skip, so the cadence primarily regulates _fatigue_, not direct spend.
- **Worked example** (this ~48-turn design session): summary@10 → fires at 1, 10, 20, 30, 40 = 5 curations ≈ ~2,000 output tokens total (~0.5–1% of the session's spend), never more than 10 turns stale. save@5 fires ~9×, each a cheap reminder the model mostly skips unless something is worth saving.
- **Combined firing pattern**: save at 5,10,15,…; summary at 1,10,20,…; overlap only every 10. Roughly one nudge per ~5 turns, double only every 10 — calm enough to avoid banner-blindness.
- **Turn-1 summary fire is the cheap, high-value one:** `UserPromptSubmit`/`chat.message`/`prefetch` fire at the start of the turn, so the model crafts a title + Goal from the opening intent. `applyPrecedence`'s `last-final-wins` (verified) means later curations refine it and raw syncs never clobber it.
- **Tunable:** if the plugin e2e pass shows the model ignoring nudges systematically, raise N — a one-constant change, no design impact.

## Decision 4 — One shared `prompt-nudge.sh` for both shell clients

Per the single-copy discipline, Claude and Codex share `prompt-nudge.sh` (the platform delta stays at the manifest level: Claude needs a matcher-less entry since it honors matchers; Codex ignores matchers). The script reads `session_id` from stdin, maintains a per-session turn counter under `${TMPDIR}/rembric-turnnudge/<safe-id>`, and emits 0/1/2 plain `rembric:` stdout lines per turn (save line on `%5`, summary line on turn 1 / `%10`). No server URL/token, no network call; fail-safe exit 0 on any error. Plain stdout — NOT the `additionalContext` JSON `PostToolUse` required — because `UserPromptSubmit` injects plain stdout as developer context on both clients.

**Alternative considered:** two separate `UserPromptSubmit` scripts (one save, one summary). Rejected — one script + one counter is simpler and avoids two hook invocations per prompt; emitting two lines when both fire is trivial.

## Decision 5 — Nudge copy: terse, English, imperative, byte-identical

Two static texts, `rembric:`-prefixed (so Codex's `looks_like_json` heuristic does not flag them), duplicated as bash/TS/Python copies kept byte-identical by the shared fixture:

- **save**: `rembric: if recent work produced a decision, fix, or discovery, call memory.save now (title ≤100 + content).`
- **summary**: directs `memory.session_summary({title≤100, summary})` with the `Goal · Discoveries · Accomplished · Next Steps · Files` structure.
- **urgent (Hermes pre-compaction)**: `rembric: context is about to compact — save anything important with memory.save NOW before it's lost.`

## Decision 6 — Hermes pre-compaction urgent reminder: retained, one-shot, platform-unique

`on_turn_start` reads `remaining_tokens`; below `_COMPACTION_TOKEN_FLOOR` (20,000, tunable) it arms a one-shot urgent flag, and the next `prefetch` emits the urgent save reminder instead of the normal hint, then marks itself warned (fires once per session; resets on session end/switch). This is the single highest-value save fire — it triggers exactly when un-saved context is about to be lost. It is retained from v1 unchanged. It is NOT an asymmetry to eliminate: no other client exposes a `remaining_tokens` signal, so it is a capability only Hermes can offer, layered above the symmetric save@5/summary@10 core.

## Decision 7 — Pure-plugin, no server change; curation flows through existing MCP path

Every nudge is a static client-local string. The curated write the summary nudge induces flows through the already-existing `memory.session_summary` MCP tool (which hardcodes `final:true` server-side). No new endpoint, no server edit, no `remove-llm-consolidation` reversal.

## Risks / Trade-offs

- [Risk] Nudges are advisory → curation/saving stays best-effort, not guaranteed → **Mitigation**: `close-session-context-pollution-gap`'s per-turn RAW sync is the non-empty floor; the turn-1 summary fire + every-10 cadence maximizes the chance a curated `{title, summary}` exists at any exit.
- [Risk] Removing `PostToolUse` loses the "fire immediately after a write" immediacy → **Accepted because** per-turn coverage is broader (catches non-write save moments) and the owner required removing the asymmetry; one-turn delay is negligible for an advisory nudge.
- [Trade-off] Two per-turn nudges could fatigue the model → **Mitigation**: save@5 + summary@10 overlap only every 10; advisory (model skips cheaply); N is trivially tunable up after e2e.
- [Risk] Migrating merged v1 code (removing `post-tool.sh`, rewiring hooks) → **Mitigation**: v1's e2e (its old 4.4/4.5) was never run, so no validation is discarded; the plugin e2e pass validates the final unified design directly.
- [Trade-off] Three hand-maintained copies of each nudge text can drift → **Accepted because** the byte-identical fixture fails CI on drift (same guard as the other cross-language shared strings).
- [Risk] File overlap with `close-session-context-pollution-gap` (`hooks.json`, `hooks.codex.json`, `plugin.ts`, `__init__.py`) → **Mitigation**: fixed land order + rebase, per that change's notes.

## Migration Plan

1. Delete `post-tool.sh` and its `PostToolUse` hook entries; remove the now-unused `rembric_tool_name_from_stdin_json` helper if no other caller.
2. Add `prompt-nudge.sh` + matcher-less `UserPromptSubmit` entries in both manifests.
3. opencode: add the summary push to `chat.message` beside the existing save push. Hermes: `_SAVE_HINT_EVERY` 3→5, add `_SUMMARY_HINT_EVERY`=10, keep the urgent branch.
4. Extend the byte-identical fixture; update all tests.
5. Plugin version bump. Validate; run the cross-client e2e (`rembric-plugin-development` walkthrough) and tune N if needed.
6. Rollback = normal revert; no data migration, no schema change, no new write path.

## Open Questions

- Final N values (save 5 / summary 10) — tune during e2e against real turn distributions (no turn telemetry exists today; the RAW sync's per-turn POST could later serve as a turn-count proxy if data-driven tuning is wanted).
