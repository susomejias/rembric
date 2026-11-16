## MODIFIED Requirements

### Requirement: The bridge is the single client-side piece, published as a package inside the plugin component

The repository SHALL own the whole client side of the MCP connection in one published package, `@rembric/mcp-bridge`, with its source at `apps/plugin/mcp-bridge/`. The package SHALL be responsible for project-directory resolution, `.rembric` slug resolution, URL building, the startup stderr diagnostic, the advisory server-version warning, bearer injection, and the stdio↔Streamable-HTTP MCP transport. It SHALL NOT implement protocol-session recovery or relay server-initiated requests: the server mints no `Mcp-Session-Id` and initiates no request.

There SHALL NOT be a second component that resolves the URL and then hands off to this one. The two-piece shape it replaces existed because the transport engine was third-party and could not be told to read a `.rembric` file; with the engine owned, a wrapper whose only job is to compute an argument for it has no independent reason to exist, and it carried real cost — process spawning, a stdio relay, spawn-error handling, exit-code forwarding, terminating-signal re-raising, and one extra process per session.

The directory SHALL sit inside `apps/plugin/` because release-please attributes a release to a component by the paths of the commits under that component's `path`: a package outside it would never itself _cause_ a `plugin` release, so its version carrier would be rewritten only when some unrelated change triggered one.

The directory name SHALL NOT match `\.[\w-]+-plugin` — the pattern from which `apps/web/src/test/invariants.test.ts` derives "is this a JS/TS session client", every member of which must import `apps/plugin/bin/rembric-plugin-core.mjs`. The bridge is a transport and SHALL NOT import the session-protocol core.

`apps/plugin/mcp-bridge` SHALL be declared in `pnpm-workspace.yaml::packages`, unlike `.pi-plugin/`. Both declare no runtime dependencies, so the reason is not lockfile resolution: this package carries the whole client side for every shell client, and its slug-resolution and transport logic SHALL be covered by executable tests, which requires it to be a workspace member the test runner reaches.

#### Scenario: The package directory is inside the plugin component and is a workspace member

- **WHEN** the repository is read at HEAD
- **THEN** `apps/plugin/mcp-bridge/package.json` SHALL exist and SHALL declare `"name": "@rembric/mcp-bridge"`
- **AND** `pnpm-workspace.yaml::packages` SHALL contain an entry matching `apps/plugin/mcp-bridge`
- **AND** the directory name SHALL NOT match `\.[\w-]+-plugin`

#### Scenario: A bridge-only commit causes a plugin release

- **GIVEN** a merged commit whose only changed paths are under `apps/plugin/mcp-bridge/`
- **WHEN** release-please runs
- **THEN** it SHALL open or update a release PR for the `plugin` component
- **AND** the package SHALL NOT be a release component of its own

#### Scenario: No process is spawned to reach the server

- **WHEN** a client host spawns the bridge and a session runs to completion
- **THEN** the bridge SHALL create no child process
- **AND** the process tree from the host to the server SHALL contain exactly one process the plugin owns

#### Scenario: The bridge does not import the session-protocol core

- **WHEN** the bridge's source files are read
- **THEN** none SHALL import `rembric-plugin-core.mjs`
- **AND** the invariant test's client-detection pattern SHALL NOT match any of them

### Requirement: The bridge resolves the project directory and slug, and builds the path-scoped URL

The bridge SHALL resolve the project directory from a precedence chain of environment variables, in this order: `CLAUDE_PROJECT_DIR`, then `PWD`, then `process.cwd()`. The chain SHALL skip empty-string values (`||` semantics, not `??`) so that an explicitly-set-to-empty variable falls through cleanly. This is what makes the bridge usable from hosts that propagate the working directory as `PWD` rather than by Claude's convention — notably Codex, whose spawn semantics put `process.cwd()` at the plugin cache directory rather than at the user's project.

The bridge SHALL look for `${projectDir}/.rembric`. If present, it SHALL parse it as dotenv-style `KEY=VALUE` lines (with `#` line comments and optional matched-quote stripping) and read `PROJECT_SLUG`. The slug SHALL be validated against `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`.

The slug cascade SHALL be, in order: the validated `PROJECT_SLUG` from `.rembric`; then a validated `REMBRIC_PROJECT_SLUG` environment variable; then no slug. A candidate that fails validation SHALL be discarded and the cascade SHALL continue rather than aborting. The bridge SHALL NOT walk parent directories looking for `.rembric` — only the resolved project directory is checked. This precedence is the one `hermes-agent-plugin` already defines for its provider, adopted here rather than reinvented, so that a user who sets a default slug once and then works across repositories each carrying its own `.rembric` gets correct per-repository scoping from both surfaces.

