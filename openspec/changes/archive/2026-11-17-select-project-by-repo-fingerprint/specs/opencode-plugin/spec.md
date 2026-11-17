## MODIFIED Requirements

### Requirement: Slug resolution uses the .rembric convention shared across clients

The bridge spawned by opencode SHALL resolve the project with the cascade the `repository-binding` capability defines: the nearest `.rembric` up to the checkout root, parsed for `PROJECT_SLUG=<slug>` from dotenv-style lines (mirroring `_api.sh::rembric_read_project_slug` and the published `mcp-bridge` contract), then `REMBRIC_PROJECT_SLUG`, then, inside a git work tree, the repository fingerprint.

The plugin's runtime event handlers (that POST directly to `/api/<slug>/sessions/...` over HTTP, bypassing MCP) SHALL resolve the project once per session through the shared resolver in `apps/plugin/mcp-bridge/rembric-project.mjs`, which reads `.rembric` with `readRembricSlug` from `apps/plugin/mcp-bridge/rembric-dotenv.mjs` — the same functions the bridge uses. This guarantees byte-identical resolution semantics (same dotenv grammar, same regex, same `.rembric` walk, same fingerprint and same fail-silent miss behaviour) without duplicating the implementation.

The plugin SHALL NOT fall back to git-remote-derived slugs, `package.json::name`, or repository-directory basename. If no step of the cascade yields a project — or the repository is unbound, ambiguous or without fingerprint — the resolver returns no slug, the plugin's `disabled || !slug` short-circuit fires inside `rembricPost`, and lifecycle POSTs are skipped silently (one stderr diagnostic line emitted at plugin startup when the env vars are present but slug resolution fails).

#### Scenario: Plugin reads .rembric for HTTP lifecycle calls

- **GIVEN** opencode running in `/home/user/repo-a` with `/home/user/repo-a/.rembric` containing `PROJECT_SLUG=repo-a`
- **WHEN** the plugin's `session.created` handler fires
- **THEN** the handler reads `/home/user/repo-a/.rembric`
- **AND** validates `repo-a` against `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`
- **AND** POSTs to `${REMBRIC_SERVER_URL}/api/repo-a/sessions` with `Authorization: Bearer ${REMBRIC_API_TOKEN}`

#### Scenario: Plugin no-ops cleanly when .rembric is missing

- **GIVEN** opencode running in `/home/user/no-rembric-here`, outside any git work tree, with no `.rembric` file and no `REMBRIC_PROJECT_SLUG`
- **WHEN** the plugin's `session.created` handler fires
- **THEN** the handler writes one stderr line of the form `[rembric] no project slug for session <id>; skipping session POST`
- **AND** SHALL NOT POST to any `/api/*` endpoint
- **AND** SHALL NOT throw or reject

#### Scenario: Plugin no-ops cleanly when slug is invalid

- **GIVEN** `.rembric` containing `PROJECT_SLUG=-leading-hyphen-invalid`
- **WHEN** the plugin's `session.created` handler fires
- **THEN** the handler writes one stderr line indicating the slug did not match the regex
- **AND** SHALL NOT POST to any `/api/*` endpoint

#### Scenario: TypeScript readRembricSlug matches bridge byte-for-byte

- **GIVEN** a test fixture `.rembric` containing trailing-whitespace variants, `#`-prefixed comment lines, quoted values, and `PROJECT_SLUG=valid-slug`
- **WHEN** the unit test calls `readRembricSlug('<fixtureDir>')` AND calls the bridge's dotenv parser on the same file
- **THEN** both return the same slug value

#### Scenario: A bound fingerprint scopes the lifecycle calls

- **GIVEN** opencode running in a git checkout with no `.rembric` whose fingerprint is bound to `shop`
- **WHEN** the plugin's `session.created` handler fires
- **THEN** the handler POSTs to `${REMBRIC_SERVER_URL}/api/shop/sessions`

#### Scenario: An unbound checkout posts nothing

- **GIVEN** opencode running in a git checkout with no `.rembric` and an unbound fingerprint
- **WHEN** the plugin's `session.created` handler fires
- **THEN** the handler SHALL NOT POST to any `/api/<slug>/` endpoint
