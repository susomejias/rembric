# mcp-bridge

## Purpose

Defines the published zero-dependency client-side Rembric MCP bridge, including its stdio transport, project resolution, recovery, and package-distribution contract.

## Requirements

### Requirement: The bridge is the single client-side piece, published as a package inside the plugin component

The repository SHALL own the whole client side of the MCP connection in one set of zero-dependency files at `apps/plugin/mcp-bridge/`, distributed two ways from the same files: shipped in the plugin tree, where the plugins and the installer run it with `node <path>/cli.mjs`, and published to npm as `@rembric/mcp-bridge`, for configurations written by hand. The plugins SHALL NOT depend on the published package. The bridge SHALL be responsible for project-directory resolution, `.rembric` slug resolution, URL building, the startup stderr diagnostic, the advisory server-version warning, bearer injection, and the stdio↔Streamable-HTTP MCP transport. It SHALL NOT implement protocol-session recovery or relay server-initiated requests: the server mints no `Mcp-Session-Id` and initiates no request.

There SHALL NOT be a second component that resolves the URL and then hands off to this one. The two-piece shape it replaces existed because the transport engine was third-party and could not be told to read a `.rembric` file; with the engine owned, a wrapper whose only job is to compute an argument for it has no independent reason to exist, and it carried real cost — process spawning, a stdio relay, spawn-error handling, exit-code forwarding, terminating-signal re-raising, and one extra process per session.

The directory SHALL sit inside `apps/plugin/` because release-please attributes a release to a component by the paths of the commits under that component's `path`: a package outside it would never itself _cause_ a `plugin` release, so its version carrier would be rewritten only when some unrelated change triggered one.

The directory name SHALL NOT match `\.[\w-]+-plugin` — the pattern from which `apps/web/src/test/invariants.test.ts` derives "is this a JS/TS session client", every member of which must import `apps/plugin/bin/rembric-plugin-core.mjs`. The bridge is a transport and SHALL NOT import the session-protocol core.

`apps/plugin/mcp-bridge` SHALL be declared in `pnpm-workspace.yaml::packages`, unlike `.pi-plugin/`. Both declare no runtime dependencies, so the reason is not lockfile resolution: this package carries the whole client side for every shell client, and its slug-resolution and transport logic SHALL be covered by executable tests, which requires it to be a workspace member the test runner reaches.

#### Scenario: The package directory is inside the plugin component and is a workspace member

- **WHEN** the repository is read at HEAD
- **THEN** `apps/plugin/mcp-bridge/package.json` SHALL exist and SHALL declare `"name": "@rembric/mcp-bridge"`
- **AND** `pnpm-workspace.yaml::packages` SHALL contain an entry matching `apps/plugin/mcp-bridge`
- **AND** the directory name SHALL NOT match `\.[\w-]+-plugin`

#### Scenario: The plugins ship the same bridge the release publishes

- **WHEN** a `plugin` release cuts version `X.Y.Z`
- **THEN** the plugin tree at the `plugin-vX.Y.Z` tag SHALL contain the bridge files under `apps/plugin/mcp-bridge/`
- **AND** `@rembric/mcp-bridge@X.Y.Z` SHALL be published from those same files
- **AND** no plugin SHALL need that publish to complete before its MCP server can start

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

The package SHALL expose exactly one executable, `cli.mjs`, run by the plugins as `node <path>/cli.mjs` with nothing after the script path and resolvable by `npx @rembric/mcp-bridge@<version>` with no bin-name argument, and that executable SHALL accept **no command-line arguments**.

Its inputs are three environment variables and the host binding:

- `REMBRIC_SERVER_URL` — the base URL, without the `/mcp` suffix. **Required.**
- `REMBRIC_API_TOKEN` — the bearer, injected as `Authorization: Bearer <token>` on every request to the endpoint. **Required.**
- `REMBRIC_PROJECT_SLUG` — an optional default slug, used only when no `.rembric` slug resolves.
- The host binding — the files `<home>/.cache/rembric/host-sessions/<pid>.json` that the host's lifecycle code publishes for the bridge's host process, read as "The bridge declares the host session from the host binding" specifies. It is optional: with no matching file the bridge behaves exactly as it does without one.

