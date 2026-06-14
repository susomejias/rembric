## Context

`initialize.instructions` is the only protocol-teaching surface served to all four clients (Claude Code, Codex CLI, Hermes Agent, opencode) on MCP connect — Claude/Codex via hook stdout and the in-process providers via the MCP block itself. Hermes has no per-turn hook, so the MCP block is its _only_ nudging lever. Today the block is terse and binds `memory.session_summary` to the literal word "done"; in practice the agent under-fires save, recall, and summary.

Crucially, the nudge does NOT reach all four clients through one surface. Claude Code, Codex CLI, and opencode consume the MCP `initialize.instructions` block. **Hermes does not** — it injects its own in-process `system_prompt_block()` (a `MemoryProvider` method), a hardcoded string parallel to (and historically drifting from) `initialize.instructions`. Any cross-client nudge change must update BOTH surfaces.

Two delivery surfaces exist for "when to call a tool":

- **`initialize.instructions`** — injected into the system prompt preamble; primes awareness + proactivity; one shared block under a self-imposed character cap.
- **Each tool's `description`** — read at tool-selection time; no shared budget; the precise "call me when X" home.

The cap (`INSTRUCTIONS_MAX_LENGTH = 800`) is self-imposed. The MCP spec (`InitializeResult.instructions`, 2025-06-18) defines the field as an optional free-form string with **no** maximum length, size limit, or truncation rule, and no consuming client among the four enforces one.

## Goals / Non-Goals

**Goals:**

- Make the agent proactively `memory.save` (the moment something noteworthy happens), `memory.context`/`memory.search` (on continuation/recall), and `memory.session_summary` (every working turn).
- Spend tokens only with reason: recall stays on-demand — no speculative `memory.context` payload loaded at session start.
- Cover all four clients through the single shared block; no per-client divergence.

**Non-Goals:**

- No hook/script changes, no new HTTP endpoint, no per-prompt network reads.
- No forced/unconditional `memory.context` load at session start (the speculative-payload "phantom cost" path).
- No change to any load-bearing invariant.
- No separate, abbreviated Hermes nudge: both surfaces carry ONE unified text (see D7).

## Decisions

**D1 — Guidance lives in BOTH the instructions preamble and the tool descriptions (belt-and-suspenders).**
The preamble primes the _self-initiated_ behaviors the agent skips (save, summarize) and frames proactive use; the descriptions carry the precise per-tool triggers read at the decision point. A small amount of duplication between the two _aids_ instruction-following and is accepted deliberately.

- _Alternative — preamble only:_ rejected; the system-prompt block is low-salience for the moment-of decision, which is exactly why the current block under-fires.
- _Alternative — descriptions only (slim the preamble to a pointer):_ considered and drafted (fit in 601 chars, no cap bump). Rejected in favor of the fuller block because the operator prioritized adherence over token frugality and the descriptions are only read once the model already considers a tool — the preamble is what makes it consider memory at all.

**D2 — Raise `INSTRUCTIONS_MAX_LENGTH` 800 → 1000.**
Justified because the block is now the primary mechanism and the directive labeled flows need the room (path-scoped 858, unscoped 956). A clarifying comment records that the cap is a self-imposed token budget, not a client/protocol limit, so a future reader does not mistake it for a hard constraint.

- _Alternative — keep 800 and compress:_ the directive three-flow version does not fit 800 in the unscoped variant (the longer scope note leaves ~9 chars). Compressing to fit would sacrifice the clarity that is the whole point.
- _Alternative — 900:_ sufficient for an earlier draft, but 1000 leaves headroom (≥44 chars) so a minor future wording tweak does not breach the test.

**D3 — Labeled flows SAVE / RECALL / SUMMARIZE.**
Explicit labels make the three actions scannable as discrete behaviors rather than prose, which reads as higher-priority instruction. Mechanical detail (`scope_locked` codes, `topic_key` semantics, candidate/judge wiring) stays in the descriptions, keeping the preamble behavioral.

**D4 — RECALL is on-demand, never blind-at-start.**
The continuation trigger fires "before acting, if you lack prior detail" — the expensive `memory.context` payload (~2–4k tokens) loads only when the task is actually a continuation, never speculatively at session start (where the agent cannot yet know the task relates to prior work). This is the resolution of the phantom-token-cost concern.

