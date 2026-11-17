## MODIFIED Requirements

### Requirement: Credentials come from the environment and the slug from `.rembric`

The extension SHALL read `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from `process.env`, matching how the Hermes plugin and the in-process side of the opencode plugin already obtain them. The harness does not inject environment variables from its own settings file, so no settings-file credential path SHALL be documented or implemented.

The project SHALL be resolved once per session through the shared resolver in `apps/plugin/mcp-bridge/rembric-project.mjs`, with the cascade the `repository-binding` capability defines: `.rembric::PROJECT_SLUG` of the nearest `.rembric` up to the checkout root, read via `readRembricSlug` from `apps/plugin/mcp-bridge/rembric-dotenv.mjs`; then `REMBRIC_PROJECT_SLUG`; then, inside a git work tree, the repository fingerprint. The extension SHALL NOT parse `.rembric` itself, SHALL NOT declare its own slug regex and SHALL NOT compute the fingerprint itself. Because the extension speaks MCP without the bridge, it SHALL itself add the `X-Rembric-Repo-Fingerprint` header to every MCP request inside a git work tree, and SHALL connect path-less only on an `unbound` answer, as the `repository-binding` capability requires.

When either environment variable is absent the extension SHALL disable itself, SHALL emit exactly one one-line stderr diagnostic naming which configuration is missing, and SHALL NOT break the host harness. The diagnostic SHALL NOT include the token.

Stderr is not visible in the harness's TUI, so a disabled extension is otherwise indistinguishable from a working one: the operator sees it load, sees its prompt templates, and gets no tools and no reason. The extension SHALL therefore also surface the reason through the harness's own notification channel, at `warning` severity when configuration is missing and `error` severity when the handshake fails. The notification SHALL NOT include the token. Where the harness supplies no notification channel the extension SHALL fall back to stderr alone rather than throw, since the channel is a diagnostic and its absence SHALL NOT cost the operator a working extension.

The reason string SHALL come from `createSessionProtocol`, which already derives it to write the stderr line; the extension SHALL NOT re-derive which configuration is missing, so a reason added to the shared core cannot be misreported here.

#### Scenario: Missing credentials disable the extension without breaking the host

- **GIVEN** `REMBRIC_API_TOKEN` is unset
- **WHEN** the harness loads the extension and starts a session
- **THEN** exactly one stderr line SHALL be emitted naming the missing configuration
- **AND** the line SHALL NOT contain any token value
- **AND** the session SHALL proceed with no Rembric tools registered and no thrown error

#### Scenario: A disabled extension says so in the harness UI, not only on stderr

- **GIVEN** `REMBRIC_API_TOKEN` is unset
- **WHEN** the harness loads the extension and starts a session
- **THEN** exactly one notification SHALL be raised at `warning` severity naming the missing configuration
- **AND** the notification SHALL NOT contain any token value

#### Scenario: A failed handshake says so in the harness UI

- **GIVEN** the configured address accepts connections and never answers
- **WHEN** the harness starts a session
- **THEN** one notification SHALL be raised at `error` severity reporting that the tools are unavailable
- **AND** the notification SHALL NOT contain any token value

#### Scenario: A harness without a notification channel still loads

- **GIVEN** the harness supplies no notification channel on the session context
- **AND** `REMBRIC_API_TOKEN` is unset
- **WHEN** the harness loads the extension and starts a session
- **THEN** the stderr diagnostic SHALL still be emitted
- **AND** no error SHALL be thrown out of the handler

#### Scenario: Slug resolution uses the shared parser

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** it imports its project resolution from the shared `rembric-project.mjs` module
- **AND** it declares no local `function parseDotenv`, no local `SLUG_RE` and no local `git rev-list` invocation

**Amendment for the bridge move:** The canonical shared dotenv module is now `apps/plugin/mcp-bridge/rembric-dotenv.mjs`, because it is shipped in the published zero-dependency bridge package. The extension SHALL import `readRembricSlug` from `../mcp-bridge/rembric-dotenv.mjs`; no `apps/plugin/mcp-bridge/rembric-dotenv.mjs` copy SHALL remain. The rest of this requirement, including the scenarios above, is unchanged.

#### Scenario: An unbound checkout says so in the harness UI

- **GIVEN** a git checkout with no `.rembric`, no `REMBRIC_PROJECT_SLUG`, and an unbound fingerprint
- **WHEN** the harness starts a session
- **THEN** one notification SHALL be raised at `warning` severity stating that the repository is not bound to a project
- **AND** every MCP request SHALL carry `X-Rembric-Repo-Fingerprint` and no session SHALL be registered