Besides the bearer and the repository fingerprint, the bridge's only added request header is `X-Rembric-Session`, sent when the host binding names a session. Its value comes from the host binding and never from an argument or an environment variable.

The token SHALL NOT be accepted as a command-line argument, and the bridge SHALL NOT accept a header-injection argument of any kind. A process argument vector is readable by any local process through `ps` and `/proc/<pid>/cmdline`, so a token passed as an argument is a local disclosure — which is what the design this replaces did.

`http://` and `https://` endpoints SHALL both be accepted, with no scheme check and no permitting flag. Plain-HTTP LAN deployments are the canonical shape here, and a flag whose value never varies is not a control.

When `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` is absent or empty, the bridge SHALL exit non-zero with one stderr line naming the missing variable and instructing the user to configure the plugin, and SHALL NOT issue any HTTP request. No stderr output SHALL ever contain the token's value.

#### Scenario: node runs the executable with no argument

- **GIVEN** `<path>` is a directory holding the bridge files
- **WHEN** `node <path>/cli.mjs` is run with the required environment set
- **THEN** the package's single executable SHALL start
- **AND** no argument after the script path SHALL be required

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

#### Scenario: The declared session comes only from the host binding

- **GIVEN** no host binding file matches the bridge's host
- **WHEN** the bridge forwards any request
- **THEN** the request SHALL carry no `X-Rembric-Session` header
- **AND** no command-line argument or environment variable SHALL be able to add one

#### Scenario: Missing configuration fails fast and quietly

- **GIVEN** `REMBRIC_API_TOKEN` is unset
- **WHEN** the bridge starts
- **THEN** it SHALL write exactly one stderr line naming the missing variable
- **AND** it SHALL exit non-zero without issuing any HTTP request

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

`@rembric/mcp-bridge` SHALL declare an empty `dependencies` object, and every module shipped under `apps/plugin/mcp-bridge/` SHALL import only the bridge's other modules and `node:` built-ins. The bridge SHALL implement the stdio framing, the HTTP requests, and the SSE response parsing against Node's own built-ins, and SHALL NOT depend on `@modelcontextprotocol/sdk` or on any other package at runtime.

The alternative — one exact-pinned dependency on the SDK's client transports — was specified first and reversed on measurement. In a clean directory (`npm install --ignore-scripts`), `mcp-remote@0.1.38` installs 80 packages / 7.0 MB while `@modelcontextprotocol/sdk@1.29.0` installs 93 packages / 25 MB, because the SDK declares `express`, `hono`, `cors`, `jose`, `eventsource` and `express-rate-limit` in `dependencies` rather than as peers. A replacement whose purpose includes reducing what a user's machine executes cannot ship a larger tree than the thing it replaces, and none of that surface is reachable from a stdio proxy.

Zero dependencies also discharges the message-pipe requirement above by construction rather than by discipline: with no SDK `Client` there is no second handshake that could substitute the bridge's identity for the host's.

This is not a novel burden for this repository. `apps/plugin/.pi-plugin/index.ts` already ships a Streamable HTTP MCP client with `dependencies: {}`, including SSE frame parsing, and the prototype recorded in `measurements/prototype-zerodep.mjs` demonstrated the one mechanism that had no precedent there: relaying a server-initiated request to the host. That relay has since been removed, because the server no longer initiates any request.

The rule covers both distributions, and the shipped files are the stricter case: a plugin copy and `~/.config/rembric/bin/` hold the bridge files with no `node_modules` directory beside them, so a bare package import would fail there.

#### Scenario: The manifest declares no runtime dependencies

- **WHEN** `apps/plugin/mcp-bridge/package.json` is read
- **THEN** `dependencies` SHALL be absent or an empty object
- **AND** neither the files under `apps/plugin/mcp-bridge/` nor the published tarball SHALL contain a vendored or bundled copy of any third-party package

