## Context

The plugin tier currently handles compaction in two clients via "nudge-and-pray":

- **Claude Code**: `SessionStart` matcher:`"compact"` injects a multi-line instruction into the post-compact model context urging it to call `memory.session_summary`. Whether the model cooperates is the determining factor for whether the row gets a summary at all.
- **opencode**: `experimental.session.compacting` pushes a similar instruction onto the compactor's output context.

Both rely on the agent. The auto-curate safety net added in PR #71 (archived as `tighten-context-content-predicate-to-final-summaries`) covers the case where no cooperative summary lands by deriving `[auto] N memorias[, P prompts]…` server-side at terminal transition — but that's a fallback, not a substitute for a real summary.

When investigating reference implementations (`rohitg00/agentmemory`), we found that **Claude Code, Codex CLI, and opencode all expose post-compaction events we don't subscribe to**. Claude Code's `PostCompact` event even delivers the model-authored `compaction_summary` directly on stdin — eliminating the model-cooperation dependency entirely for that client.

A separate discovery: the existing `codex-distribution` spec claims "Codex has no PreCompact or PostCompact event" (line 56 of `openspec/specs/codex-distribution/spec.md`). That claim is **wrong**, source-verified against `codex-rs/hooks/src/engine/output_parser.rs` which defines both `parse_pre_compact` and `parse_post_compact`. The spec was authored from the partial public docs at `developers.openai.com/codex/plugins/hooks`; the source is authoritative.

## Goals / Non-Goals

**Goals:**

- Cable PreCompact + PostCompact for both Claude Code and Codex CLI, with shared scripts under `apps/plugin/scripts/` to keep the cross-client doctrine intact (`shared logic lives in shared paths`).
- Cable `session.compacted` for opencode as a "flush at this milestone" trigger.
- Cable recall-regex detection in opencode's `chat.message` handler for cross-client paridad with the existing `UserPromptSubmit` regex used by Claude Code and Codex CLI.
- Refine four prompt surfaces to make `memory.context` the canonical post-compact detail-recovery path.
- Correct the codex-distribution spec to reflect the real Codex event surface (source-verified).

**Non-Goals:**

- NO new HTTP endpoints. The "read pattern" (where hooks GET memory and inject it into the compactor's input — agentmemory's primary trick) is **explicitly deferred** to a future change. Discussed and decided: the "save-only" surface is mechanical and ships independently; the "save+read" surface reopens the deferred-scope decision recorded in memory `01KRQ78R4H9QDCSFASX6S3S55S` and benefits from empirical data on "how often does the model fail to call memory.context post-compact?" — data we don't have yet.
- NO `UserPromptExpansion` slash-command handlers in Claude Code. That's a UX trade-off (model interprets `$ARGUMENTS` vs hook executes directly) that deserves its own debate.
- NO rich per-event observability (assistant message cost/tokens, tool call telemetry, subtask spawn capture) à la agentmemory's opencode plugin. Scope explosion; would warrant its own proposal if pursued.
- NO changes to the bridge (`apps/plugin/bin/rembric-bridge.mjs`) or dotenv lib (`apps/plugin/bin/rembric-dotenv.mjs`).
- NO Hermes `prefetch` / `queue_prefetch` / `sync_turn` / `on_memory_write` activation (those remain no-ops; activating them would require new HTTP routes, which is again "save+read" scope).

## Decisions

### Decision 1: Shared `pre-compact.sh` and `post-compaction.sh` for Claude + Codex

**Chosen:** One script per event, sourced by both client hook manifests.

**Alternative considered:** Per-client variants `pre-compact-claude.sh` / `pre-compact-codex.sh`.

