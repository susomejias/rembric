## ADDED Requirements

### Requirement: The bridge is the single client-side piece, published as a package inside the plugin component

The repository SHALL own the whole client side of the MCP connection in one published package, `@rembric/mcp-bridge`, with its source at `apps/plugin/mcp-bridge/`. The package SHALL be responsible for project-directory resolution, `.rembric` slug resolution, URL building, the startup stderr diagnostic, the advisory server-version warning, bearer injection, the stdio↔Streamable-HTTP MCP transport, and session-terminated recovery.

There SHALL NOT be a second component that resolves the URL and then hands off to this one. The two-piece shape it replaces existed because the transport engine was third-party and could not be told to read a `.rembric` file; with the engine owned, a wrapper whose only job is to compute an argument for it has no independent reason to exist, and it carried real cost — process spawning, a stdio relay, spawn-error handling, exit-code forwarding, terminating-signal re-raising, and one extra process per session.

The directory SHALL sit inside `apps/plugin/` because release-please attributes a release to a component by the paths of the commits under that component's `path`: a package outside it would never itself *cause* a `plugin` release, so its version carrier would be rewritten only when some unrelated change triggered one.

The directory name SHALL NOT match `\.[\w-]+-plugin` — the pattern from which `apps/server/src/test/invariants.test.ts` derives "is this a JS/TS session client", every member of which must import `apps/plugin/bin/rembric-plugin-core.mjs`. The bridge is a transport and SHALL NOT import the session-protocol core.

`apps/plugin/mcp-bridge` SHALL be declared in `pnpm-workspace.yaml::packages`, unlike `.pi-plugin/`. That directory's exclusion from the workspace is accepted only because it declares no runtime dependency; this package declares one, which SHALL be resolved by `pnpm-lock.yaml` and integrity-verified under `--frozen-lockfile`, and its recovery logic SHALL be covered by executable tests.

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

### Requirement: The bridge takes no arguments; its entire contract is the environment

The package SHALL expose exactly one executable, resolvable by `npx @rembric/mcp-bridge@<version>` with no bin-name argument, and that executable SHALL accept **no command-line arguments**.

Its inputs are three environment variables:

- `REMBRIC_SERVER_URL` — the base URL, without the `/mcp` suffix. **Required.**
- `REMBRIC_API_TOKEN` — the bearer, injected as `Authorization: Bearer <token>` on every request to the endpoint. **Required.**
- `REMBRIC_PROJECT_SLUG` — an optional default slug, used only when no `.rembric` slug resolves.

The token SHALL NOT be accepted as a command-line argument, and the bridge SHALL NOT accept a header-injection argument of any kind. A process argument vector is readable by any local process through `ps` and `/proc/<pid>/cmdline`, so a token passed as an argument is a local disclosure — which is what the design this replaces did.

`http://` and `https://` endpoints SHALL both be accepted, with no scheme check and no permitting flag. Plain-HTTP LAN deployments are the canonical shape here, and a flag whose value never varies is not a control.

When `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` is absent or empty, the bridge SHALL exit non-zero with one stderr line naming the missing variable and instructing the user to configure the plugin, and SHALL NOT issue any HTTP request. No stderr output SHALL ever contain the token's value.

#### Scenario: npx resolves the executable without a bin name

- **WHEN** `npx -y @rembric/mcp-bridge@<version>` is run with the required environment set
- **THEN** the package's single executable SHALL start
- **AND** no `--package`/bin-name disambiguation argument SHALL be required

#### Scenario: A plain-HTTP endpoint is accepted with no flag

- **GIVEN** `REMBRIC_SERVER_URL=http://192.0.2.10:8787`
- **WHEN** the bridge starts
- **THEN** it SHALL connect
- **AND** it SHALL NOT require or accept an `--allow-http` flag

#### Scenario: The token never appears in the argument vector

- **WHEN** the bridge process is running and its `/proc/<pid>/cmdline` (or `ps` output) is inspected
- **THEN** the bearer token's value SHALL NOT appear
- **AND** the argument vector SHALL contain no header-bearing argument