With a resolved slug the endpoint SHALL be `${REMBRIC_SERVER_URL}/mcp/<slug>` (path-scoped); with none it SHALL be `${REMBRIC_SERVER_URL}/mcp` (path-less). Trailing slashes on the base URL SHALL be stripped. A missing, unparseable or invalid slug SHALL NOT abort the session: the bridge writes one stderr diagnostic and continues path-less, where the connection resolves to the server's default project and stays there: no tool can switch it, and the server does not derive a project from the host's roots. That diagnostic SHALL name the fix — add a `.rembric` file containing `PROJECT_SLUG=<slug>` to the resolved project directory, or set `REMBRIC_PROJECT_SLUG` — and SHALL state that the connection uses the default project.

The bridge SHALL write one diagnostic line to stderr at startup of the form `[rembric-bridge] projectDir=<dir> (from <source>) url=<url>`, where `<source>` is exactly one of `CLAUDE_PROJECT_DIR`, `PWD`, or `process.cwd()` — naming which step of the chain produced the resolved directory. This is what makes `claude --debug` and Codex log inspection able to explain a wrong project.

The bridge SHALL be the **only** JS/TS implementation of this parsing: it imports the shared dotenv module rather than defining its own parser or slug regex.

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

- **GIVEN** no `.rembric` and no `REMBRIC_PROJECT_SLUG`
- **WHEN** the bridge starts
- **THEN** it SHALL emit one stderr diagnostic that names `.rembric` with `PROJECT_SLUG` and `REMBRIC_PROJECT_SLUG` as the fix and states that the default project is in use
- **AND** the endpoint SHALL be `${REMBRIC_SERVER_URL}/mcp`
- **AND** the session SHALL proceed, and its tool calls SHALL resolve to the server's default project

### Requirement: The server-version check is advisory, lives here, and exists exactly once

Before connecting, the bridge SHALL perform one `GET ${REMBRIC_SERVER_URL}/healthz` request (reusing the bearer it holds for the MCP connection) with a short timeout (2 seconds). On success it SHALL compare the response's `version` field against a `MIN_SERVER_VERSION` constant bumped alongside the plugin's own version. When the server's version is older (semver comparison), the bridge SHALL print exactly one stderr line naming both versions and pointing at the dashboard self-update flow / `docs/updates.md`, then connect unchanged.

The check SHALL be advisory only and SHALL NOT block or delay the connection: it is fire-and-forget, concurrent with connecting. When the request fails for any reason — network error, timeout, non-200, malformed body — the bridge SHALL silently skip the check and proceed exactly as if it did not exist. This MUST NOT introduce a failure mode for environments where `/healthz` is unreachable but `/mcp` is fine (transient DNS blips, a reverse proxy exposing only `/mcp`).

There SHALL be exactly one implementation of this check across the plugin tree. No client, and not the deprecated on-disk launcher, SHALL issue a second `/healthz` request — a duplicate would be both a second implementation of one concern and a second HTTP request on every session start.

The bridge SHALL impose **no hard version floor**: it SHALL NOT refuse to run, and SHALL NOT alter its behaviour, on the basis of the server's version. What makes this safe is that the bridge is transport-only: MCP negotiates at runtime — tools discovered through `tools/list`, protocol version agreed in `initialize` — so a bridge that inspects no payload cannot go stale against a server.

#### Scenario: An outdated server produces one advisory line and connects

- **GIVEN** `/healthz` responds successfully with a `version` older than `MIN_SERVER_VERSION`
- **WHEN** the bridge starts
- **THEN** it SHALL print exactly one stderr line naming both the server's version and the expected minimum, and pointing at the update flow
- **AND** it SHALL still connect normally

#### Scenario: A server meeting the minimum is silent

- **GIVEN** `/healthz` responds successfully with a `version` at or above `MIN_SERVER_VERSION`
- **WHEN** the bridge starts
- **THEN** no version-related stderr line SHALL be printed

#### Scenario: A healthz failure does not block or warn

- **GIVEN** the `/healthz` request times out, errors, or returns a non-200 status
- **WHEN** the bridge starts
- **THEN** no version-related stderr line SHALL be printed
- **AND** the bridge SHALL connect exactly as it would without this requirement

#### Scenario: An older server degrades to today's behaviour, not worse

- **GIVEN** a server whose version is older than `MIN_SERVER_VERSION` and that answers a request with an HTTP error status
- **WHEN** the host issues that request through the bridge
- **THEN** the error SHALL propagate to the host unchanged
- **AND** the bridge SHALL NOT re-initialize, retry, or refuse to run against that server

#### Scenario: Exactly one `/healthz` request per session start

- **WHEN** every HTTP request issued between process start and the first MCP frame is enumerated across the whole client side
- **THEN** exactly one SHALL target `/healthz`
- **AND** it SHALL have been issued by the bridge, not by any client or launcher

### Requirement: The bridge declares no runtime dependencies

`@rembric/mcp-bridge` SHALL declare an empty `dependencies` object. It SHALL implement the stdio framing, the HTTP requests, and the SSE response parsing against Node's own built-ins, and SHALL NOT depend on `@modelcontextprotocol/sdk` or on any other package at runtime.