**Rationale:** The `shared-plugin-logic` doctrine (`apps/server/src/test/invariants.test.ts` + memory `01KRNZM2VFCME5HNT8N78HZW18`) says shared logic lives once. The stdin contracts for Claude `PreCompact` (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `compaction_trigger`) and Codex `PreCompact` (verified in `codex-rs/hooks/src/engine/output_parser.rs::parse_pre_compact`'s wire type) are compatible — both pass `session_id` and `cwd`; Codex passes `transcript_path` in the same shape. The scripts use the existing `rembric_session_id_from_stdin_json` and `rembric_cwd_from_stdin_json` helpers from `_api.sh`, which already handle both Claude's `session_id` key and Codex's `sessionId` fallback (per the `codex-distribution` spec line 105). No per-client fork required.

If Codex's `compaction_trigger` field differs in shape from Claude's, the scripts treat it as optional metadata (logged to stderr diagnostic, not POSTed) — neither client needs it for the persistence path.

### Decision 2: `PostCompact` uses stdin's `compaction_summary` directly; does NOT re-read the transcript

**Chosen:** `post-compaction.sh` POSTs `{summary: <compaction_summary from stdin>, final:false}` and skips reading `transcript_path`.

**Alternative considered:** Use `compaction_summary` ONLY if present and fall back to formatting `transcript_path` like `pre-compact.sh` does.

**Rationale:** `PostCompact` is documented (Claude Code) and source-verified (Codex) to deliver the model-authored compaction summary on stdin. That's the highest-quality summary we can get — it was crafted by the same model that just compressed the conversation. Reading `transcript_path` post-compact would give us the post-compaction state (compacted summary + recent turns), which is what the model already has in context — duplicating it as our "summary" is worse than using the canonical compaction_summary directly.

If `compaction_summary` is absent (shape mismatch, future Codex change), the script logs a stderr diagnostic and POSTs `/summary` with body `{}` — letting the existing `summary_final` precedence on the server take care of preserving any pre-existing summary.

### Decision 3: opencode `session.compacted` uses the in-memory accumulator, not the event payload

**Chosen:** When `session.compacted` fires, call `flushSessionSummary(sessionId)` — the same path used by `session.idle` and `server.instance.disposed`.

**Alternative considered:** Reset the `sessionMessages` Map for the affected session id post-compaction and start fresh.

**Rationale:** opencode does NOT deliver the `compaction_summary` text on `session.compacted` — it's a notification event, not a content delivery. Our `sessionMessages` Map persists across compaction (it's in-process plugin state), so it still holds the full pre-compact transcript. Flushing it AT compaction time captures "everything up to and including the compaction milestone" — strictly more information than the model-authored compact summary alone, because it includes the raw turns the compactor compressed.

Resetting the accumulator was rejected: subsequent `session.idle` events would have only the post-compact accumulator state, which is less useful than the rolling pre+post view we get by leaving it alone.

### Decision 4: opencode `chat.message` recall-regex is server-evaluated, not text-injected

**Chosen:** When the user message matches `/remember|recall|acordate|qué hicimos|what did we do/i`, append a one-line nudge to `output.parts` (same string as the existing Claude+Codex `UserPromptSubmit` hook).

**Alternative considered:** POST a `memory.search` from the plugin and inject results.

**Rationale:** The "POST and inject results" approach is the read pattern that's explicitly out of scope (see Non-Goals). The nudge approach is the existing Claude+Codex pattern — the LLM sees the nudge and dispatches `memory.search` itself via MCP. opencode's existing `experimental.session.compacting` precedent demonstrates the nudge-to-context pattern works cleanly without HTTP round-trips.

### Decision 5: Correct `codex-distribution` spec misstatement in this change

**Chosen:** Spec delta MODIFIES the existing "Codex hook configuration" requirement and its "Hook event coverage" scenario to (a) remove the wrong "Codex has no PreCompact/PostCompact" claim, and (b) add wiring for the new events.

**Alternative considered:** Open a separate spec-correction bugfix change, then add wiring in a follow-up.

**Rationale:** The misstatement is the reason we don't currently wire those events. Splitting the correction from the wiring would mean shipping a spec PR that says "Codex does support PreCompact/PostCompact, but we don't wire them" followed by another PR that does. Single change keeps the spec and the implementation in lock-step.

### Decision 6: Server-side instructions.ts edit is in scope despite being outside `apps/plugin/`

