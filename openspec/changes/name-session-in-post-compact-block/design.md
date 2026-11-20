## Context

The post-compaction block is the only instruction the agent gets at the compaction boundary (`plugin-session-protocol`, "The post-compaction instruction SHALL direct the model to read the stored summary and then rewrite the session's current state in full"). It names the session symbolically, as `sessionId`. The value lives in two other places: the turn-1 `sessionIdTemplate` line, and the server's sole-active-session fallback when no id is passed. The first does not reliably survive compaction. The second refuses to guess when two sessions are active, by design (`sessions`, "`findActiveForTransport` MUST NOT guess under concurrent ambiguity").

## Evidence

Claude Code 2.1.329 in an interactive pty, scratch `CLAUDE_CONFIG_DIR`, `ENABLE_TOOL_SEARCH=true`, local dev server, and every inherited `CLAUDE_*` variable unset. Auto-compaction was forced with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` and a first turn that reads four ~16k-token filler files before writing a note, so the compaction fires in the middle of real work. Arms were interleaved. The unit is one compaction. Instruments: a logging MCP proxy (each `tools/call`, by time window from each `post-compact.sh` firing) and the session transcript. "Id lost" means the literal id does not appear in the host's compaction summary outside the transcript path the summary quotes.

Sonnet, first compaction of each run:

| Block                                | id kept in summary | id lost   |
| ------------------------------------ | ------------------ | --------- |
| symbolic (current)                   | 2/2 acted          | **0/9**   |
| id in both calls (704 B, over cap)   | 4/4 acted          | 1/1 acted |
| id in the read, `sessionId` in write | 1/1 acted          | **3/5**   |

"Acted" means both `memory.session_get_batch` and `memory.session_summary` were called with the right id between that compaction and the next one (or the end of the run). Every non-acting compaction in the table made no Rembric call at all.

The last row is this change. Its hook printed output byte-identical to this change's `post-compact.sh` for the same stdin. The other hook scripts in every arm were `main`'s.

The id-lost column is the counterfactual. For the text this change ships, symbolic 0/9 against 3/5, Fisher exact one-sided p = 0.027. Pooling both literal-id variants gives 0/9 against 4/6, p = 0.011. Opus kept the id in every compaction summary across 13 runs and called `memory.session_get_batch` with the right id after every first compaction, whatever the block, so it says nothing about the id-lost case.

The agents' stated reasons, read from the transcripts of every compaction followed by no Rembric call:

- Symbolic block (9): six say they have no session id and will not guess one. Three give no reason.
- Literal-id block (2): one says the tools were not loaded (they are deferred), one says the step is not part of the user's request. Neither mentions the id.

## Goals / Non-Goals

**Goals:** remove the agent's dependence on the id surviving compaction, without moving any byte cap and without a second copy of the text.

**Non-Goals:**

- The two residual failures above. They have different causes (deferred tools after compaction; prioritising the user's request) and need their own measurement.
- Server-side session resolution. A summary written without an id under two active sessions still answers `session_not_found`, and the `instructions` route that to `memory.session_start`, which mints a new session. That was executed separately and is not changed here. With the id in the block, this path no longer depends on it.

## Decisions

**D1 — Name the id in the read, name `sessionId` in the write.** The read gets the literal value because it is the call that otherwise cannot be made. The write names the argument rather than repeating the 36-character value. Repeating it was measured too (the "both calls" row) and acted as well, but it renders at 704 bytes, over the published 700-byte cap. The shipped form renders at 669 and is the one the last row measured.

- _Alternative — raise the cap to fit the id twice:_ rejected. Moving it is a MODIFIED edit to the token-budget requirement and the hook catalog, for a form that nothing measured favours over the shorter one.
- _Alternative — append the existing `sessionIdTemplate` line after the block:_ rejected. Untested, 204 more bytes, and it leaves `ids: [sessionId]` to be bound by the model.

**D2 — No id, no rendering.** A client without an id emits the symbolic block byte-for-byte. An empty or placeholder id would be a guess handed to the model.

**D3 — One template, three renderers, one fixture.** The template is derived from the symbolic text in the JS/TS core and in Hermes by replacing the two calls, so the shared text stays single-sourced. Bash renders with parameter expansion over the quoted heredoc, using variables for the pattern and the replacement, because bash 3.2 (macOS `/bin/bash`) keeps backslash-escaped braces in a replacement literally. The fixture test pins the rendered output of all three.

## Risks / Trade-offs

- The fix is probabilistic, like any model-facing text. It closes the failure mode the agents named, and leaves the two residual ones.
- The session id now appears in model-visible text at the compaction boundary. It already does on turn 1, and it is not a secret.