#### Scenario: A consumer's install adds nothing but the bridge

- **WHEN** `@rembric/mcp-bridge` is installed into an empty directory with lifecycle scripts disabled
- **THEN** the resulting tree SHALL contain exactly one package
- **AND** its measured size SHALL be recorded against the 80 packages / 7.0 MB the replaced delegate installs

#### Scenario: A plugin or installer copy runs without installing anything

- **WHEN** a client installation places the bridge files, either in an installed plugin copy or in `~/.config/rembric/bin/`
- **THEN** it SHALL install no package for the bridge and SHALL create no `node_modules` directory for it
- **AND** `node <path>/cli.mjs` SHALL run with nothing but the bridge's own modules and Node built-ins

#### Scenario: The bridge modules import only each other and Node built-ins

- **WHEN** every `.mjs` module shipped under `apps/plugin/mcp-bridge/` is read
- **THEN** every import specifier SHALL be either a relative path to another module in that directory or a `node:` built-in
- **AND** no bare package specifier SHALL appear

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

### Requirement: Bridge compatibility documentation distinguishes support from host verification

The documentation SHALL describe the bridge as a standard stdio MCP transport replacement for hosts that previously used `mcp-remote`. Its compatibility table SHALL retain recorded host-level evidence where it exists and label unmeasured hosts as supported but not host-verified; it SHALL not present an unmeasured host as a recorded run.

#### Scenario: An unmeasured host is labelled supported but not host-verified

- **WHEN** the bridge's compatibility table is read
- **THEN** every host with no recorded host-level run SHALL be labelled supported but not host-verified
- **AND** no such host SHALL be presented as a recorded run, and every host with a recorded run SHALL keep its evidence

### Requirement: The compatibility matrix names how each client was verified, or states it was not

The package's documentation SHALL carry a compatibility matrix over the clients this repository ships and the platforms it runs on. Each entry SHALL state either how it was verified — the host, the arm exercised, and the date — or that it is unverified together with the reason.

Two entries SHALL be present and SHALL NOT be quietly upgraded to a claim:

- **Codex CLI: unverified, with the reason.** An authenticated Codex process reaches the real production Rembric through an account-level connector regardless of `CODEX_HOME` or environment isolation (incident recorded 2026-08-10), so driving a real authenticated Codex against a probe stack is refused. The entry SHALL state what is shared by construction (the same bridge files from the plugin tree, run by `node`; only the path that locates `cli.mjs` differs) and what is not: Codex's own manifest changes in this change, so it is **not** true that Codex inherits an untouched shared file.
- **Windows: unverified, with the reason.** This repository has no Windows CI. The package adds no platform-specific code, but that is an argument, not a measurement; Windows reports are triaged reactively.

#### Scenario: An unverified entry says so

- **WHEN** the compatibility matrix is read
- **THEN** the Codex CLI and Windows entries SHALL each be marked unverified and SHALL state the reason
- **AND** neither SHALL be presented as supported or tested

#### Scenario: A verified entry names its evidence

- **WHEN** a client is listed as verified
- **THEN** the entry SHALL name the host driven, the arms exercised, and the date of the run

### Requirement: The bridge declares the host session from the host binding

At startup, on every platform except `win32`, the bridge SHALL find its host once: the nearest ancestor, walking from its parent process upwards at most 8 hops and stopping before PID 1, that is not a launcher. A launcher is a process whose `comm` basename, with a leading `-` removed, is one of `sh`, `bash`, `zsh`, `dash`, `ksh`, `fish`, `env`, `npm`, `npx`, or whose command line (`ps -o args=`) starts with `npm` or `npx`, or a path ending in `/npm` or `/npx`, followed by a space or the end, or is `node` running a path ending in `npm-cli.js` or `npx-cli.js`. The shell and launcher names SHALL agree with the shared fixture `apps/plugin/test/host-binding-layout.json` (`nonHostCommands`, `launcherCommands`). The bridge SHALL record the host's start token: the stdout of `ps -o lstart= -p <pid>` run with `LC_ALL=C`, with runs of whitespace collapsed to one space and trimmed. A live process's ancestors and their start times do not change, so the host SHALL NOT be recomputed. With no host within 8 hops, or a host whose start token is unavailable, the bridge SHALL send no header.