**Chosen:** Include the one-line `apps/server/src/mcp/instructions.ts` edit (memory.context post-compact pointer) in this change.

**Alternative considered:** Split it into its own server-side change.

**Rationale:** The edit is a docstring update inside the existing 800-char cap. It's the **server's** equivalent of the prompt refinements we're making in the four plugin clients' nudges — same intent (teach the agent when to call memory.context), same surface (text-only). Splitting it would fragment what is a single coherent prompt-engineering exercise across two PRs reviewed in isolation. The change is reversible by `git revert` of one line.

The corresponding `apps/server/src/mcp/instructions.test.ts` already asserts the 800-char cap and the presence of specific substrings; we'll add an assertion for the new line.

## Risks / Trade-offs

- **[Risk]** Claude Code's `PreCompact` schema includes fields we haven't seen at runtime (the docs and source don't 100% match). → **Mitigation:** The shared scripts already handle missing/empty stdin fields by exiting `0` with a stderr diagnostic. If `transcript_path` is missing in `PreCompact`, we POST `/summary {}` and rely on the server's `summary_final` precedence. Worst case: PreCompact becomes a no-op for that client, same as today.

- **[Risk]** Codex `PreCompact` / `PostCompact` stdin shape differs from Claude's in a non-obvious way (e.g. `compactionSummary` instead of `compaction_summary`). → **Mitigation:** During implementation, the agent applying this change MUST verify against `codex-rs/hooks/src/schema.rs` or by running Codex with `RUST_LOG=debug` and reading actual stdin. Both clients' shared-script pattern allows per-client fallback parsing if needed (same precedent as `session_id` vs `sessionId`).

- **[Risk]** Codex feature flag `plugin_hooks` is still default-off (per the `codex-distribution` spec). Wiring new events doesn't help Codex users who haven't enabled it. → **Mitigation:** This is a pre-existing constraint, not introduced by this change. The `docs/agents.md` Codex section already documents the `codex features enable plugin_hooks` step and the `/hooks` trust review.

- **[Risk]** Token cost: the sharpened nudges add maybe 30-60 chars to each prompt surface. → **Mitigation:** The Claude `post-compact.sh` block is currently ~390 chars; adding 30 brings it to ~420 — well under the 120-token cap declared in `claude-code-plugin::Token budget`. Hermes `system_prompt_block` is hard-capped at 300 chars by `Provider lifecycle method behavior` scenario; the edit MUST stay under that. `instructions.ts` is hard-capped at 800 chars by `instructions.test.ts`.

- **[Trade-off]** We do NOT capture the post-compact `compaction_summary` from opencode because the event doesn't deliver it. The in-memory accumulator gives us the pre-compact transcript instead. → **Accepted because** opencode users still get a usable summary at the compaction milestone (the rolling transcript covers what the model just compressed); they just don't get the model's own compressed version of it. Future opencode upstream changes may add the payload, at which point a follow-up can capture it.

- **[Trade-off]** Claude Code and Codex CLI's `PostCompact` stdout is NOT model-context-injected (only `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` outputs reach the model — `PreCompact`/`PostCompact` are "side effects only" per `code.claude.com/docs/en/hooks`). → **Accepted.** That's why we keep the model-context nudges in their existing locations (`post-compact.sh` for SessionStart compact + `experimental.session.compacting` for opencode + `instructions.ts` for permanent guidance + `system_prompt_block` for Hermes). PreCompact/PostCompact are pure persistence hooks.

## Migration Plan

None. Net-additive change:

- New hook entries fire only after the next plugin install/update reaches the user.
- Existing sessions and in-flight clients continue to function with the pre-change nudge-and-pray pattern until the new wiring takes effect on the next session.
- No DB migrations, no schema changes, no auth changes.

Rollback path: revert the change-introducing commit and re-archive the OpenSpec change as superseded.

## Open Questions

(None blocking — all design decisions resolved above. Implementation will verify Codex `PreCompact`/`PostCompact` stdin shape against the Codex source and adjust the shared scripts if needed.)
