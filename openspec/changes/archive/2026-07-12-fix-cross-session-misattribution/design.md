## Context

`findActiveForTransport(tokenId, projectId)` (`apps/server/src/db/repositories/agent-sessions-repository.ts`) is the fallback `resolveSessionId`/`resolveActiveSessionId` use to auto-attach an MCP write to a session when the caller supplied no explicit `sessionId` and no `SessionRouter` entry exists for the transport. It queries for `status='active'` rows matching `(tokenId, projectId)`, ordered by `started_at DESC`, and returns the first one. `memory.session_start`'s own "reuse an existing session instead of minting a new one" logic calls the same method.

Under concurrency (two sessions from different clients, or two windows of the same client, active at once under one token) this silently picks whichever started more recently — with no signal at all about which client is actually making the current call. Confirmed live: a Claude Code session and an opencode session both active under one token, and an opencode-originated `memory.session_summary` call landed on the Claude Code row.

## Goals / Non-Goals

**Goals:**

- Stop silent misattribution to the wrong concurrently-active session.
- Change nothing about the common (single active session) case — it must keep auto-attaching with zero effort from the client, exactly as today.
- Minimize new surface area: ideally a single function, no new client-side code, no new schema.

**Non-Goals:**

- Precise disambiguation _between_ two concurrently active sessions (i.e. correctly picking the _right_ one when there are two). That requires a real correlation signal between the calling MCP connection and the calling client's own already-known session id — the reverted design below solved this, at a real complexity cost this proposal declines to pay given the alternative (below) closes the actual harm.
- Any change to the model-facing tool schema (`sessionId` remains an optional explicit argument on the affected tools, unchanged).

## Decisions

### 1. "Ambiguous → no attachment", not "ambiguous → best guess"

`findActiveForTransport` now fetches up to 2 matching rows (not 1) and returns a result only when exactly one came back. Two or more active rows for the same `(tokenId, projectId)` is the definition of "ambiguous" — the method now treats that identically to "no active session", which every caller already handles gracefully (`memory.save`/`memory.confirm` persist with `session_id = NULL`; `memory.session_start`'s reuse logic falls through to minting a fresh session instead of adopting an ambiguous one).

This is a **correctness improvement, not a workaround**: the prior behavior could actively misattribute (worse than no attachment at all, since a wrong session's summary/memories are harder to notice and undo than a missing one).

### 2. Rejected: a bridge-instance correlation mechanism (full disambiguation)

A first version of this change designed and fully implemented a mechanism to _correctly_ resolve the ambiguous case instead of giving up on it: the MCP bridge (`rembric-bridge.mjs`) would generate a random per-connection instance id, write it to a local file keyed by a sanitized project cwd, and forward it as a header (`X-Rembric-Bridge-Instance`) fixed for the connection's lifetime (necessary because `mcp-remote`'s `--header` values are frozen at process spawn — verified by reading its source). Each client's existing HTTP session-lifecycle code (hook scripts, the opencode plugin, the Hermes provider) would read the same file and tag its POSTs with the id, and the server would persist it on a new `agent_sessions.bridge_instance_id` column, consulting it as a higher-precedence signal than the ambiguous fallback.

It worked and was tested end-to-end (server + all four clients), but was reverted after reconsidering the cost/benefit: it touches a new DB column, a new HTTP header, a new local file format, and four separate client codebases (five including the shared bridge) to correctly resolve a case that — per the research below — comparable tools don't even attempt to resolve. That is a lot of new, cross-language surface area for a benefit (correct attachment _during_ genuine concurrency, a comparatively rare condition) that this decision's Alternative 3 achieves without any of it, by simply not guessing.

### 3. Comparable tools don't attempt this at all — informs, doesn't dictate, the scope here

Investigated two comparable memory tools (`Gentleman-Programming/engram`, `rohitg00/agentmemory`) for how they handle the same class of problem. Both expose `session_id` as an explicit, optional MCP tool argument with a description telling the model what to pass, and fall back to a fixed, non-session-specific bucket (e.g. `manual-save-{project}`) when omitted — they never attempt to infer "the" currently active session from transport state, concurrent or not. This is a materially simpler design than even the "ambiguous → null" fix here, but it's also a bigger behavior change than this proposal's scope: today, Rembric's tools already auto-attach correctly with zero model effort in the (overwhelmingly common) unambiguous case, and this proposal preserves that property. Adopting the explicit-argument model would mean giving that up even in the easy case, which no one has asked for and isn't necessary to fix the reported bug.

**Alternative considered and rejected**: use the MCP `initialize` handshake's `clientInfo.name` to distinguish callers (a "cheap" idea raised before the reverted mechanism above). Verified by reading `mcp-remote`'s source: it always declares itself as `{name: "mcp-remote", version}` regardless of the actual upstream host, so Claude Code, Codex, and opencode (all fronted by the shared bridge, which shells out to `mcp-remote`) are server-side indistinguishable via this field. Not viable without patching a third-party dependency.

## Risks / Trade-offs

- **[Trade-off]** During genuine concurrency (two+ active sessions under one token), auto-attachment stops working entirely for that window — saves/summaries land with `session_id = NULL` (or `memory.session_start` mints a new session) instead of attaching to any specific one. **Accepted because**: this is strictly better than the prior behavior (attaching to the wrong one silently), the condition is comparatively rare, and an agent that cares can still pass an explicit `sessionId` — the tool schema already supports it, unchanged by this proposal.
- **[Risk]** Existing tests pinned the old "most recent wins" behavior as intended (`agent-sessions.test.ts`, `memory-tools.test.ts`). **Mitigation**: both rewritten to assert the new "ambiguous → null" contract; a new test added for the two-active-sessions case specifically.

## Migration Plan

1. Change `findActiveForTransport`'s query + return contract (see Decision 1).
2. Update the two tests that encoded the old behavior; add the new ambiguous-case test.
3. No data migration, no schema change, no client/plugin changes.
4. Rollback is a plain revert; no persisted state depends on the new behavior (a session that would have been guess-attached under the old code simply stays `session_id = NULL` under the new one — reverting resumes the old guess).
