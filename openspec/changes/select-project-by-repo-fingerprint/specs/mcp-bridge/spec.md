## MODIFIED Requirements

### Requirement: The bridge resolves the project directory and slug, and builds the path-scoped URL

The bridge SHALL resolve the project directory from a precedence chain of environment variables, in this order: `CLAUDE_PROJECT_DIR`, then `PWD`, then `process.cwd()`. The chain SHALL skip empty-string values (`||` semantics, not `??`) so that an explicitly-set-to-empty variable falls through cleanly. This is what makes the bridge usable from hosts that propagate the working directory as `PWD` rather than by Claude's convention — notably Codex, whose spawn semantics put `process.cwd()` at the plugin cache directory rather than at the user's project.

The bridge SHALL look for the nearest `.rembric`: in `${projectDir}`, then in each parent directory, stopping after the checkout root (`git rev-parse --show-toplevel`) when `${projectDir}` is inside a git work tree; outside a git work tree only `${projectDir}` is checked (see the `repository-binding` capability). For the file it finds, it SHALL parse it as dotenv-style `KEY=VALUE` lines (with `#` line comments and optional matched-quote stripping) and read `PROJECT_SLUG`. The slug SHALL be validated against `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`.

The slug cascade SHALL be, in order: the validated `PROJECT_SLUG` from the nearest `.rembric`; then a validated `REMBRIC_PROJECT_SLUG` environment variable; then, inside a git work tree only, the slug `POST /api/repositories/resolve` returns for the repository's fingerprint; then no slug. A candidate that fails validation SHALL be discarded and the cascade SHALL continue rather than aborting. The bridge SHALL resolve once, at startup, and SHALL NOT re-resolve for the life of the process. This precedence is the one `hermes-agent-plugin` already defines for its provider, adopted here rather than reinvented, so that a user who sets a default slug once and then works across repositories each carrying its own `.rembric` gets correct per-repository scoping from both surfaces.

With a resolved slug the endpoint SHALL be `${REMBRIC_SERVER_URL}/mcp/<slug>` (path-scoped); with none it SHALL be `${REMBRIC_SERVER_URL}/mcp` (path-less). Trailing slashes on the base URL SHALL be stripped. Inside a git work tree the bridge SHALL add `X-Rembric-Repo-Fingerprint` to every request it forwards, carrying the fingerprint or `unavailable`, path-scoped or not.

**Outside a git work tree**, a missing, unparseable or invalid slug SHALL NOT abort the session: the bridge writes one stderr diagnostic and continues path-less, where the connection resolves to the server's default project and stays there: no tool can switch it, and the server does not derive a project from the host's roots. That diagnostic SHALL name the fix — add a `.rembric` file containing `PROJECT_SLUG=<slug>` to the resolved project directory, or set `REMBRIC_PROJECT_SLUG` — and SHALL state that the connection uses the default project.

**Inside a git work tree** with no slug, the bridge SHALL NOT fall back to the default project. It SHALL connect path-less, with the fingerprint header, only when the resolve endpoint answered `unbound`, writing one stderr diagnostic that the repository is unbound. On any other answer — `404`, another non-2xx status, an unparseable body, a timeout or a network error — it SHALL write one stderr diagnostic naming the cause and the remedy (update the server, or add a `.rembric`) and SHALL exit non-zero without connecting.

The bridge SHALL write one diagnostic line to stderr at startup of the form `[rembric-bridge] projectDir=<dir> (from <source>) url=<url>`, where `<source>` is exactly one of `CLAUDE_PROJECT_DIR`, `PWD`, or `process.cwd()` — naming which step of the chain produced the resolved directory. This is what makes `claude --debug` and Codex log inspection able to explain a wrong project.

The bridge SHALL be the **only** JS/TS implementation of this parsing and of the project resolution: it imports the shared dotenv module rather than defining its own parser or slug regex, and the cascade above — `.rembric` walk, fingerprint computation, remote normalization and the resolve call — SHALL live in one shared module inside this package, `apps/plugin/mcp-bridge/rembric-project.mjs`, which the opencode plugin and the Pi extension import from the same path.

#### Scenario: `CLAUDE_PROJECT_DIR` wins the chain

- **WHEN** the bridge starts with `CLAUDE_PROJECT_DIR=/home/u/proj` set
- **THEN** it SHALL resolve `projectDir = /home/u/proj`
- **AND** the stderr diagnostic SHALL include `(from CLAUDE_PROJECT_DIR)`

