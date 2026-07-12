## Why

Across all four clients the per-turn curation nudge is **delivered** to the model but frequently **not acted on**: a real work session ends with only a raw transcript, no model-authored `memory.session_summary`. Live evidence this session confirmed the cause is compliance, not plumbing — a Claude Code agent, asked why it skipped the summary, answered that it _saw_ the hook and _chose_ not to obey because the (trivial) content "wasn't memorable." That specific judgment was correct, but the same soft, advisory framing also gets skipped when work _is_ real. Hermes's own upstream (`NousResearch/hermes-agent` issue #46955, open) reaches the same conclusion: the injection channel is solved, "what is missing is a behavioral instruction." Separately, Hermes leaves sessions with an ugly generic placeholder title (`.HERMES · <timestamp>`) because it only derives a title in `on_session_end`, which in practice rarely fires — the other three clients already send a derived title every turn.

## What Changes

- **Reframe the save/summary nudge text from passive advisory to a calibrated imperative**, byte-for-byte in lock-step across all four clients (the `nudge-fixtures.json` contract + the server `initialize.instructions` block). "Calibrated" is load-bearing: the imperative is **conditioned on real, memorable work** (a decision, fix, discovery, or files changed) so the model keeps its correct habit of NOT curating trivial sessions. This attacks only the "real work happened but the model deferred/forgot" case — it does not tell the model to curate always.
- **No cadence change.** Summary still nudges on turn 1 and every 10 (`turn === 1 || turn % 10 === 0`); save every 5. Only the text of the message changes, never the firing frequency. The lock-step cadence numbers (`SAVE_NUDGE_EVERY`, `SUMMARY_NUDGE_EVERY`) are untouched.
- **Give Hermes per-turn title parity** with the other three clients: derive the title in `sync_turn` (reusing the existing `_derive_title_from_messages`) and POST it with `final:false`, so the placeholder is replaced from turn 1 even when the model never curates and `on_session_end` never fires. Existing `applyPrecedence` guarantees a later model-authored `final:true` title still wins.
- Update the `nudge-fixtures.json` fixture and the parity/lock-step tests (`nudge-fixtures.test.ts`) to the new text; keep Hermes's `system_prompt_block()` byte-identical to `instructions.ts` `BASE`.

Explicitly **out of scope** (rejected in design.md): server-side LLM curation (reverses the archived `remove-llm-consolidation` decision — the server stays a deterministic SQLite+HTTP process), and blocking/forcing turn completion (no uniform cross-client mechanism exists; even Claude Code's `Stop` `decision:block` only "hopes the model complies"). This change raises compliance probability; it does not — and cannot, client-side — guarantee curation.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `plugin-session-protocol`: the `initialize.instructions` protocol-nudge requirement changes its phrasing clause from "proactive" to a **calibrated imperative conditioned on real, memorable work**. This is the single source of truth for nudge phrasing; the per-turn save/summary nudge text is shared byte-identical across all four clients via the `nudge-fixtures.json` contract and follows the same phrasing, so the four client specs (`claude-code-plugin`, `codex-distribution`, `opencode-plugin`, `hermes-agent-plugin`) need NO delta — their cadence/structure/byte-identical requirements are unchanged; only the literal string in the fixture + the four call sites changes, in lock-step.
- `hermes-agent-plugin`: the provider now derives (via the existing `_derive_title_from_messages`) and sends a **non-final title on every `sync_turn`** — previously the lifecycle spec explicitly reserved title derivation for `on_session_end`. This replaces the generic placeholder from turn 1 even when `on_session_end` never fires (the common case: Hermes sessions stay `active`). `applyPrecedence` still lets a later model-authored `final:true` title win.

## Impact

- **Nudge text (lock-step, all four clients + server):** `apps/server/src/mcp/instructions.ts` (`BASE`), `apps/plugin/scripts/prompt-nudge.sh` (`SAVE_NUDGE`/`SUMMARY_NUDGE`), `apps/plugin/.opencode-plugin/plugin.ts` (`SAVE_NUDGE`/`SUMMARY_NUDGE`), `apps/plugin/.hermes-plugin/__init__.py` (`_SAVE_HINT`/`_SUMMARY_HINT` + `system_prompt_block`).
- **Fixture + tests:** `apps/plugin/test/nudge-fixtures.json`, `apps/plugin/test/nudge-fixtures.test.ts`, and any co-located test asserting the old strings (`instructions.test.ts` length cap ≤1000 must still hold).
- **Hermes title parity:** `apps/plugin/.hermes-plugin/__init__.py` (`sync_turn` — add title derivation + POST field); server already accepts `title` on `POST /:slug/sessions/:id/summary` (`apps/server/src/server/api-router.ts`) and `writeSummary` already runs `applyPrecedence` on title (`apps/server/src/services/agent-sessions.ts`) — no server change required.
- **No DB migration, no new MCP tool, no new HTTP endpoint.** Append-only, scope-at-service, and `topic_key` invariants untouched — this is text + one client-side derivation.
- **Distribution discipline:** touches `apps/plugin/` → the `rembric-plugin-development` skill (four clients, parity, e2e against `dev:docker:up`) applies. Single unified `plugin` version bumps.
