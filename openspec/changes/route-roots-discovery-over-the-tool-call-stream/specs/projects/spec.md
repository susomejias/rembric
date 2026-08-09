## MODIFIED Requirements

### Requirement: Project auto-detection via MCP `roots` MUST be read-only

When a client advertises `capabilities.roots` at `initialize` and the URL path is `/mcp` (no slug), the server SHALL call `roots/list`, derive a candidate slug from the basename of the first root (lowercase ASCII, non-`[a-z0-9-]` characters replaced with `-`, trimmed of leading/trailing `-`), and activate an _existing_ project with that slug. Auto-detection SHALL NOT create new projects.

**Delivery obligation.** The `roots/list` request SHALL be issued on a server→client stream that is registered at the moment of the send, so its delivery does not depend on request timing and does not depend on the client having opened the optional standalone server→client stream. Concretely, discovery is triggered from a tool call and the request SHALL be correlated with that in-flight tool call, whose response stream the transport registers before any handler runs. A request the transport cannot route SHALL NOT be treated as a request that was sent: the requirement is on delivery, not on the attempt.

This is stated as a property of the send rather than of any SDK symbol so the mechanism stays free, but the property is what must hold. The standalone stream is optional by the MCP client's own contract; a server that depends on it has a correctness bug that presents as a timeout, and a request routed only to an unregistered stream is discarded by the transport with no error, no `onerror` callback and no log at any layer, which is why this obligation must be specified rather than left to the implementation.

**The once-only guarantee attaches to an answered call, not to an attempt.** The server SHALL issue at most one `roots/list` per transport that produced a definitive outcome, where a definitive outcome is any of: the client returned a root list (empty or not), the client returned a JSON-RPC error, or the client advertised no `roots` capability. An attempt that produced no answer — a timeout, an undelivered request, or a transport failure — SHALL NOT consume that slot, and the next scope-resolving tool call on the same transport SHALL retry discovery.

The unconditional variant is what makes a single lost message permanent: the sentinel is per `(tokenId, mcpSessionId)` and the resolver short-circuits on it, so a connection whose one attempt was discarded resolves to the default project for the remainder of its life, with `project.current` reporting an empty `suggestedSlugs` so the agent cannot self-diagnose. Because `memory` rows are append-only with no reassignment verb and `agent_sessions.project_id` is immutable, every row that connection writes is misfiled permanently. `notifications/roots/list_changed` is not a recovery path: it updates suggestions only and never activates a project.

The `roots/list` budget SHALL be a bounded timeout, and the specified behaviour on expiry is unchanged (silent fall-through). The shipped budget is 2500 ms. This requirement SHALL NOT be read as endorsing any particular value: once the delivery obligation above holds, a compliant client answers far inside any reasonable bound and the budget binds only a client that advertises `roots` and declines to answer.

#### Scenario: Roots resolves to an existing slug

- **GIVEN** the client returns `[{uri: 'file:///home/me/rembric'}]` from `roots/list`
- **AND** a project with `slug = 'rembric'` exists
- **WHEN** the auto-detection step runs
- **THEN** the session SHALL be scoped to that project with `source = 'roots'`

#### Scenario: Roots resolves to a slug that does not exist

- **GIVEN** the client returns `[{uri: 'file:///tmp/quick-test'}]` from `roots/list`
- **AND** no project with `slug = 'quick-test'` exists
- **WHEN** the auto-detection step runs
- **THEN** the session SHALL remain in the default project and the derived `'quick-test'` SHALL appear in `project.current.suggestedSlugs`

#### Scenario: Client does not support roots

- **WHEN** the `initialize` request advertises no `roots` capability
- **THEN** the server SHALL NOT issue `roots/list` and the session SHALL remain in the default project until an explicit `project.use` call

#### Scenario: `roots/list` times out or errors

- **WHEN** the server's `roots/list` request does not return within the discovery budget (2500 ms as shipped), or returns a JSON-RPC error
- **THEN** the auto-detection SHALL silently fall through to the default project; the connection SHALL NOT be failed

#### Scenario: Discovery succeeds while the client's standalone server→client stream is absent

- **GIVEN** an unscoped `/mcp` connection whose client advertises `capabilities.roots`
- **AND** the client's standalone GET server→client stream is **not** registered on the transport at the moment discovery runs
- **WHEN** a scope-resolving tool call triggers `roots/list`
- **THEN** the request SHALL still be delivered to the client and the discovered project SHALL be activated
- **AND** the outcome SHALL NOT depend on whether that standalone stream is ever opened

#### Scenario: A discovery attempt that produced no answer is retried on the next tool call

- **GIVEN** an unscoped `/mcp` connection on which a `roots/list` request was issued and no answer of any kind arrived
- **WHEN** a second scope-resolving tool call arrives on the same transport
- **THEN** discovery SHALL run again rather than short-circuiting on the earlier attempt
- **AND** if that second attempt answers with a root naming an existing project, the connection SHALL resolve to that project from then on

#### Scenario: An answered discovery is not re-issued

- **GIVEN** an unscoped `/mcp` connection whose `roots/list` returned a root list, an empty root list, or a JSON-RPC error
- **WHEN** further scope-resolving tool calls arrive on the same transport
- **THEN** the server SHALL NOT issue another `roots/list` for that transport
- **AND** a client advertising no `roots` capability SHALL likewise be asked at most once

#### Scenario: Roots changes mid-session via `notifications/roots/list_changed`

- **GIVEN** a session has been auto-scoped to project `'rembric'` via the initial `roots/list`
- **WHEN** the client emits `notifications/roots/list_changed` with new roots resolving to slug `'api'`
- **THEN** the server SHALL update `project.current.suggestedSlugs` to `['api']` but SHALL NOT switch the active project; the agent must explicitly call `project.use({slug: 'api', confirmSwitch: true})` to switch (which itself requires the active session to be ended first per the sessions capability)