#### Scenario: Missing configuration fails fast and quietly

- **GIVEN** `REMBRIC_API_TOKEN` is unset
- **WHEN** the bridge starts
- **THEN** it SHALL write exactly one stderr line naming the missing variable
- **AND** it SHALL exit non-zero without issuing any HTTP request

### Requirement: The bridge resolves the project directory and slug, and builds the path-scoped URL

The bridge SHALL resolve the project directory from a precedence chain of environment variables, in this order: `CLAUDE_PROJECT_DIR`, then `PWD`, then `process.cwd()`. The chain SHALL skip empty-string values (`||` semantics, not `??`) so that an explicitly-set-to-empty variable falls through cleanly. This is what makes the bridge usable from hosts that propagate the working directory as `PWD` rather than by Claude's convention — notably Codex, whose spawn semantics put `process.cwd()` at the plugin cache directory rather than at the user's project.

The bridge SHALL look for `${projectDir}/.rembric`. If present, it SHALL parse it as dotenv-style `KEY=VALUE` lines (with `#` line comments and optional matched-quote stripping) and read `PROJECT_SLUG`. The slug SHALL be validated against `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`.

The slug cascade SHALL be, in order: the validated `PROJECT_SLUG` from `.rembric`; then a validated `REMBRIC_PROJECT_SLUG` environment variable; then no slug. A candidate that fails validation SHALL be discarded and the cascade SHALL continue rather than aborting. The bridge SHALL NOT walk parent directories looking for `.rembric` — only the resolved project directory is checked. This precedence is the one `hermes-agent-plugin` already defines for its provider, adopted here rather than reinvented, so that a user who sets a default slug once and then works across repositories each carrying its own `.rembric` gets correct per-repository scoping from both surfaces.

With a resolved slug the endpoint SHALL be `${REMBRIC_SERVER_URL}/mcp/<slug>` (path-scoped); with none it SHALL be `${REMBRIC_SERVER_URL}/mcp` (path-less). Trailing slashes on the base URL SHALL be stripped. A missing, unparseable or invalid slug SHALL NOT abort the session: the bridge writes one stderr diagnostic and continues path-less, where the connection resolves to the server's default project or to whatever the agent later pins.

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
- **THEN** it SHALL emit one stderr diagnostic
- **AND** the endpoint SHALL be `${REMBRIC_SERVER_URL}/mcp`
- **AND** the session SHALL proceed

### Requirement: The bridge forwards the host's `initialize` verbatim and never substitutes its own identity

The bridge SHALL pass the host's MCP frames through unchanged, including the `initialize` request and its `clientInfo`. The `clientInfo.name` and `clientInfo.version` the server observes SHALL be exactly the values the host sent, with no prefix, suffix, replacement, or annotation.

This is a requirement on the architecture, not only on the output: an implementation that instantiates an SDK `Client` against the remote endpoint performs its own `initialize` and declares its own identity, which is how the delegate being replaced produced `"<host> (via mcp-remote <version>)"` — measured 2026-08-15, with a version string that did not even match the running package. The bridge SHALL therefore be a message pipe, holding only the state its session recovery needs (the current `mcp-session-id` and the most recent `initialize` frame).

The bridge SHALL NOT modify tool names, tool arguments, tool results, or any other frame content.

#### Scenario: The server records the host's real client identity

- **GIVEN** a host that sends `clientInfo` `{"name":"claude-code","version":"<v>"}` in its `initialize`
- **WHEN** that request reaches the server through the bridge
- **THEN** the server SHALL observe `clientInfo.name` exactly `"claude-code"` and `clientInfo.version` exactly `"<v>"`
- **AND** the observed name SHALL contain no reference to the bridge

#### Scenario: Frame content is not rewritten

- **WHEN** a `tools/call` frame passes through the bridge in either direction
- **THEN** the tool name, the arguments object and the result SHALL be byte-identical to what the sender emitted

### Requirement: A terminated session is recovered exactly once, on HTTP 404 only

