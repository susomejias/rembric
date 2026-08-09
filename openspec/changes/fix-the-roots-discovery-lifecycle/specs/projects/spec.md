## MODIFIED Requirements

### Requirement: Project auto-detection via MCP `roots` MUST be read-only

When a client advertises `capabilities.roots` at `initialize` and the URL path is `/mcp` (no slug), the server SHALL call `roots/list`, derive a candidate slug from the basename of the first root (lowercase ASCII, non-`[a-z0-9-]` characters replaced with `-`, trimmed of leading/trailing `-`), and activate an _existing_ project with that slug. Auto-detection SHALL NOT create new projects.

**Delivery obligation.** The `roots/list` request SHALL be issued on a server→client stream that is registered at the moment of the send, so its delivery does not depend on request timing and does not depend on the client having opened the optional standalone server→client stream. Concretely, discovery is triggered from a tool call and the request SHALL be correlated with that in-flight tool call, whose response stream the transport registers before any handler runs. A request the transport cannot route SHALL NOT be treated as a request that was sent: the requirement is on delivery, not on the attempt.

This is stated as a property of the send rather than of any SDK symbol so the mechanism stays free, but the property is what must hold. The standalone stream is optional by the MCP client's own contract; a server that depends on it has a correctness bug that presents as a timeout, and a request routed only to an unregistered stream is discarded by the transport with no error, no `onerror` callback and no log at any layer, which is why this obligation must be specified rather than left to the implementation.

**The once-only guarantee attaches to an answered call, not to an attempt.** The server SHALL issue at most one `roots/list` **for discovery purposes** per transport that produced a definitive outcome, where a definitive outcome is any of: the client returned a root list (empty or not), the client returned a JSON-RPC error, or the client advertised no `roots` capability. An attempt that produced no answer — a timeout, an undelivered request, or a transport failure — SHALL NOT consume that slot, and the next scope-resolving tool call on the same transport SHALL retry discovery. The `roots/list` a `notifications/roots/list_changed` refresh issues is not discovery — it can only write suggestions — and is governed by its own requirement below; it SHALL neither consume nor release this slot.

The unconditional variant is what makes a single lost message permanent: the sentinel is per `(tokenId, mcpSessionId)` and the resolver short-circuits on it, so a connection whose one attempt was discarded resolves to the default project for the remainder of its life, with `project.current` reporting an empty `suggestedSlugs` so the agent cannot self-diagnose. Because `memory` rows are append-only with no reassignment verb and `agent_sessions.project_id` is immutable, every row that connection writes is misfiled permanently. `notifications/roots/list_changed` is not a recovery path: it updates suggestions only and never activates a project.

**The discovery slot is per-transport state, and SHALL be owned by the connection rather than by the process.** No transport's discovery state SHALL be readable, writable or clearable from another transport, and the number of `roots/list` requests a client receives SHALL NOT depend on how many other connections the process is serving. Ownership SHALL be structural rather than by convention: the state SHALL live with the per-connection server instance so it is released when that instance is, and SHALL NOT live in a module-level registry that outlives every transport it describes.

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
- **WHEN** further scope-resolving tool calls arrive on the same transport, and no `notifications/roots/list_changed` has been received on it
- **THEN** the server SHALL NOT issue another `roots/list` for that transport
- **AND** a client advertising no `roots` capability SHALL likewise be asked at most once
- **AND** a `notifications/roots/list_changed` received on a DIFFERENT transport SHALL NOT cause another `roots/list` on this one

#### Scenario: Roots changes mid-session via `notifications/roots/list_changed`

- **GIVEN** a session has been auto-scoped to project `'rembric'` via the initial `roots/list`
- **WHEN** the client emits `notifications/roots/list_changed` with new roots resolving to slug `'api'`
- **THEN** the server SHALL update `project.current.suggestedSlugs` to `['api']` but SHALL NOT switch the active project; the agent must explicitly call `project.use({slug: 'api', confirmSwitch: true})` to switch (which itself requires the active session to be ended first per the sessions capability)
- **AND** the update SHALL be observable on the first scope-resolving tool call that follows the notification, including the `project.current` call that reads it, because the refreshing `roots/list` must be correlated with an in-flight tool call to be deliverable; the notification alone SHALL NOT be required to have produced it

## ADDED Requirements

