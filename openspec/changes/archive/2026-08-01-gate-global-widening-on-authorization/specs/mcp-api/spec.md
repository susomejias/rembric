## ADDED Requirements

### Requirement: `include_global` MUST be ignored unless the connection is authorized for global reads

`memory.search` accepts `include_global` to admit `global` rows into a project-scoped result. The argument SHALL take effect only where both the connection and the token permit it, and SHALL be silently ignored otherwise — never rejected, so a client that passes it habitually degrades to project-only results instead of failing.

Two independent conditions gate it:

1. **Connection.** On a path-scoped connection the argument SHALL be ignored regardless of token scope, per the existing strict-isolation requirement. That requirement's verb is "ignored", and this requirement does not weaken it: on a connection whose slug resolves to a project, a `*` token receives that project's rows only.
2. **Token.** On a connection that reached `project` scope through `project.use` rather than a path slug, the argument SHALL take effect only when the token authorizes a global read.

The gate SHALL apply uniformly to every branch the argument reaches — the ranked lexical branch, the dense branch, and the `entity` branch — so a single call cannot be widened through one path while narrowed through another. `memory.get` gains no widening from this requirement.

This requirement governs the widening argument only, and therefore cannot constrain a connection whose *base* scope is already global. A path slug that does not resolve to an existing project currently resolves to the global scope rather than to an error, so on such a connection every read is a global read and ignoring `include_global` changes nothing. That fallback is a separate defect in scope resolution, tracked outside this requirement; until it is fixed, the isolation guarantees above hold for a path-scoped connection whose slug resolves.

#### Scenario: Path-scoped connection with a full-access token

- **GIVEN** a path-scoped connection at `/mcp/foo` whose slug resolves to an existing project, with a token whose scope is `*`, and at least one memory with `scope = 'global'`
- **WHEN** the client calls `memory.search` with `include_global = true`
- **THEN** the response SHALL contain no memory whose `scope = 'global'`

#### Scenario: `project.use` scope with an authorized token

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `*`, which has called `project.use({slug: 'foo'})`
- **WHEN** the client calls `memory.search` with `include_global = true`
- **THEN** global memories SHALL be returned alongside project `foo`'s own, and no other project's memories SHALL be returned

#### Scenario: `project.use` scope with a project-restricted token

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `project:<id of foo>`, which has called `project.use({slug: 'foo'})`
- **WHEN** the client calls `memory.search` with `include_global = true`
- **THEN** the call SHALL succeed and the response SHALL contain no memory whose `scope = 'global'`

#### Scenario: The entity branch is gated identically

- **GIVEN** a global memory and a project memory both linked to the same entity value, on a path-scoped connection
- **WHEN** the client calls `memory.search` with that `entity` and `include_global = true`
- **THEN** only the in-scope project memory SHALL be returned