When the endpoint answers an HTTP `404` to a request that carried an `mcp-session-id`, the bridge SHALL discard that session id, send a fresh `InitializeRequest` followed by `notifications/initialized`, and retry the original request exactly once. This implements the MCP specification's mandate (2025-06-18, Session Management): a client receiving `404` for a request carrying `Mcp-Session-Id` MUST start a new session with a new `InitializeRequest`.

The recovery is bounded on every axis:

- **Status.** `404` alone. `401`, `403`, `429` and every `5xx` SHALL propagate to the host unchanged, with no re-initialization and no retry.
- **Count.** Exactly one re-initialization and one retry per failing request. A failure of the retried request SHALL propagate. The bridge SHALL NOT loop.
- **Payload.** Only the handshake is replayed. Prior tool calls SHALL NOT be re-sent.
- **Applicability.** A request carrying no `mcp-session-id` — notably `initialize` itself — is not a recovery case, so a `404` to it SHALL propagate unchanged and cannot recurse.

Retrying a request that mutates state is safe against a Rembric server specifically, because that server's refusal is emitted at the transport boundary before any tool handler is constructed or run (`apps/server/src/server/http.ts`), so the refused call cannot have been partially applied. This property is stated as the reason rather than assumed, so that it is re-checked rather than generalised if the server's refusal ever moves.

#### Scenario: A tool call after a server restart succeeds transparently

- **GIVEN** an established session and a server that has restarted, so it no longer holds the session id
- **WHEN** the host issues a `tools/call` and the endpoint answers `404` with JSON-RPC error `-32001`
- **THEN** the bridge SHALL send a new `InitializeRequest`, then `notifications/initialized`, then re-send the original `tools/call` once
- **AND** the host SHALL receive the successful result, having observed no error

#### Scenario: A 401 is not a recovery case

- **GIVEN** an established session
- **WHEN** a request carrying the session id is answered `401`
- **THEN** the bridge SHALL NOT send an `InitializeRequest` and SHALL NOT retry
- **AND** the error SHALL propagate to the host unchanged

#### Scenario: A second failure propagates instead of looping

- **GIVEN** a request answered `404`, followed by a re-initialization, followed by a retry that is also answered `404`
- **WHEN** the second failure is observed
- **THEN** the bridge SHALL propagate the error to the host
- **AND** it SHALL issue no third attempt and no second `InitializeRequest`

#### Scenario: A 404 to `initialize` does not recurse

- **GIVEN** a request with no `mcp-session-id` header
- **WHEN** the endpoint answers `404`
- **THEN** the error SHALL propagate unchanged
- **AND** the bridge SHALL NOT attempt a re-initialization

#### Scenario: Prior calls are not replayed

- **WHEN** recovery completes for one failing request
- **THEN** the frames the bridge has sent since discarding the session id SHALL be exactly: the `InitializeRequest`, `notifications/initialized`, and the one retried request

### Requirement: Recovery restores the transport session, not server-side session state

A re-initialized connection is a new server-side session. The bridge SHALL NOT attempt to restore state the previous session held.

For a path-scoped endpoint (`/mcp/<slug>`) the project scope is re-derived from the unchanged URL, so recovery is scope-preserving. For a path-less endpoint (`/mcp`) the new session re-resolves through the server's ordinary discovery path; a project the agent had pinned during the session with `project.use` SHALL NOT be restored, and the connection resolves as any fresh path-less connection would.

This gap is specified rather than closed because closing it would require replaying prior tool calls, which the recovery requirement forbids.

#### Scenario: A path-scoped connection keeps its project across recovery

- **GIVEN** a resolved slug `demo`, so the endpoint is `<base>/mcp/demo`
- **WHEN** recovery re-initializes against the same URL
- **THEN** the new session SHALL be scoped to the `demo` project

#### Scenario: A `project.use` pin is not carried across recovery

- **GIVEN** a path-less `/mcp` connection on which the agent has pinned a project with `project.use`
- **WHEN** recovery re-initializes
- **THEN** the pin SHALL NOT be re-applied
- **AND** the new session SHALL resolve exactly as a fresh path-less connection does