#### Scenario: `PWD` is used when `CLAUDE_PROJECT_DIR` is unset

- **WHEN** the bridge starts with `CLAUDE_PROJECT_DIR` unset and `PWD=/home/u/proj`
- **THEN** it SHALL resolve `projectDir = /home/u/proj`
- **AND** the stderr diagnostic SHALL include `(from PWD)`

#### Scenario: An empty-string value is skipped, not treated as set

- **WHEN** the bridge starts with `CLAUDE_PROJECT_DIR=""` and `PWD=/home/u/proj`
- **THEN** it SHALL resolve `projectDir = /home/u/proj`
- **AND** the stderr diagnostic SHALL include `(from PWD)`

#### Scenario: A valid `.rembric` slug path-scopes the URL

- **GIVEN** `/home/u/proj/.rembric` containing `PROJECT_SLUG=demo` and `REMBRIC_SERVER_URL=https://memory.example.com`
- **WHEN** the bridge starts with `projectDir = /home/u/proj`
- **THEN** the endpoint SHALL be `https://memory.example.com/mcp/demo`

#### Scenario: `.rembric` beats the environment default

- **GIVEN** `REMBRIC_PROJECT_SLUG=alpha` and `<projectDir>/.rembric` containing `PROJECT_SLUG=gamma`
- **WHEN** the bridge resolves the slug
- **THEN** it SHALL use `gamma`

#### Scenario: The environment default applies when no `.rembric` resolves

- **GIVEN** no `.rembric` in the resolved project directory and `REMBRIC_PROJECT_SLUG=alpha`
- **WHEN** the bridge resolves the slug
- **THEN** it SHALL use `alpha`

#### Scenario: An invalid slug falls through instead of aborting

- **GIVEN** `<projectDir>/.rembric` containing `PROJECT_SLUG=Has_Underscores` and `REMBRIC_PROJECT_SLUG=gamma`
- **WHEN** the bridge resolves the slug
- **THEN** it SHALL discard the invalid candidate, emit one stderr diagnostic, and use `gamma`
- **AND** it SHALL NOT exit non-zero

#### Scenario: No slug at all falls back to path-less, never to an abort

- **GIVEN** no `.rembric`, no `REMBRIC_PROJECT_SLUG`, and a project directory that is not inside a git work tree
- **WHEN** the bridge starts
- **THEN** it SHALL emit one stderr diagnostic that names `.rembric` with `PROJECT_SLUG` and `REMBRIC_PROJECT_SLUG` as the fix and states that the default project is in use
- **AND** the endpoint SHALL be `${REMBRIC_SERVER_URL}/mcp`
- **AND** the session SHALL proceed, and its tool calls SHALL resolve to the server's default project

#### Scenario: The nearest `.rembric` up to the checkout root is used

- **GIVEN** a git checkout at `/home/u/shop` with `/home/u/shop/.rembric` containing `PROJECT_SLUG=shop`, and `projectDir = /home/u/shop/packages/api`
- **WHEN** the bridge resolves the slug
- **THEN** it SHALL use `shop`

#### Scenario: A bound fingerprint path-scopes the URL

- **GIVEN** a git checkout with no `.rembric`, no `REMBRIC_PROJECT_SLUG`, and a resolve endpoint that answers `bound` with slug `shop`
- **WHEN** the bridge starts
- **THEN** the endpoint SHALL be `${REMBRIC_SERVER_URL}/mcp/shop`
- **AND** every forwarded request SHALL carry `X-Rembric-Repo-Fingerprint`

#### Scenario: An unbound fingerprint connects path-less with the header

- **GIVEN** a git checkout with no `.rembric`, no `REMBRIC_PROJECT_SLUG`, and a resolve endpoint that answers `unbound`
- **WHEN** the bridge starts
- **THEN** the endpoint SHALL be `${REMBRIC_SERVER_URL}/mcp` and every forwarded request SHALL carry `X-Rembric-Repo-Fingerprint`

#### Scenario: A server without the resolve endpoint gets no connection

- **GIVEN** a git checkout with no `.rembric`, no `REMBRIC_PROJECT_SLUG`, and a server that answers the resolve endpoint with `404`
- **WHEN** the bridge starts
- **THEN** it SHALL write one stderr diagnostic naming the server update and `.rembric` as remedies and SHALL exit non-zero
- **AND** it SHALL NOT send any request to `${REMBRIC_SERVER_URL}/mcp`
