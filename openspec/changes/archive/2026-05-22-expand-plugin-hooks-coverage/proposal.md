## Why

Today, the responsibility of persisting the compact summary into Rembric relies on the host agent calling `memory.session_summary` after `/compact`. Empirically that depends on the model cooperating with the nudge served by `apps/plugin/scripts/post-compact.sh` (Claude Code) and the `experimental.session.compacting` handler in `apps/plugin/.opencode-plugin/plugin.ts` (opencode). When the model skips that step, the post-compact session continues but the Rembric row is left with whatever summary was last written — typically nothing, or a stale `[auto]`-prefixed snapshot from the auto-curate safety net (PR #71 era).

Two of our four clients expose lifecycle events that let the plugin tier do this work **without depending on model cooperation**:

- **Claude Code** has `PreCompact` (fires BEFORE compaction with the full transcript still accessible via `transcript_path`) and `PostCompact` (fires AFTER compaction with the model-authored `compaction_summary` field on stdin). We wire neither today.
- **Codex CLI** has `PreCompact` and `PostCompact` too — verified against the upstream source at `codex-rs/hooks/src/engine/output_parser.rs` (`parse_pre_compact`, `parse_post_compact`). The current `codex-distribution` spec wrongly claims "Codex has no PreCompact or PostCompact event" because it was authored against the partial public docs at `developers.openai.com/codex/plugins/hooks`. The source is authoritative; we're correcting the spec.
- **opencode** has `session.compacted` as a non-experimental "after compaction" event we don't subscribe to.
- **Hermes** already handles `on_pre_compress` correctly; the gap there is in `system_prompt_block`'s text — it nudges toward `memory.session_summary` but doesn't tell the agent to call `memory.context` to recover fine detail after a compact.

Separately, opencode's plugin lacks the recall-keyword nudge that Claude Code and Codex CLI both ship in their `UserPromptSubmit` handlers (regex `remember|recall|acordate|qué hicimos|what did we do`). This is a cross-client paridad gap with a trivial fix in the existing `chat.message` handler.

## What Changes

**Six new hook wires** + **five prompt refinements**, all confined to the `apps/plugin/` tree. No server-side endpoints, no schema changes, no new HTTP routes.

### Hooks

1. **Claude Code `PreCompact`** — new entry in `apps/plugin/hooks/hooks.json`, new script `apps/plugin/scripts/pre-compact.sh`. Reads `session_id`, `cwd`, `transcript_path` from stdin; formats the transcript via the existing `_transcript.sh` helper; POSTs `/api/<slug>/sessions/<id>/summary` with `{summary, title?, final:false}`. PreCompact stdout is NOT model-context-injected so the script emits nothing.
2. **Claude Code `PostCompact`** — new entry in `apps/plugin/hooks/hooks.json`, new script `apps/plugin/scripts/post-compaction.sh`. Reads `session_id`, `cwd`, and `compaction_summary` from stdin; POSTs `/api/<slug>/sessions/<id>/summary` with `{summary: <compaction_summary>, final:false}`. PostCompact stdout is NOT model-context-injected so the script emits nothing.
3. **Codex CLI `PreCompact`** — new entry in `apps/plugin/hooks/hooks.codex.json`, **reuses** `pre-compact.sh` from #1 (same stdin contract per Codex's `parse_pre_compact`).
4. **Codex CLI `PostCompact`** — new entry in `apps/plugin/hooks/hooks.codex.json`, **reuses** `post-compaction.sh` from #2.
5. **opencode `session.compacted` branch** — extend the existing `event` dispatcher in `apps/plugin/.opencode-plugin/plugin.ts` to handle `event.type === "session.compacted"` by calling the existing `flushSessionSummary(sessionId)` helper. opencode's event delivers no `compaction_summary` payload — the plugin's in-memory accumulator already retains the full transcript cross-compact, so flushing it is the equivalent of "persist what we have at this milestone".
6. **opencode `chat.message` recall regex** — modify the existing `chat.message` handler in `plugin.ts` to detect the same recall regex used in `UserPromptSubmit` (`/remember|recall|acordate|qué hicimos|what did we do/i`) on the incoming user text, and append a nudge to `output.parts` directing the agent to call `memory.search`. Cross-client paridad with Claude Code + Codex CLI.

### Prompt refinements (text-only edits)

7. **`apps/plugin/scripts/post-compact.sh` (Claude SessionStart compact)** — sharpen point 2 of the existing imperative block from "Si necesitás más contexto: memory.context" to a stronger form making clear `memory.context` is the recovery path when the compact summary lacks detail.
8. **`apps/plugin/.opencode-plugin/plugin.ts` (`experimental.session.compacting`)** — append to the existing "CRITICAL INSTRUCTION" string a sentence about calling `memory.context` if specific detail from before compaction is needed.
9. **New `apps/plugin/scripts/pre-compact.sh` and `post-compaction.sh`** — since they're new files, they MUST start out with the right nudge discipline. But since their stdout is NOT model-context-injected (per Claude Code's hook docs), the nudges in 7/8 remain delivered via the SessionStart/compacting paths and don't need duplication here.
10. **`apps/server/src/mcp/instructions.ts`** — add one short line to the existing `initialize.instructions` block (capped 800 chars total) instructing post-compact agents to call `memory.context` when they need detail beyond the compact summary. This is the only file outside `apps/plugin/` touched by this change, and it's a docstring-level edit.
11. **`apps/plugin/.hermes-plugin/__init__.py::RembricMemoryProvider.system_prompt_block`** — extend the existing 300-char nudge to include the same "post-compact recovery path" guidance. Stays within the 300-char cap.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- **`claude-code-plugin`** — ADD `PreCompact` and `PostCompact` hook requirements; MODIFY the "four hooks at hooks.json" requirement to reflect the new total (six hooks) and remove the legacy "the prior PreCompact entry SHALL NOT be wired" clause.
- **`codex-distribution`** — MODIFY the "Codex hook configuration" requirement: correct the false "Codex has no PreCompact/PostCompact" statement (source-verified) and ADD wiring requirements for PreCompact and PostCompact reusing the shared scripts.
- **`opencode-plugin`** — MODIFY the "Event handler set" requirement to add `session.compacted` to the documented set and the chat.message recall-regex behaviour; ADD a "session.compacted handler" requirement with scenarios; MODIFY `experimental.session.compacting` nudge text requirement.
- **`hermes-agent-plugin`** — MODIFY the `system_prompt_block` behaviour line within the "Provider lifecycle method behavior" requirement to include `memory.context` post-compact recovery guidance.
- **`mcp-api`** — MODIFY the `initialize.instructions` content requirement to include a one-line memory.context post-compact pointer (within existing 800-char cap).