### Requirement: The server-version check is advisory, lives here, and exists exactly once

Before connecting, the bridge SHALL perform one `GET ${REMBRIC_SERVER_URL}/healthz` request (reusing the bearer it holds for the MCP connection) with a short timeout (2 seconds). On success it SHALL compare the response's `version` field against a `MIN_SERVER_VERSION` constant bumped alongside the plugin's own version. When the server's version is older (semver comparison), the bridge SHALL print exactly one stderr line naming both versions and pointing at the dashboard self-update flow / `docs/updates.md`, then connect unchanged.

The check SHALL be advisory only and SHALL NOT block or delay the connection: it is fire-and-forget, concurrent with connecting. When the request fails for any reason — network error, timeout, non-200, malformed body — the bridge SHALL silently skip the check and proceed exactly as if it did not exist. This MUST NOT introduce a failure mode for environments where `/healthz` is unreachable but `/mcp` is fine (transient DNS blips, a reverse proxy exposing only `/mcp`).

There SHALL be exactly one implementation of this check across the plugin tree. No client, and not the deprecated on-disk launcher, SHALL issue a second `/healthz` request — a duplicate would be both a second implementation of one concern and a second HTTP request on every session start.

The bridge SHALL impose **no hard version floor**: it SHALL NOT refuse to run, and SHALL NOT alter its behaviour, on the basis of the server's version. Against a server that answers a status other than `404` for an unknown `mcp-session-id`, the recovery path simply does not fire and behaviour is exactly what it is without this package — never worse. What makes this safe is that the bridge is transport-only: MCP negotiates at runtime — tools discovered through `tools/list`, protocol version agreed in `initialize` — so a bridge that inspects no payload cannot go stale against a server.

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

- **GIVEN** a server that answers `400` (not `404`) for a request naming an unknown `mcp-session-id`
- **WHEN** the host issues such a request through the bridge
- **THEN** the error SHALL propagate unchanged
- **AND** the bridge SHALL NOT re-initialize, retry, or refuse to run against that server

#### Scenario: Exactly one `/healthz` request per session start

- **WHEN** every HTTP request issued between process start and the first MCP frame is enumerated across the whole client side
- **THEN** exactly one SHALL target `/healthz`
- **AND** it SHALL have been issued by the bridge, not by any client or launcher

### Requirement: The bridge declares exactly one runtime dependency, at an exact version

`@rembric/mcp-bridge` SHALL declare `@modelcontextprotocol/sdk` as its only runtime dependency, at an **exact** version — never a range.

An exact version is required for the same reason the spawn sites pin the bridge itself: a range lets a new upstream release change the bridge's behaviour on a user's machine with no Rembric release, which is the floating-tag hole one level down. The dependency's justification, and its measured cost, are owned by `supply-chain-hygiene`.

The bridge SHALL import only the SDK's client-side transport surface. It SHALL NOT bundle or vendor the SDK: the consumer's dependency tree is what lets their advisory tooling see the version they are running, and a bundled copy makes a CVE in it invisible to them.

#### Scenario: The manifest declares one exact dependency

- **WHEN** `apps/plugin/mcp-bridge/package.json` is read
- **THEN** `dependencies` SHALL contain exactly one entry, `@modelcontextprotocol/sdk`
- **AND** its value SHALL be an exact version string with no range operator (`^`, `~`, `>=`, `*`, or `x`)

#### Scenario: The SDK is a visible dependency, not a bundled copy

- **WHEN** the published tarball's file list is inspected
- **THEN** it SHALL NOT contain a vendored or bundled copy of the SDK
- **AND** a consumer's installed tree SHALL show `@modelcontextprotocol/sdk` at the pinned version

### Requirement: Every spawn site MUST pin an exact bridge version

Every place that spawns `@rembric/mcp-bridge` SHALL name an exact version (`@rembric/mcp-bridge@<x.y.z>`), never a floating tag such as `@latest`. This covers the Claude Code plugin manifest, the Codex CLI plugin manifest, the deprecated opencode compatibility launcher, and any documented configuration block.

