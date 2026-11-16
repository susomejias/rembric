## MODIFIED Requirements

### Requirement: Slug resolution cascade order

The provider SHALL resolve the project slug in `initialize` using this strict precedence chain. The chain SHALL stop at the first source that yields a slug that matches the regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` (identical to the bridge's regex in `apps/plugin/mcp-bridge/`):

1. The `PROJECT_SLUG` value parsed from the nearest `.rembric` at or above `<kwargs.cwd>`, stopping after the checkout root when `<kwargs.cwd>` is inside a git work tree and checking only `<kwargs.cwd>` outside one, using the same dotenv-style parser as the bridge: trim whitespace, skip blank lines and lines starting with `#`, accept `KEY=VALUE`, and strip matched outer single or double quotes from the value.
2. `REMBRIC_PROJECT_SLUG` resolved through `agent.secret_scope.get_secret` at initialization — a profile-scoped fallback default for a cwd that has no valid `.rembric` slug.
3. Inside a git work tree only: the slug `POST /api/repositories/resolve` returns for the repository's fingerprint, computed and resolved as the `repository-binding` capability specifies.
4. `None` — degraded mode, session initialization emits a diagnostic and all session-related POSTs are skipped. The server URL SHALL NOT supply a fallback slug. An unbound, ambiguous or unavailable fingerprint outcome SHALL also end here, with the diagnostic naming that outcome.

This order matches the `requires_env` manifest's own description of `REMBRIC_PROJECT_SLUG` ("Default project slug. Overridden per-cwd if a .rembric file is present.") — a user who sets the scoped default once via Hermes and then works across multiple repos, each with its own `.rembric`, gets correct per-repo project scoping instead of every repo silently collapsing onto the one profile-configured project. Process environment SHALL NOT be consulted as a fallback source.

The resolved slug SHALL be validated against the slug regex; non-matching candidates SHALL be discarded and the cascade continues to the next source. The provider SHALL resolve once, in `initialize`, and SHALL keep the outcome for the session.

#### Scenario: .rembric wins over env

- **WHEN** scoped `REMBRIC_PROJECT_SLUG=alpha` is set and `<cwd>/.rembric` contains `PROJECT_SLUG=gamma`
- **THEN** the provider resolves the slug as `gamma`

#### Scenario: env wins when no .rembric file is present

- **WHEN** `<cwd>/.rembric` does not exist, scoped `REMBRIC_PROJECT_SLUG=alpha` is set, and scoped `REMBRIC_SERVER_URL=https://memory.example.com/mcp/delta`
- **THEN** the provider resolves the slug as `alpha`

#### Scenario: URL path is not a slug source

- **WHEN** `.rembric` and the scoped default slug are both absent, `<kwargs.cwd>` is outside any git work tree, and scoped `REMBRIC_SERVER_URL=https://memory.example.com/mcp/delta`
- **THEN** the provider resolves no slug and skips session POSTs

#### Scenario: Invalid candidate is skipped

- **WHEN** `<cwd>/.rembric` contains `PROJECT_SLUG=Has_Underscores` (does not match the slug regex) and scoped `REMBRIC_PROJECT_SLUG=gamma` is set
- **THEN** the provider rejects the `.rembric` value and resolves the slug as `gamma`

#### Scenario: All sources empty yields None

- **WHEN** no source produces a valid slug
- **THEN** the provider's resolved slug is `None`
- **AND** all session-related POSTs in subsequent lifecycle calls are skipped silently

#### Scenario: A `.rembric` at the checkout root applies to a subdirectory

- **WHEN** `<kwargs.cwd>` is `/work/shop/src` inside a checkout rooted at `/work/shop`, and `/work/shop/.rembric` contains `PROJECT_SLUG=shop`
- **THEN** the provider resolves the slug as `shop`

#### Scenario: A bound fingerprint resolves when no slug source is set

- **WHEN** `<kwargs.cwd>` is inside a git checkout with no `.rembric`, no scoped `REMBRIC_PROJECT_SLUG` is set, and the resolve endpoint answers `bound` with slug `shop`
- **THEN** the provider resolves the slug as `shop`

#### Scenario: An unbound fingerprint skips session POSTs

- **WHEN** `<kwargs.cwd>` is inside a git checkout with no slug source and the resolve endpoint answers `unbound`
- **THEN** the provider's resolved slug is `None`, its diagnostic names the unbound repository, and all session-related POSTs are skipped