### Requirement: The `roots/list_changed` refresh MUST be per-transport, advisory, and delivered under a tool call

On `notifications/roots/list_changed`, the server SHALL re-derive the candidate slug for **only the transport that emitted the notification** and SHALL record it as a suggestion. The refresh SHALL NOT activate, switch or clear a project, and SHALL NOT alter any other transport's state in any way.

The refreshing `roots/list` SHALL be issued under an in-flight tool call, on the same terms as discovery's delivery obligation above. A notification handler has no in-flight tool call to correlate with, so the refresh SHALL be performed by the first scope-resolving tool call that follows the notification rather than by the handler itself; the handler SHALL only record that a refresh is due.

**One notification earns at most one attempt.** The refresh obligation SHALL be discharged by the attempt, not by an answer: a refreshing `roots/list` that times out, errors or is never answered SHALL NOT be retried, and SHALL leave nothing pending. This is deliberately the inverse of the discovery slot's rule, and the difference is justified by the difference in consequence — a lost discovery misscopes every append-only row the connection writes, whereas a lost refresh leaves one stale advisory slug that activates nothing. Retrying it would make every subsequent tool call on a silent client pay the full `roots/list` budget for the life of the connection.

Where the transport has no answered discovery yet when the notification arrives, ordinary discovery SHALL run instead of a refresh — the `roots/list` it is about to issue already reflects the new roots — and the pending refresh SHALL be discharged by it.

#### Scenario: A `list_changed` on one transport does not re-ask another

- **GIVEN** two live `/mcp` transports A and B, each with an answered `roots/list` and each scoped to its own project
- **WHEN** A emits `notifications/roots/list_changed` and B then makes a scope-resolving tool call
- **THEN** B's client SHALL receive no further `roots/list` request
- **AND** B's resolved project, its `project.current.source`, and its `project.current.suggestedSlugs` SHALL all be unchanged

#### Scenario: A refresh neither spends nor discards the answered discovery slot

- **GIVEN** a transport whose `roots/list` was answered and whose client then stops answering
- **WHEN** the client emits `notifications/roots/list_changed` and then makes several scope-resolving tool calls
- **THEN** at most one further `roots/list` SHALL be issued on that transport in total
- **AND** no tool call after the first SHALL wait on the `roots/list` budget
- **AND** the connection SHALL keep the project its answered discovery activated

#### Scenario: A refresh updates suggestions and never activates

- **GIVEN** a transport with no active project whose roots now resolve to the slug of an existing project
- **WHEN** `notifications/roots/list_changed` is followed by a scope-resolving tool call
- **THEN** the derived slug SHALL appear in `project.current.suggestedSlugs`
- **AND** the resolved project SHALL still be the default one, with `source` reporting the default fallback rather than `'roots'`

#### Scenario: A refresh whose roots are empty or underivable clears the suggestion list

- **GIVEN** a transport carrying a non-empty `project.current.suggestedSlugs` from an earlier derivation
- **WHEN** `notifications/roots/list_changed` is followed by a scope-resolving tool call, and the client answers `roots/list` with an empty list or with a URI from which no valid slug can be derived
- **THEN** `project.current.suggestedSlugs` SHALL become empty rather than retaining the stale slug

#### Scenario: A `list_changed` arriving before any answered discovery runs ordinary discovery

- **GIVEN** an unscoped transport whose discovery slot is unconsumed because its first `roots/list` produced no answer
- **WHEN** `notifications/roots/list_changed` arrives and a scope-resolving tool call follows
- **THEN** ordinary discovery SHALL run, and SHALL be permitted to activate the discovered project
- **AND** exactly one `roots/list` SHALL be issued for that tool call, not one for discovery and another for the refresh

#### Scenario: The refreshing `roots/list` is delivered while the standalone stream is absent

- **GIVEN** a transport whose client never opens the standalone GET server→client stream
- **WHEN** `notifications/roots/list_changed` is followed by a scope-resolving tool call
- **THEN** the refreshing `roots/list` SHALL reach the client and the refreshed suggestion SHALL be observable on that same tool call's `project.current`

#### Scenario: Per-transport discovery state is not a process-global registry

- **WHEN** the test suite inspects the roots-discovery module
- **THEN** it SHALL find no module-level mutable registry of per-transport state
- **AND** no exported helper whose purpose is to clear such a registry for all transports at once