`npx` re-resolves a floating tag on every session start, so with `@latest` a compromise of the publishing account would be arbitrary code execution on every user machine at the next session start. An exact pin means new code reaches a user only through a deliberate plugin release. Owning the package makes this stricter, not laxer: the blast radius of our own compromised publish is the same as a third party's.

Every pin SHALL be a version carrier written by release-please as part of the `plugin` component, never a hand-maintained constant, so that no spawn site can name a version that was not released. Where a file format cannot carry a release-please annotation, the pin SHALL still be asserted equal to the plugin version by an executable check rather than left to review.

#### Scenario: Session start does not re-resolve `latest`

- **WHEN** any spawn site's package specifier is read
- **THEN** it SHALL name an exact `@rembric/mcp-bridge@<x.y.z>` version
- **AND** no spawn site SHALL name `@latest` or any other floating tag

#### Scenario: A compromised publish does not reach existing installations

- **WHEN** a malicious or broken `@rembric/mcp-bridge` version is published to npm
- **THEN** existing installations SHALL be unaffected (they keep spawning the pinned version)
- **AND** reaching them SHALL require a deliberate plugin release that bumps the pins

#### Scenario: Every pin agrees with the released plugin version

- **WHEN** the repository is read at any commit on the default branch
- **THEN** every `@rembric/mcp-bridge@<x.y.z>` specifier SHALL equal `apps/plugin/package.json::version`
- **AND** a disagreement SHALL fail the build rather than be caught in review

### Requirement: OAuth and general-purpose transport features are non-goals

The bridge's authentication surface SHALL be a bearer token from the environment and nothing else. It SHALL NOT implement OAuth discovery, dynamic client registration, an authorization-code flow, or a local callback listener, and SHALL NOT request any `.well-known` metadata document.

It SHALL NOT implement a legacy-SSE transport, an endpoint-probing or transport-strategy fallback, or any command-line surface for selecting a transport. Its target is a Rembric server speaking Streamable HTTP.

These are recorded as requirements rather than as omissions because the package being replaced carries all of them, each was measured to cost every session start, and the failure mode for a bridge of this kind is re-acquiring them one increment at a time.

#### Scenario: A session start makes no discovery requests

- **WHEN** a session is started through the bridge and every HTTP request it issues before the first MCP frame is counted
- **THEN** none SHALL target a `.well-known` path
- **AND** the first request the MCP endpoint receives SHALL be the `initialize` POST

#### Scenario: No local listener is bound

- **WHEN** the bridge is running a session
- **THEN** it SHALL hold no listening socket

### Requirement: The compatibility matrix names how each client was verified, or states it was not

The package's documentation SHALL carry a compatibility matrix over the clients this repository ships and the platforms it runs on. Each entry SHALL state either how it was verified — the host, the arm exercised, and the date — or that it is unverified together with the reason.

Two entries SHALL be present and SHALL NOT be quietly upgraded to a claim:

- **Codex CLI: unverified, with the reason.** An authenticated Codex process reaches the real production Rembric through an account-level connector regardless of `CODEX_HOME` or environment isolation (incident recorded 2026-08-10), so driving a real authenticated Codex against a probe stack is refused. The entry SHALL state what is shared by construction (the same published package, spawned the same way) and what is not: Codex's own manifest changes in this change, so it is **not** true that Codex inherits an untouched shared file.
- **Windows: unverified, with the reason.** This repository has no Windows CI. The package adds no platform-specific code and leans on the SDK's transports for platform behaviour, but that is an argument, not a measurement; Windows reports are triaged reactively.

#### Scenario: An unverified entry says so

- **WHEN** the compatibility matrix is read
- **THEN** the Codex CLI and Windows entries SHALL each be marked unverified and SHALL state the reason
- **AND** neither SHALL be presented as supported or tested

#### Scenario: A verified entry names its evidence

- **WHEN** a client is listed as verified
- **THEN** the entry SHALL name the host driven, the arms exercised, and the date of the run