On every request it forwards, `initialize` included, the bridge SHALL read `<home>/.cache/rembric/host-sessions/<host pid>.json`, where `<home>` is `os.homedir()`, and send its `sessionId` as `X-Rembric-Session` when its `pid` and `start` equal the host's and its `sessionId` matches `^[A-Za-z0-9_-]{8,128}$`. An unreadable file, a parse error, a `pid` or `start` mismatch or a malformed `sessionId` SHALL mean no header. The bridge SHALL consider exactly one process: it SHALL NOT read the binding of any process beyond its host, because an outer host's session is not the bridge's session — opencode started from a Claude Code terminal, a Hermes process that withdrew its binding, or a host whose own hook failed would otherwise be misattributed to the outer host. The bridge SHALL never send the header empty. Reading per request is what makes a session that the host switched (after `/clear`, a resume or a compaction) take effect without restarting the bridge.

The bridge SHALL NOT write or delete binding files. On `win32` it SHALL record no chain and send no header.

The start token, the directory, the lookup, and the publish and remove used by the opencode plugin SHALL live in one module, `apps/plugin/mcp-bridge/rembric-host-binding.mjs`, shipped with the bridge's other files in the plugin tree and in the published package, and its constants SHALL be asserted against the shared layout fixture `apps/plugin/test/host-binding-layout.json`. The invariant test SHALL fail when another JS/TS plugin file defines them.

#### Scenario: A bound host's session is sent on every request

- **GIVEN** the host spawned the bridge directly as `node <path>/cli.mjs`, so the host is the bridge's parent process
- **AND** a host binding for the host whose `pid` and `start` match and whose `sessionId` is `<S>`
- **WHEN** the bridge forwards `initialize`, the initialized notification and a `tools/call`
- **THEN** each of those requests SHALL carry `X-Rembric-Session: <S>`

#### Scenario: A launcher between the host and the bridge is skipped

- **GIVEN** the bridge's parent is an `npm exec @rembric/mcp-bridge@<version>` launcher whose parent is the host, as a hand-written `npx` configuration still produces
- **AND** a host binding for the host whose `pid` and `start` match and whose `sessionId` is `<S>`
- **WHEN** the bridge forwards a request
- **THEN** the request SHALL carry `X-Rembric-Session: <S>`
- **AND** the bridge SHALL NOT read a binding named for the launcher's PID

#### Scenario: A re-published binding applies to the next request

- **GIVEN** the bridge is running and sending `X-Rembric-Session: <S1>`
- **WHEN** the host re-publishes its binding with `sessionId` `<S2>`
- **THEN** the next request the bridge forwards SHALL carry `X-Rembric-Session: <S2>`, with no restart

#### Scenario: A bridge whose host publishes no binding sends no header even when an outer host does

- **GIVEN** the chain from the bridge's parent upwards is an `npm exec` launcher, opencode, `zsh` and Claude Code
- **AND** Claude Code has a matching binding and opencode has none
- **WHEN** the bridge forwards a request
- **THEN** the request SHALL carry no `X-Rembric-Session` header
- **AND** the bridge SHALL NOT read Claude Code's binding

#### Scenario: A reused PID is not trusted and no outer host is consulted

- **GIVEN** a binding file named for the host's PID whose `start` differs from the host's recorded start token
- **AND** an outer ancestor has a matching binding
- **WHEN** the bridge forwards a request
- **THEN** the request SHALL carry no `X-Rembric-Session` header

#### Scenario: A malformed or unreadable binding is ignored

- **GIVEN** the host's binding file is not JSON, is unreadable, or carries a `sessionId` outside `^[A-Za-z0-9_-]{8,128}$`
- **WHEN** the bridge forwards a request
- **THEN** the request SHALL carry no `X-Rembric-Session` header and the bridge SHALL NOT fail the request

