## Why

Issue #548. With two or more `active` sessions on the same token and project, `memory.session_summary` and `memory.session_end` called without `sessionId` refuse with `session_not_found`: "no active session on this MCP transport and no sessionId was provided". The message is false: there are several sessions, not none. The server instructions then route `session_not_found` to `memory.session_start`. Under the same ambiguity that call cannot adopt a row, so it mints one with `agent: 'unknown'`, and the retried summary is written to that row permanently, since sessions are append-only and `agent` is immutable. The host's real session never gets its summary.

Reproduced at the MCP handler boundary with a control. With one active session, the summary attaches and `memory.session_start` reports `reused: true`. With two, the summary is refused with `session_not_found`, `memory.session_start` reports `reused: false` with `agent: 'unknown'`, the retry lands on the new row, and both real rows keep `summary = NULL`.

The cause is at the repository boundary. `findActiveForTransport` and `findSoleActiveForReuse` both run `LIMIT 2` and collapse zero rows and two-or-more rows into the same `undefined`, so no caller can tell absence from ambiguity.

## What Changes

- Refuse the ambiguity case with a new code, `session_ambiguous`, on `memory.session_summary` and `memory.session_end`, with a message that names the remedy (the caller's own `sessionId`) and rules out `memory.session_start`. It reveals no candidate rows.
- Keep `session_not_found` and its message for true absence, including a sole row idle past the staleness window, which `memory.session_start` adopts.
- Classify through a new `AgentSessionsService.resolveForTransport`, backed by one repository read (`findActiveCandidates`, `LIMIT 2`). The two existing sole-or-nothing lookups now delegate to that read and keep their results.
- Name `session_ambiguous` in the `memory.session_end` description. The `memory.session_summary` description has no room under `DESCRIPTION_MAX_LENGTH` (about 32 characters free), so the refusal message carries the remedy for that tool.
- The server instructions are unchanged. With a distinct code, their `session_not_found→memory.session_start` line no longer fires under ambiguity, and the 1500-character cap leaves 21 characters, too few for a useful clause.

Rejected: choosing among the candidates by recency. Two terminals working at once is the case that matters, and a wrong pick is permanent (`sessions`, "`findActiveForTransport` MUST NOT guess under concurrent ambiguity"). Rejected: listing the candidates in the error. The agent reaches this branch because it does not know its own id, so it would guess, and the list would expose other sessions' ids. Making the client carry its session identity is the real improvement and is a separate change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: MODIFIED "The MCP server MUST expose four session-lifecycle tools that keep no per-connection binding". It adds the refusal classification for `memory.session_summary` and `memory.session_end` without `sessionId`, and four scenarios.
- `sessions`: ADDED "Transport resolution MUST distinguish absence from ambiguity".

## Impact

- `packages/db/src/repositories/agent-sessions-repository.ts`: adds `findActiveCandidates`; the two lookups delegate to it.
- `packages/core/src/services/agent-sessions.ts`: adds `resolveForTransport` and `TransportResolution`.
- `packages/mcp/src/session-tools.ts`: `resolveLifecycleTarget` replaces `resolveSessionId` for the two tools. `packages/mcp/src/server.ts`: `memory.session_end` description.
- Tests: `packages/mcp/src/session-tools.test.ts`, `apps/web/src/test/mcp-tool-surface.test.ts`.
- No schema change, no migration, no plugin change. A client that matched `session_not_found` from these two tools under ambiguity now sees `session_ambiguous`. The shipped plugins call session lifecycle over HTTP, not through these tools.
