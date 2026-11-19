## Context

`strengthen-memory-protocol-instructions` (D4) made recall on-demand: `memory.context` costs about 2–4k tokens, so the server tells the agent to load it only when it lacks prior detail, never speculatively on every session start. The first-prompt relevance instruction came later, so that sessions without a recall keyword still look for prior work. It is a host-side, fixed instruction: `prompt-search.sh`, the shared core and Hermes `_RELEVANCE_HINT`.

The SessionStart line ("If this is a continuation of recent work, call memory.context") predates both. Nothing reconciled the three, and the agent resolves the conflict in favor of not calling.

## Goals / Non-Goals

**Goals:** one unambiguous recall instruction on turn 1, keeping the D4 guard against blind loads, plus a name for the tool-search step that deferred-tool hosts need.

**Non-Goals:**

- No server-side prefetch.
- No change to the first-prompt line.
- No change to the post-compact block.
- No raise of either length cap.

## Decisions

**D1 — Reconcile D4, do not revoke it.** A speculative load is one that no signal justifies: a call with no `focus` and no host hook asking for it. A host hook asking for a focused call on turn 1 is a signal, and so is the user's prompt that `focus` carries. The server surfaces now say so explicitly. The guard sentence stays verbatim in the description, and `if you lack prior detail` stays in the `RECALL:` line, so a connection with no host plugin keeps the D4 behaviour.

- _Alternative — delete "speculatively":_ rejected. It discards a deliberate token-cost decision to fix a wording collision.

**D2 — SessionStart stops issuing a recall instruction.** For every new session id, turn 1 is already covered by the first-prompt line, and a second, conditional line is what created the escape hatch. The remaining cases:

- `fork` carries a new session id (`claude-code-plugin`), so the first-prompt counter starts at 1 and the line fires. `clear` is expected to behave the same way, but this change did not measure it.
- `resume` of the same id within the same `$TMPDIR`: the bash first-prompt counter (`$TMPDIR/rembric-relevance-prefetch/<id>`) is already past 1, so no recall instruction fires at all. This was measured in the e2e: on the resumed turn `prompt-search.sh` and `prompt-nudge.sh` both emitted nothing, whereas the control arm still printed the old conditional line. This is the one real behaviour removal in the change, and it is accepted: the resumed conversation's transcript is in context, and `memory.context` stays available on demand through the unchanged `RECALL:` rule.
- `compact` runs `post-compact.sh`, not `session-start.sh`. Its block keeps "Missing detail? memory.context or memory.search." and is unaffected. A test now asserts it explicitly, and the e2e observed the block unchanged in both arms.

**D3 — The deferred-tools hint lives in SessionStart, not in the first-prompt line.**

- **Budget:** the first-prompt line is 125 of its 140 bytes, and a tool-search clause does not fit without raising the budget. The SessionStart line was freed by D2 and fits in 93 of its 100 bytes.
- **Reach:** SessionStart is bash, so it reaches Claude Code and Codex only. The first-prompt line also reaches opencode, Pi and Hermes, which do not defer MCP tools; Pi registers the server's tools itself.
- **Wording:** generic and conditional ("If … deferred, load them via tool search"), with no `select:` tool name. Tool names differ between a plugin install (`mcp__plugin_rembric_rembric__*`) and a plain MCP install, and a host that does not defer tools can ignore the line.

- _Alternative — put it in the first-prompt line:_ rejected. It needs a budget raise, and it delivers an inapplicable instruction to three clients.

**D4 — Reclaim, do not raise, `INSTRUCTIONS_MAX_LENGTH`.** The unbound variant measured 1479 of 1500 before this change, and `or a host hook asks` adds 20. Dropping `long-term ` and `may ` from the opening line reclaims 14, which leaves the worst variant at 1485. The opening line keeps both pinned substrings (`only what you write to it outlives this conversation`, `never wait for them`) and its loop framing.

## Risks / Trade-offs

- The fix depends on the model acting on clearer text, so it is probabilistic. Unit tests prove the strings and that no copies drift. A real-host e2e proves that the hooks deliver them. Only repeated real sessions can show the recall rate.
- `resume` of the same session id gets no turn-1 recall line (D2). This is a deliberate trade, because the transcript is present.
