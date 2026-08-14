## ADDED Requirements

### Requirement: Per-transport in-process state MUST be evicted once its transport is stale

Two in-process registries are keyed per MCP transport and today have no removal path: `SessionRouter.entries` (`apps/server/src/server/session-router.ts`), whose `clearSession` only nulls `rembricSessionId` and never removes the entry, and `McpTransportManager.sessions` (`apps/server/src/mcp/transport.ts`), whose entry — a whole `{ McpServer, StreamableHTTPServerTransport }` pair — is removed only from `onclose`, which an ungraceful disconnect never fires. Both therefore grow with the process's uptime rather than with the number of live connections.

**One rule, one threshold, both registries.** Eviction SHALL be governed by `TRANSPORT_STALENESS_MS` (`apps/server/src/services/agent-sessions.ts`), the threshold that already decides when an `active` session row stops being a candidate for transport resolution. No second constant, no separate environment variable and no per-registry policy SHALL be introduced: the process's in-process view of a transport and the database's view of the session behind it expire on the same clock, and a second knob is a second thing that can disagree with the first.

**A transport is stale when both clocks say so.** Within one `TRANSPORT_STALENESS_MS` window ending now, a transport is stale if and only if:

1. it has handled no MCP request, **and**
2. no _live_ session row exists for any identity that transport carries, where live means `status = 'active'`, `deleted_at IS NULL`, and `COALESCE(last_activity_at, started_at)` inside the window — the same effective-activity expression the retirement passes and transport resolution already use.

Both conditions are required. Condition 2 alone would evict a live client that has no session row at all (a generic MCP client, a read-only connection); condition 1 alone is a bare idle timeout, which would evict a client whose host is demonstrably working, since the session-lifecycle HTTP writes bump `last_activity_at` on every turn while the model may call no MCP tool for far longer than the window. The check for condition 2 SHALL be an existence test and SHALL NOT inherit `findActiveForTransport`'s refusal to resolve under two-or-more matches: that refusal exists to avoid _choosing_ a session, and eviction chooses nothing, so inheriting it would evict exactly the transports carrying the most live sessions.

**State whose transport is already gone is evicted with no window at all.** A `SessionRouter` entry whose `mcp-session-id` is absent from `McpTransportManager.sessions` SHALL be evicted on the next pass regardless of either clock. No request can be served under an id the transport manager does not hold, so such an entry cannot influence any future resolution. This is the ordinary state left behind by a client that disconnected cleanly.

**Router state SHALL NOT be evicted while its transport is live.** Both registries' state for one transport SHALL be evicted in the same pass, or neither. A missing router entry does not fail a request — scope resolution falls back to the default project — so removing an entry that carries a roots-derived or `project.use` project pin, while its transport can still serve a tool call, would silently redirect that connection's writes into the default project, into append-only rows that no verb can reassign.

**The pass SHALL run on an existing process-wide periodic pass, and SHALL NOT depend on new session traffic.** It SHALL NOT introduce a new timer or a cron, and SHALL NOT be gated on a session start: a server whose clients have all vanished is exactly the state that retains this memory, and a session-start-triggered sweep would never reclaim it. Which existing pass hosts it is an implementation choice; that it runs periodically without traffic is the contract.

**`SessionRouter.discoveryInFlight` is explicitly NOT part of this requirement.** It is bounded by construction: its single production writer registers the promise and removes it in a `finally` on every settled attempt, so it holds concurrently in-flight roots-discovery attempts only, never cumulative distinct sessions. It SHALL NOT gain an eviction hook — the promise is identity-checked on removal precisely because deleting a live one is a correctness bug, not a leak fix.

#### Scenario: A transport that goes silent on both clocks is evicted from both registries

- **GIVEN** a transport with a `SessionRouter` entry and a `McpTransportManager.sessions` entry
- **AND** its last MCP request and its session row's effective last activity are both older than `TRANSPORT_STALENESS_MS`
- **WHEN** the periodic pass runs
- **THEN** the `SessionRouter` entry for that `(tokenId, mcp-session-id)` SHALL be removed
- **AND** the `McpTransportManager` entry for that `mcp-session-id` SHALL be removed and its transport closed
- **AND** the entries belonging to a concurrently live transport SHALL remain present

#### Scenario: A quiet transport whose session row is live is NOT evicted

- **GIVEN** a transport that has handled no MCP request for longer than `TRANSPORT_STALENESS_MS`
- **AND** an `active`, non-soft-deleted session row for its identity whose effective last activity is inside the window (for example, kept fresh by session-lifecycle HTTP writes)
- **WHEN** the periodic pass runs
- **THEN** neither registry's entry for that transport SHALL be removed

#### Scenario: A busy transport with no session row at all is NOT evicted

- **GIVEN** a transport that has never registered a session, so no session row exists for its identity
- **AND** it handled an MCP request within `TRANSPORT_STALENESS_MS`
- **WHEN** the periodic pass runs
- **THEN** neither registry's entry for that transport SHALL be removed

#### Scenario: Router state outliving a cleanly-closed transport is evicted without waiting

- **GIVEN** a client that disconnected cleanly, so `onclose` removed its `McpTransportManager` entry while its `SessionRouter` entry remained
- **WHEN** the periodic pass runs, even though less than `TRANSPORT_STALENESS_MS` has elapsed
- **THEN** the orphaned `SessionRouter` entry SHALL be removed

#### Scenario: A pinned project survives every pass while its transport is live

- **GIVEN** a path-less transport that resolved a project through roots discovery or `project.use`
- **AND** it keeps making scope-resolving tool calls
- **WHEN** the periodic pass runs any number of times
- **THEN** every subsequent call SHALL still resolve to the pinned project with its original resolution source
- **AND** SHALL NOT fall back to the default project

#### Scenario: Reclamation does not require a session start

- **GIVEN** a process holding state for transports that have all gone stale
- **AND** no new session is started and no MCP request arrives
- **WHEN** the periodic pass runs
- **THEN** the stale entries SHALL be evicted

#### Scenario: The registries end up bounded by live transports, not by uptime

- **GIVEN** a process that has served many transports which disconnected ungracefully, plus at least one live transport
- **WHEN** the periodic pass runs
- **THEN** each registry SHALL hold exactly the entries of the transports that are still live
- **AND** that count SHALL be greater than zero, so an empty result cannot be mistaken for a passing assertion

#### Scenario: The in-flight discovery map keeps no eviction hook

- **WHEN** the test suite inspects `SessionRouter`
- **THEN** the eviction pass SHALL NOT remove entries from `discoveryInFlight`
- **AND** a discovery attempt in flight across a pass SHALL still be removed by its own `finally`, exactly once