### Requirement: Every plugin and installer spawn site MUST run the bridge shipped with the same release as its launcher

Every place this repository's plugins or installer spawn the bridge SHALL run the copy of the `apps/plugin/mcp-bridge/` files shipped with the same release as the manifest or installer that launches it, invoked as `node <path>/cli.mjs`. The bridge then arrives in the same commit as the manifest that launches it, so no client can install a plugin version whose bridge is unavailable, however late the published package reaches npm.

The spawn sites are:

- **Claude Code**: `.claude-plugin/mcp.json` SHALL spawn `command: "node"` with `args: ["${CLAUDE_PLUGIN_ROOT}/mcp-bridge/cli.mjs"]`, which resolves inside the installed plugin copy.
- **Codex CLI**: `.codex-plugin/mcp.json` SHALL spawn `command: "node"` with `args: ["./mcp-bridge/cli.mjs"]` and `cwd: "."`, so the path resolves against the installed plugin directory. Its `env_vars` SHALL keep forwarding `PWD`, because the child's cwd is the plugin directory and `PWD` is what carries the user's project.
- **opencode and Hermes Agent**: the rembric MCP entry that the opencode config hook sets and that the TUI installer writes for Hermes SHALL spawn `node` with `~/.config/rembric/bin/cli.mjs`. The TUI installer SHALL place the bridge's files in `~/.config/rembric/bin/`, fetched from the same ref as the rest of that client's files.

None of these spawn sites SHALL run the bridge through `npx` or fetch it from the npm registry. Exact versioning is kept by construction rather than by a pin: new bridge code reaches a plugin user only through a deliberate plugin release, because the bridge is part of that release.

A configuration the user writes by hand is not a spawn site the repository ships. It MAY run the published package with `npx -y @rembric/mcp-bridge@<version>`; this is the documented setup for stdio-only clients and for Hermes Agent configured without the TUI installer. Documentation that shows that form SHALL name an exact version as a placeholder, never `@latest` or another floating tag, because `npx` re-resolves a floating tag on every session start.

#### Scenario: Claude Code spawns the plugin-local bridge

- **WHEN** `apps/plugin/.claude-plugin/mcp.json` is read
- **THEN** `mcpServers.rembric.command` SHALL be `node`
- **AND** `mcpServers.rembric.args` SHALL be exactly `["${CLAUDE_PLUGIN_ROOT}/mcp-bridge/cli.mjs"]`

#### Scenario: Codex CLI spawns the plugin-local bridge from the plugin directory

- **WHEN** `apps/plugin/.codex-plugin/mcp.json` is read
- **THEN** `mcpServers.rembric.command` SHALL be `node`, `mcpServers.rembric.args` SHALL be exactly `["./mcp-bridge/cli.mjs"]`, and `mcpServers.rembric.cwd` SHALL be `.`
- **AND** `mcpServers.rembric.env_vars` SHALL include `PWD`

#### Scenario: opencode and Hermes spawn the bridge the installer placed

- **GIVEN** the TUI installer has installed opencode or Hermes Agent
- **WHEN** the rembric MCP entry it configured is read
- **THEN** the entry SHALL spawn `node` with `~/.config/rembric/bin/cli.mjs`, with `~` expanded to the user's home directory
- **AND** the bridge files in `~/.config/rembric/bin/` SHALL come from the same ref as that client's other installed files

#### Scenario: No plugin or installer spawn site uses npx or the npm registry

- **WHEN** the plugin manifests, the opencode config hook and every MCP block the installers write or print are read
- **THEN** none SHALL invoke `npx` for the bridge
- **AND** none SHALL name an `@rembric/mcp-bridge@<version>` package specifier

#### Scenario: A documented hand-written configuration names an exact version

- **WHEN** documentation shows a hand-written configuration that runs `npx -y @rembric/mcp-bridge@<version>`
- **THEN** the version SHALL be an exact-version placeholder
- **AND** it SHALL NOT be `@latest` or any other floating tag