The alternative — one exact-pinned dependency on the SDK's client transports — was specified first and reversed on measurement. In a clean directory (`npm install --ignore-scripts`), `mcp-remote@0.1.38` installs 80 packages / 7.0 MB while `@modelcontextprotocol/sdk@1.29.0` installs 93 packages / 25 MB, because the SDK declares `express`, `hono`, `cors`, `jose`, `eventsource` and `express-rate-limit` in `dependencies` rather than as peers. A replacement whose purpose includes reducing what a user's machine executes cannot ship a larger tree than the thing it replaces, and none of that surface is reachable from a stdio proxy.

Zero dependencies also discharges the message-pipe requirement above by construction rather than by discipline: with no SDK `Client` there is no second handshake that could substitute the bridge's identity for the host's.

This is not a novel burden for this repository. `apps/plugin/.pi-plugin/index.ts` already ships a Streamable HTTP MCP client with `dependencies: {}`, including SSE frame parsing, and the prototype recorded in `measurements/prototype-zerodep.mjs` demonstrated the one mechanism that had no precedent there: relaying a server-initiated request to the host. That relay has since been removed, because the server no longer initiates any request.

#### Scenario: The manifest declares no runtime dependencies

- **WHEN** `apps/plugin/mcp-bridge/package.json` is read
- **THEN** `dependencies` SHALL be absent or an empty object
- **AND** the published tarball SHALL NOT contain a vendored or bundled copy of any third-party package

#### Scenario: A consumer's install adds nothing but the bridge

- **WHEN** `@rembric/mcp-bridge` is installed into an empty directory with lifecycle scripts disabled
- **THEN** the resulting tree SHALL contain exactly one package
- **AND** its measured size SHALL be recorded against the 80 packages / 7.0 MB the replaced delegate installs

### Requirement: The bridge forwards the host's `initialize` verbatim and never substitutes its own identity

The bridge SHALL pass the host's MCP frames through unchanged, including the `initialize` request and its `clientInfo`. The `clientInfo.name` and `clientInfo.version` the server observes SHALL be exactly the values the host sent, with no prefix, suffix, replacement, or annotation.

This is a requirement on the architecture, not only on the output: an implementation that instantiates an SDK `Client` against the remote endpoint performs its own `initialize` and declares its own identity, which is how the delegate being replaced produced `"<host> (via mcp-remote <version>)"` — measured 2026-08-15, with a version string that did not even match the running package. The bridge SHALL therefore be a message pipe. It SHALL NOT retain the host's `initialize` frame for replay, because no recovery path exists to replay it.

The bridge SHALL NOT modify tool names, tool arguments, tool results, or any other frame content.

#### Scenario: The server records the host's real client identity

- **GIVEN** a host that sends `clientInfo` `{"name":"claude-code","version":"<v>"}` in its `initialize`
- **WHEN** that request reaches the server through the bridge
- **THEN** the server SHALL observe `clientInfo.name` exactly `"claude-code"` and `clientInfo.version` exactly `"<v>"`
- **AND** the observed name SHALL contain no reference to the bridge

#### Scenario: Frame content is not rewritten

- **WHEN** a `tools/call` frame passes through the bridge in either direction
- **THEN** the tool name, the arguments object and the result SHALL be byte-identical to what the sender emitted

### Requirement: Bridge compatibility documentation distinguishes support from host verification

The documentation SHALL describe the bridge as a standard stdio MCP transport replacement for hosts that previously used `mcp-remote`. Its compatibility table SHALL retain recorded host-level evidence where it exists and label unmeasured hosts as supported but not host-verified; it SHALL not present an unmeasured host as a recorded run.

#### Scenario: An unmeasured host is labelled supported but not host-verified

- **WHEN** the bridge's compatibility table is read
- **THEN** every host with no recorded host-level run SHALL be labelled supported but not host-verified
- **AND** no such host SHALL be presented as a recorded run, and every host with a recorded run SHALL keep its evidence

## REMOVED Requirements

### Requirement: A terminated session is recovered exactly once, on HTTP 404 only

**Reason**: The server serves both protocol eras from one stateless handler and no longer mints `Mcp-Session-Id`, so no request carries a session id and the server never answers `404`/`-32001` for an unknown session. The recovery path can no longer fire.

**Migration**: None required. A server restart is invisible to the bridge: every request is served on its own, and the host's next `tools/call` succeeds without a re-initialization.

### Requirement: Recovery restores the transport session, not server-side session state

**Reason**: There is no transport session to restore and no per-connection server state to lose: the recovery path is removed, and the `project.use` pin this requirement declined to restore no longer exists.

**Migration**: None required. A path-scoped endpoint keeps its project from the URL on every request; a path-less endpoint resolves to the default project on every request.

### Requirement: The bridge relays a server-initiated request to the host and returns its answer

**Reason**: The server no longer sends `roots/list`, which was the only request it initiated, and sends no other server→client request or notification.

**Migration**: None required. To scope a bridge connection to a project, add a `.rembric` file containing `PROJECT_SLUG=<slug>` to the project directory or set `REMBRIC_PROJECT_SLUG`.
