## ADDED Requirements

### Requirement: Scoped repository reads MUST require a Scope parameter, not merely a naming convention

Data-access confinement is enforced by a grep gate that matches call sites by method-name prefix: `admin*` reads are callable only from the dashboard, `unsafe*` marks a deliberate cross-scope read. A repository read that is unscoped but carries **neither** prefix is invisible to that gate, so an unscoped aggregate can be served from the MCP layer while the invariant test passes — which is the case today for the session status count consumed by `memory.stats`.

Every repository read reachable from the MCP layer SHALL take the `Scope` as a required parameter, so omitting it is a type error rather than a naming oversight. An unscoped variant SHALL exist only under the `admin` prefix, bringing it inside the confinement gate.

#### Scenario: An unscoped aggregate is renamed into the gate

- **WHEN** an unscoped session-count read exists
- **THEN** it SHALL carry the `admin` prefix and SHALL be callable only from the dashboard layer

#### Scenario: The MCP layer cannot omit scope

- **WHEN** an MCP handler calls a scoped repository read
- **THEN** the read SHALL require the `Scope` argument, so a scope-less call fails to compile
