## 1. Instructions block

- [x] 1.1 In `apps/server/src/mcp/instructions.ts`, rewrite `BASE` to the directive three-flow preamble (SAVE / RECALL / SUMMARIZE) citing `memory.save`, `memory.context`/`memory.search`, `memory.session_summary`, and the `memory.about` pointer — final text path-scoped 879, unscoped 977 (summary structure kept inline; `summary≤${SUMMARY_MAX_CHARS}` interpolation preserved).
- [x] 1.2 Raise `INSTRUCTIONS_MAX_LENGTH` from 800 to 1000.
- [x] 1.3 Update the file's top comment to state that the cap is a self-imposed token budget, NOT a client/protocol limit (MCP defines no max length for `InitializeResult.instructions`).
- [x] 1.4 Verified both variants ≤1000 (path 879, unscoped 977) — confirmed by `instructions.test.ts` in task 3.4.

## 2. Tool descriptions

- [x] 2.1 In `apps/server/src/mcp/server.ts`, strengthen the `memory.session_summary` description: replace "Call this BEFORE saying done/listo" with "at the end of every turn that did real work — never end a working turn silent"; keep the Args/Body/`memory.session_end` detail.
- [x] 2.2 In `apps/server/src/mcp/server.ts`, strengthen the `memory.context` description: add the continuation triggers (starting/resuming work, after `/compact`, "what did we do") and the on-demand condition (only if prior detail is missing).
- [x] 2.3 Leave the `memory.save` description unchanged (already proactive).

## 3. Tests

- [x] 3.1 Update `apps/server/src/mcp/instructions.test.ts`: change the cap assertion 800 → 1000 for both variants. Also fixed `mcp-integration.test.ts` (two hardcoded `800` → `1000`).
- [x] 3.2 Update/confirm content-substring assertions: `memory.save`, `memory.context`, `memory.session_summary`, `memory.about`, `memory.search`, `2000`, `title`, `before`, scope notes — plus a new on-demand-recall assertion (`if you lack prior detail`).
- [x] 3.3 Confirm the assertion that the session-summary trigger is NOT bound solely to the literal "done" (updated to `before ending any working turn`).
- [x] 3.4 Ran `instructions.test.ts` (12/12) + full `src/mcp` + `mcp-integration.test.ts` (130/130).

## 4. Hermes nudging surface (separate from MCP instructions)

- [x] 4.0a Verify against upstream Hermes source whether `system_prompt_block` is capped/truncated: `agent/memory_manager.py::build_system_prompt` filters empties and joins with no length/token cap → the 300-char cap is self-imposed, not a contract.
- [x] 4.0b Rewrite `system_prompt_block()` in `apps/plugin/.hermes-plugin/__init__.py` to return the byte-identical server `BASE` (unified SAVE/RECALL/SUMMARIZE flows, 776 chars); update its comment to document the sync requirement.
- [x] 4.0c Raise Hermes's self-imposed cap 300 → 1000 (test) to match `INSTRUCTIONS_MAX_LENGTH`; update canonical `hermes-agent-plugin/spec.md` (unified text, cap 1000, self-imposed) + add the delta spec.
- [x] 4.0d Fix the stale "system_prompt_block is a no-op" line in `apps/plugin/.hermes-plugin/README.md`.
- [x] 4.0e Run `tests/test_system_prompt_block.py` + `tests/test_lifecycle_calls.py` (14/14) with `PYTHONPATH=tests`.

## 5. Tool-review findings (correctness + polish)

- [x] 5.1 Fix `create:true` → `autocreate:true` at the runtime surface (`instructions.ts` `UNSCOPED_NOTE`); confirm both variants still ≤1000 and tests pass.
- [x] 5.2 De-drift the three non-normative spec occurrences: `claude-code-plugin/spec.md` ×2 (bootstrap + mid-session switch, the latter corrected to `confirmSwitch:true`), `sessions/spec.md` ×1.
- [x] 5.3 Sharpen `memory.capture_passive` description (explicit wrap-up / Key Learnings trigger).
- [x] 5.4 Sharpen `memory.session_start` description (host registers the session automatically; agent normally should not call it).

## 6. Validation & sweep

- [x] 6.1 `pnpm run typecheck` + `pnpm run lint` clean.
- [x] 6.2 `pnpm test` green (full suite: TS workspaces + Hermes Python suite). Re-run after the tool-review edits.
- [x] 6.3 `openspec validate strengthen-memory-protocol-instructions --strict` passes.
- [x] 6.4 Byte-identical parity verified between `instructions.ts::BASE` and Hermes `system_prompt_block()` (776 == 776).
- [x] 6.5 Real initialize handshake covered by `mcp-integration.test.ts`: it boots a live server and connects a real MCP client to both `/mcp` and `/mcp/<slug>`, asserting the `initialize.instructions` content and ≤1000-char length on both variants. The change now also touches `apps/plugin/` (Hermes), exercised by the Hermes Python suite. A full `dev:docker:up` bring-up would only re-confirm the same served strings; available on request.
