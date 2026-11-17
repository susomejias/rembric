## ADDED Requirements

### Requirement: Only an admin token MAY create a repository binding

Creating a repository binding SHALL require admin authority — the literal token scope `*`, as "A token reaching every project MUST NOT be an admin token" defines it — on every surface that creates one: the `project.bind_repository` MCP tool and the dashboard, whose login already requires an admin token. No other scope, membership set or project-scoped write grant SHALL create a binding, including a `.rembric` reported by a non-admin token, which only records a pending suggestion for an admin to accept.

Moving or removing a binding SHALL be possible only from the dashboard.

Resolving a fingerprint to a bound project SHALL require only read authority on that project, so teammates whose tokens may read a project use its bindings without being able to create or change them.

A token whose scope does not authorize writing SHALL NOT create or refresh pending repository rows.

#### Scenario: A project-scoped writer records a suggestion, not a binding

- **GIVEN** a token with scope `project:<id of shop>` and a checkout whose root `.rembric` contains `PROJECT_SLUG=shop`, with an unbound fingerprint
- **WHEN** a session starts with that token
- **THEN** a pending suggestion for `(fingerprint, shop)` SHALL exist
- **AND** no binding SHALL exist for the fingerprint

#### Scenario: A teammate resolves an admin's binding with a read grant

- **GIVEN** fingerprint `F` bound to `shop` by an admin, and a teammate token with scope `read:project:<id of shop>`
- **WHEN** the teammate's client resolves `F`
- **THEN** it SHALL resolve to `shop`
