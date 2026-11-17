## MODIFIED Requirements

### Requirement: A path-less bridge connection MUST resolve to the default project, and a new slug MUST be created from the dashboard

When the bridge falls back to path-less `/mcp` outside a git work tree — no `.rembric`, a parse failure, no `PROJECT_SLUG`, or an invalid slug — the connection SHALL resolve to the server's default project for its whole life. Inside a git work tree there is no such fallback: a checkout that no `.rembric`, `REMBRIC_PROJECT_SLUG` or bound fingerprint resolves is unbound, or gets no connection at all, as the `repository-binding` and `mcp-bridge` capabilities specify. The plugin SHALL NOT rely on MCP roots discovery or on any tool call to select another project: the server does neither, and no tool can switch a connection's project. The bridge's stderr diagnostic SHALL name the fix (a `.rembric` file containing `PROJECT_SLUG=<slug>`, or `REMBRIC_PROJECT_SLUG`), as the `mcp-bridge` capability specifies.

When the bridge path-scopes the URL with a slug that does not yet correspond to a Rembric project, every scope-resolving tool SHALL be refused with `project_not_found`, and the refusal SHALL point to the dashboard. The project SHALL be created from the dashboard, or by an admin token through `project.create`, after which subsequent tool calls on the same URL find it; the plugin's model-facing text SHALL NOT instruct the agent to create or switch a project.

To work in another project the operator changes `.rembric` (or `REMBRIC_PROJECT_SLUG`), or an admin changes the repository's binding, and starts a new host session; there is no in-session override.

#### Scenario: No slug means the default project

- **GIVEN** a project directory outside any git work tree with no `.rembric` and no `REMBRIC_PROJECT_SLUG`, and a host that advertises the `roots` capability
- **WHEN** the agent calls `memory.save` through the plugin
- **THEN** the row SHALL carry the default project's `project_id`
- **AND** the server SHALL NOT have sent `roots/list` to the host

#### Scenario: A new slug is created from the dashboard, not by the agent

- **GIVEN** `.rembric` containing `PROJECT_SLUG=brand-new` and no project with that slug
- **WHEN** the agent calls `memory.search` through the plugin
- **THEN** the call SHALL be refused with `project_not_found`, the refusal SHALL point to the dashboard, and no `projects` row SHALL be inserted
- **AND** after the operator creates `brand-new` from the dashboard, the same call on the same URL SHALL succeed against it

#### Scenario: An unbound checkout does not reach the default project

- **GIVEN** a git checkout with no `.rembric`, no `REMBRIC_PROJECT_SLUG`, and an unbound fingerprint
- **WHEN** the agent calls `memory.save` through the plugin
- **THEN** the call SHALL be refused with `project_unbound`
- **AND** no row SHALL carry the default project's `project_id`