## Impact

**Files touched** (~14 new/modified files):

- `apps/plugin/hooks/hooks.json` — add 2 entries (PreCompact, PostCompact).
- `apps/plugin/hooks/hooks.codex.json` — add 2 entries (PreCompact, PostCompact).
- `apps/plugin/scripts/pre-compact.sh` — new file, shared by Claude + Codex.
- `apps/plugin/scripts/post-compaction.sh` — new file, shared by Claude + Codex.
- `apps/plugin/scripts/post-compact.sh` — sharpen nudge text (point 2 of imperative block).
- `apps/plugin/.opencode-plugin/plugin.ts` — add `session.compacted` branch in `event` dispatcher; add recall-regex detection in `chat.message`; extend `experimental.session.compacting` nudge text.
- `apps/plugin/.opencode-plugin/plugin.test.ts` — add tests for the three opencode changes.
- `apps/plugin/.hermes-plugin/__init__.py` — extend `system_prompt_block` returned string.
- `apps/plugin/.hermes-plugin/tests/` — add coverage for the new nudge content.
- `apps/server/src/mcp/instructions.ts` — add one-line memory.context guidance within 800-char cap.
- `apps/server/src/mcp/instructions.test.ts` — assert the new line is present and total is ≤800 chars.
- 5 spec delta files under `openspec/changes/expand-plugin-hooks-coverage/specs/`.

**No impact on**:

- Append-only memory invariant.
- Service-layer scope enforcement.
- `topic_key` convergence.
- Judgment freshness.
- The `/mcp` ↔ `/mcp/<slug>` path-scoping contract.
- The HTTP API surface (no new endpoints).
- The Rembric bridge (`rembric-bridge.mjs`) and dotenv lib (`rembric-dotenv.mjs`).
- DB schema, migrations, or service-layer code.

**Release-please consequences**:

- Shared bundle changes (`apps/plugin/hooks/`, `apps/plugin/scripts/`) trigger the `bridge-bundlers` linked-versions group → `claude-code-plugin` AND `codex-plugin` bump together.
- `apps/plugin/.opencode-plugin/plugin.ts` changes → independent `opencode-plugin` bump.
- `apps/plugin/.hermes-plugin/__init__.py` changes → independent `hermes-plugin` bump.
- `apps/server/src/mcp/instructions.ts` changes → `server` bump (handled by the existing server release-please component).

**Migration**: none. New hooks are additive — pre-existing sessions and clients without the new wiring continue to function as today.

**Rollback**: revert the commit. The new hook scripts are net-new files; the modified hooks.json/codex.json entries can be removed cleanly.
