## MODIFIED Requirements

### Requirement: The bridge takes no arguments; its entire contract is the environment

The package SHALL expose exactly one executable, resolvable by `npx @rembric/mcp-bridge@<version>` with no bin-name argument, and that executable SHALL accept **no command-line arguments**.

Its inputs are three environment variables and the host binding:

- `REMBRIC_SERVER_URL` — the base URL, without the `/mcp` suffix. **Required.**
- `REMBRIC_API_TOKEN` — the bearer, injected as `Authorization: Bearer <token>` on every request to the endpoint. **Required.**
- `REMBRIC_PROJECT_SLUG` — an optional default slug, used only when no `.rembric` slug resolves.
- The host binding — the files `<home>/.cache/rembric/host-sessions/<pid>.json` that the host's lifecycle code publishes for the bridge's host process, read as "The bridge declares the host session from the host binding" specifies. It is optional: with no matching file the bridge behaves exactly as it does without one.

Besides the bearer and the repository fingerprint, the bridge's only added request header is `X-Rembric-Session`, sent when the host binding names a session. Its value comes from the host binding and never from an argument or an environment variable.

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

## ADDED Requirements

### Requirement: The bridge declares the host session from the host binding

At startup, on every platform except `win32`, the bridge SHALL find its host once: the nearest ancestor, walking from its parent process upwards at most 8 hops and stopping before PID 1, that is not a launcher. A launcher is a process whose `comm` basename, with a leading `-` removed, is one of `sh`, `bash`, `zsh`, `dash`, `ksh`, `fish`, `env`, `npm`, `npx`, or whose command line (`ps -o args=`) starts with `npm` or `npx`, or a path ending in `/npm` or `/npx`, followed by a space or the end, or is `node` running a path ending in `npm-cli.js` or `npx-cli.js`. The shell and launcher names SHALL agree with the shared fixture `apps/plugin/test/host-binding-layout.json` (`nonHostCommands`, `launcherCommands`). The bridge SHALL record the host's start token: the stdout of `ps -o lstart= -p <pid>` run with `LC_ALL=C`, with runs of whitespace collapsed to one space and trimmed. A live process's ancestors and their start times do not change, so the host SHALL NOT be recomputed. With no host within 8 hops, or a host whose start token is unavailable, the bridge SHALL send no header.

On every request it forwards, `initialize` included, the bridge SHALL read `<home>/.cache/rembric/host-sessions/<host pid>.json`, where `<home>` is `os.homedir()`, and send its `sessionId` as `X-Rembric-Session` when its `pid` and `start` equal the host's and its `sessionId` matches `^[A-Za-z0-9_-]{8,128}$`. An unreadable file, a parse error, a `pid` or `start` mismatch or a malformed `sessionId` SHALL mean no header. The bridge SHALL consider exactly one process: it SHALL NOT read the binding of any process beyond its host, because an outer host's session is not the bridge's session — opencode started from a Claude Code terminal, a Hermes process that withdrew its binding, or a host whose own hook failed would otherwise be misattributed to the outer host. The bridge SHALL never send the header empty. Reading per request is what makes a session that the host switched (after `/clear`, a resume or a compaction) take effect without restarting the bridge.

The bridge SHALL NOT write or delete binding files. On `win32` it SHALL record no chain and send no header.

The start token, the directory, the lookup, and the publish and remove used by the opencode plugin SHALL live in one module, `apps/plugin/mcp-bridge/rembric-host-binding.mjs`, shipped in the published package, and its constants SHALL be asserted against the shared layout fixture `apps/plugin/test/host-binding-layout.json`. The invariant test SHALL fail when another JS/TS plugin file defines them.

#### Scenario: A bound host's session is sent on every request

- **GIVEN** the bridge's parent is an `npm exec @rembric/mcp-bridge@<version>` launcher whose parent is the host
- **AND** a host binding for the host whose `pid` and `start` match and whose `sessionId` is `<S>`
- **WHEN** the bridge forwards `initialize`, the initialized notification and a `tools/call`
- **THEN** each of those requests SHALL carry `X-Rembric-Session: <S>`

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
