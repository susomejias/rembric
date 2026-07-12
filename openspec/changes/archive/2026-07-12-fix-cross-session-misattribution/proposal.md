## Why

When two agent sessions are concurrently active under the same token+project (a normal occurrence given Rembric's multi-client design — e.g. a Claude Code window and an opencode window open on the same project at once), any MCP tool call that auto-resolves its target session (`memory.save`, `memory.confirm`, `memory.session_summary`, `memory.session_start`) silently attaches to the wrong one. The fallback query (`findActiveForTransport`) picks "the most recently started active session for this token+project" with no way to know which client actually made the call. Confirmed live: an opencode-originated `memory.session_summary` call was mislabeled onto a concurrently-active Claude Code session.

An earlier version of this proposal designed a full disambiguation mechanism (a stable per-connection "bridge instance id" written to a local correlation file by the MCP bridge, read by each client's HTTP session-lifecycle code, forwarded as a request header, and joined server-side via a new `bridge_instance_id` column). It was implemented and tested end-to-end, then reverted: research into two comparable tools (`engram`, `agentmemory`) showed neither attempts precise auto-attachment under concurrency at all — they expose `session_id` as an explicit, model-supplied tool argument with a generic per-project fallback bucket when omitted, sidestepping the ambiguity rather than resolving it. Neither their approach nor the reverted one was adopted outright; instead, this proposal keeps Rembric's existing zero-effort auto-attach contract exactly as-is for the common (unambiguous) case, and closes the actual harm — wrong attribution — with a minimal change to the one query where it originates.

## What Changes

- `AgentSessionsRepository.findActiveForTransport` returns `undefined` — never a guess — when more than one active session matches `(tokenId, projectId)`. It already returns the correct row when exactly one matches (the common case, unaffected) and `undefined` when none match (unaffected). The only behavior change is the two-or-more-matches case: previously "most recently started wins" (sometimes wrong), now "no attachment" (never wrong, occasionally absent).
- No new database column, no new HTTP header, no new client-side code in any of the four clients (Claude Code, Codex, opencode, Hermes), no new correlation mechanism. This is a single-function, server-only change.
- `memory.session_start`'s existing "reuse an existing session" logic calls this same method, so it inherits the fix automatically: under genuine concurrency it now mints a fresh session instead of reusing an ambiguous one, rather than needing a separate change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `sessions`: `findActiveForTransport`'s contract is tightened to require the match to be unambiguous (exactly one active row), returning no result rather than an arbitrary one when it isn't.

## Impact

- `apps/server/src/db/repositories/agent-sessions-repository.ts` — `findActiveForTransport` fetches up to 2 candidate rows instead of 1 and returns `undefined` unless exactly one came back.
- `apps/server/src/services/agent-sessions.test.ts` — updated the test that pinned the old "most recent wins" behavior; added a test for the new "two matches → null" case.
- `apps/server/src/mcp/memory-tools.test.ts` — updated the test that pinned the old behavior for `memory.save`'s auto-attach path.
- `openspec/specs/sessions/spec.md` — requirement delta for `findActiveForTransport`'s tightened contract.
