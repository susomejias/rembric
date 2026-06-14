## Why

Across many real sessions the agent ends without saving anything, never loads prior context on a continuation, and skips the end-of-session summary — even though `initialize.instructions` already names the tools. The current block is terse, low-salience, and binds `memory.session_summary` to the literal word "done" (trivially evaded). We want the protocol-teaching surface to drive proactive `memory.save` / `memory.context` / `memory.session_summary` behavior **without** spending tokens pointlessly (recall stays on-demand — no speculative `memory.context` payload at session start).

## What Changes

- **Rewrite `initialize.instructions`** (`apps/server/src/mcp/instructions.ts`) into a directive preamble with three labeled proactive flows — **SAVE** (the moment something noteworthy happens, don't batch to session end), **RECALL** (starting/resuming work, after `/compact`, or "what did we do" — on-demand, only if detail is missing), **SUMMARIZE** (close every working turn, never end silent) — each citing its tool(s): `memory.save`, `memory.context`/`memory.search`, `memory.session_summary`, plus the `memory.about` update pointer. Both variants validated: path-scoped 858, unscoped 956.
- **Raise `INSTRUCTIONS_MAX_LENGTH` 800 → 1000** with a comment recording that the cap is a self-imposed token budget, NOT a client/protocol limit (the MCP spec defines no max length for `InitializeResult.instructions`).
- **Strengthen two tool descriptions** (`apps/server/src/mcp/server.ts`): `memory.session_summary` moves from the weak "Call this BEFORE saying done/listo" trigger to "at the end of every turn that did real work — never end a working turn silent"; `memory.context` adds the continuation triggers (starting/resuming work, after `/compact`, "what did we do", load on-demand if detail is missing). `memory.save` is already proactive ("Call this IMMEDIATELY after…") and is left unchanged.
- **Update `instructions.test.ts`** to assert the new 1000-char cap and the new/required content substrings.
- **Unify Hermes onto the same nudge text.** Hermes does NOT consume `initialize.instructions`; it injects its own `system_prompt_block()` (`apps/plugin/.hermes-plugin/__init__.py`), a hardcoded string still carrying the old "before declaring work done" phrasing. Rewrite it to return the **byte-identical server `BASE`** (the same SAVE/RECALL/SUMMARIZE flows, 776 chars) and **raise Hermes's self-imposed cap 300 → 1000** to match `INSTRUCTIONS_MAX_LENGTH` — one unified nudge for every client. The 300 was confirmed self-imposed, NOT a Hermes contract: upstream `agent/memory_manager.py::build_system_prompt` joins provider blocks with no truncation/length/token cap, so the full text is injected verbatim.

**Surface coverage (corrected):** Claude Code, Codex CLI, and opencode receive the nudge via the shared MCP `initialize.instructions` block; Hermes receives the same text via its own in-process `system_prompt_block()`. Both surfaces carry ONE unified version under the same 1000-char self-imposed budget. The two copies are byte-identical but physically separate (server TS constant vs in-process Python — no cross-language sharing is possible); content tests on both sides guard against drift.

- **Fix the `create:true` → `autocreate:true` bug** (a tool-review finding). The real `project.use` parameter is `autocreate` (schema + handler + the `tools.ts` error message); four sites told the agent to pass the non-existent `create:true`, silently ignored → the project would NOT be created. Corrected at the runtime surface (`instructions.ts` `UNSCOPED_NOTE`) and three non-normative spec example/scenario lines (`claude-code-plugin/spec.md` ×2, `sessions/spec.md` ×1). The `claude-code-plugin` mid-session-switch example also had the wrong mechanism (switching is `confirmSwitch:true`, not create) and is corrected.
- **Sharpen two tool descriptions lacking a "when to call" trigger** (tool-review polish): `memory.capture_passive` gains an explicit trigger (wrap-up / Key Learnings list, instead of many `memory.save` calls); `memory.session_start` is clarified to note the host registers the session automatically, so the agent normally should not call it.

No load-bearing invariant is touched (append-only, scope-at-service, `topic_key`, judgment freshness all unaffected).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `mcp-api`: the `initialize.instructions` requirement changes — the character cap moves 800 → 1000; the content requirements are restated to mandate the three labeled proactive flows (SAVE/RECALL/SUMMARIZE), the proactive (non-"done"-bound) session-summary trigger, the continuation/recall + post-compact `memory.context` trigger, and the `memory.about` pointer, all fitting within the new 1000-char cap in both variants.
- `plugin-session-protocol`: the protocol-nudge requirement is updated to reference the 1000-char cap (was 800) and the proactive, non-"done"-bound `memory.session_summary` phrasing.
- `hermes-agent-plugin`: the `Provider lifecycle method behavior` requirement is updated so `system_prompt_block` returns the unified nudge (byte-identical to the server `initialize.instructions` BASE — the proactive SAVE/RECALL/SUMMARIZE flows, non-"done"-bound), and its cap is raised 300 → 1000 to match `INSTRUCTIONS_MAX_LENGTH` — now documented as a self-imposed budget (verified against upstream `build_system_prompt`), not a Hermes contract.

## Impact

- `apps/server/src/mcp/instructions.ts` — rewrite `BASE`; raise `INSTRUCTIONS_MAX_LENGTH` to 1000 + clarifying comment.
- `apps/server/src/mcp/server.ts` — strengthen `memory.session_summary` and `memory.context` tool descriptions.
- `apps/server/src/mcp/instructions.test.ts` — new cap (1000) + content-substring assertions.
- `apps/plugin/.hermes-plugin/__init__.py` — `system_prompt_block()` returns the unified BASE text (776 chars, ≤1000), byte-identical to the server.
- `apps/plugin/.hermes-plugin/tests/test_system_prompt_block.py` — cap 300 → 1000 + proactive/non-"done" content assertions.
- `apps/plugin/.hermes-plugin/README.md` — corrected the (stale) "system_prompt_block is a no-op" line.
- `apps/server/src/mcp/server.ts` — also: `create:true`→`autocreate:true` (none here; runtime fix is in `instructions.ts`); sharpened `memory.capture_passive` + `memory.session_start` descriptions.
- `apps/server/src/mcp/instructions.ts` — `UNSCOPED_NOTE`: `create:true` → `autocreate:true`.
- `openspec/specs/claude-code-plugin/spec.md`, `openspec/specs/sessions/spec.md` — non-normative accuracy de-drift: `create:true` → `autocreate:true` (and the mid-session-switch example corrected to `confirmSwitch:true`). No behavior change; edited directly (no delta spec), like a typo fix.
- `openspec/specs/mcp-api/spec.md` — modified instructions requirement + scenarios (800 → 1000).
- `openspec/specs/plugin-session-protocol/spec.md` — modified nudge requirement (cap 800 → 1000, proactive phrasing).
- `openspec/specs/hermes-agent-plugin/spec.md` — modified `system_prompt_block` requirement (unified text, cap 300 → 1000, reframed as self-imposed).
- No runtime behavior beyond the string content; no DB, no migration, no HTTP endpoint. Because it now touches `apps/plugin/`, the change ships on the unified `plugin` release track (not server-only); the server-side string change ships on the `server` track and rebuilds the Docker image as usual.