**D5 — `memory.session_summary` description retriggered off "done".**
The current "Call this BEFORE saying done/listo" lets the agent evade the summary by simply not saying "done". The new phrasing binds it to "the end of every turn that did real work — never end a working turn silent", aligning the description with the (already-spec'd) intent in `mcp-api` that the trigger must not bind solely to the literal "done".

**D6 — `memory.save` description unchanged.**
It already reads "Call this IMMEDIATELY after: bug fix · …" — already proactive; touching it would be churn.

**D7 — Hermes's `system_prompt_block()` returns the SAME unified nudge as the server BASE; its cap is raised 300 → 1000 to match.**
Hermes does not consume `initialize.instructions`, so the server-side rewrite alone would leave Hermes on the old "before declaring work done" phrasing — drift, and the exact "done"-bound trigger we're removing. Since the 300-char cap was verified self-imposed (upstream `agent/memory_manager.py::build_system_prompt` joins provider blocks with NO truncation/length/token cap — it only filters empties and joins), there is no reason to maintain a separate, abbreviated Hermes string. We instead return the byte-identical server `BASE` (the SAVE/RECALL/SUMMARIZE flows, 776 chars) and raise the Hermes cap to 1000 to match `INSTRUCTIONS_MAX_LENGTH`. One canonical nudge for every client.

- _Alternative — keep a separate ≤300 abbreviated Hermes block:_ rejected by the operator — since 300 was our own limit (not a Hermes constraint), maintaining two divergent texts is needless surface for drift. The BASE fits comfortably (776/1000) and Hermes injects it verbatim.
- _Alternative — truly share one string across TS and Python:_ impossible without a build/codegen or runtime-fetch step (server TS constant vs in-process Python shipped to the client). Rejected as over-engineering; the repo already accepts deliberate cross-language duplication (`parseDotenv`/`SLUG_RE` per CLAUDE.md). We keep the two copies byte-identical and guard drift with content tests on both sides.
- _Alternative — leave Hermes untouched and ship server-only:_ rejected; it ships a known inconsistency (Hermes keeps the weak "done" trigger) and would force the proposal/design to disclaim Hermes coverage.

**D8 — Fold in two tool-review findings (correctness + description polish).**
Reviewing all 22 tool descriptions while in this surface surfaced: (a) a real bug — four sites instruct the agent to pass `project.use({create:true})`, but the schema parameter is `autocreate`, so the flag is silently ignored and the project is never created; (b) two descriptions (`memory.capture_passive`, `memory.session_start`) with no clear "when to call" trigger. Both are folded in because they share the same surface and theme (teaching the agent to call the right tool the right way) and the fixes are small.

- The `create→autocreate` runtime fix lands in `instructions.ts` (in scope). The three spec occurrences are corrected as **non-normative accuracy de-drift** via direct edit (the parameter was always `autocreate`; no behavior changes), rather than spinning up delta specs for `claude-code-plugin`/`sessions` for what is a typo-class correction — same treatment as a prior de-brand edit.
- _Alternative — separate changes for the bug and the polish:_ rejected by the operator; one coherent "tool clarity" pass is cheaper to review than three fragments.

## Risks / Trade-offs

- **[Trade-off] Duplication between preamble and descriptions** → Accepted because redundancy across the priming surface (system prompt) and the decision surface (tool description) measurably helps instruction-following, which the operator explicitly prioritized over token economy here.
- **[Trade-off] Larger instructions block costs ~150 more tokens per connect, every client, every session** → Accepted: the operator opted into 900–1000 provided it improves quality; recall staying on-demand means the _expensive_ payload cost is unchanged (zero speculative loads).
- **[Risk] Low salience — instructions are still ambient text the agent may ignore** → Mitigation: this is the cheapest, reversible first intervention; the strengthened descriptions reinforce at the decision point. If telemetry later shows it is insufficient, escalate to higher-salience hook nudges (deliberately deferred, not built now).
- **[Risk] Two surfaces drift apart again** (the original defect: `initialize.instructions` was improved while Hermes's `system_prompt_block` kept the old "done" phrasing) → Mitigation: both are updated in this change, both are covered by content tests (`instructions.test.ts` + `tests/test_system_prompt_block.py`) that assert the proactive, non-"done" phrasing, so a future regression on either surface fails CI. The two strings can't be DRY-shared (one is server-side TS, the other in-process Python shipped to the client), so test parity is the guard.
- **[Risk] Cap bump invites future doc-creep back toward an over-long block** → Mitigation: the comment frames 1000 as a budget ceiling, and `instructions.test.ts` keeps both variants gated at ≤1000.

## Migration Plan

Two coordinated string changes plus test updates, on two release tracks: the `initialize.instructions` rewrite ships on the `server` track (Docker image rebuild); the Hermes `system_prompt_block()` rewrite ships on the unified `plugin` track. Rollback = revert the commit; no data, schema, or wire-format implications. No client coordination needed — MCP clients pick up the new instructions on their next connect, and Hermes picks up the new block on its next plugin load.

## Open Questions

(none)
