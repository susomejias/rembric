# Rembric MCP bridge

A zero-dependency MCP stdio-to-Streamable-HTTP bridge for Rembric. It ships in
the plugin tree, is started with `node <dir>/cli.mjs`, and takes no arguments.
It is not published to npm.

The bridge is six modules that must sit in one directory: `cli.mjs`,
`bridge.mjs`, `slug.mjs`, `rembric-host-binding.mjs`, `rembric-project.mjs` and
`rembric-dotenv.mjs`. Claude Code and Codex run them from the installed plugin
(`${CLAUDE_PLUGIN_ROOT}/mcp-bridge/cli.mjs`, and `./mcp-bridge/cli.mjs` from the
plugin directory). For opencode and Hermes the TUI installer places them in
`~/.config/rembric/bin/`, from the same ref as the client's other files.

Earlier plugin versions started the bridge with
`npx -y @rembric/mcp-bridge@<version>`. Every version already on npm stays
installable, so such an entry keeps working on the version it names. The
entries the plugins and the installer manage switch to the `node` form on the
client's next plugin or TUI update; nobody has to migrate by hand.

Set `REMBRIC_SERVER_URL` (without `/mcp`) and `REMBRIC_API_TOKEN` in the
process environment. The project directory is selected from
`CLAUDE_PROJECT_DIR`, then `PWD`, then the current working directory. The
project is resolved once, at startup, in this order:

1. The nearest `.rembric` file containing `PROJECT_SLUG=<slug>`: the project
   directory, then each parent up to the git checkout root. Outside a git work
   tree only the project directory is read.
2. `REMBRIC_PROJECT_SLUG`.
3. Inside a git work tree only: the repository fingerprint (the first-parent
   root commit), resolved by the server's `POST /api/repositories/resolve`.

Outside a git work tree with no slug, the bridge uses path-less `/mcp`, which
resolves to the server's default project, and writes one stderr diagnostic
naming the fix. Inside a git work tree every request carries
`X-Rembric-Repo-Fingerprint` (the fingerprint, or `unavailable` for a shallow
clone or a repository with no commit), and the bridge never falls back to the
default project: an unbound repository connects path-less in unbound mode,
where the server refuses every memory tool, and any other answer (an older
server, a timeout, several bound projects) makes the bridge exit non-zero
with one diagnostic naming the remedy. Remote URLs are sent without
credentials. A slug the server does not know is refused with
`project_not_found`; create the project from the dashboard.

Every request also carries `X-Rembric-Session` when the host has declared its
session. At startup the bridge finds its host once: the nearest ancestor (parent
upwards, at most 8 hops) that is not a launcher, with its start time from
`ps -o lstart=` under `LC_ALL=C`. Launchers are shells and `env` (`sh`, `bash`,
`zsh`, `dash`, `ksh`, `fish`, `env`) and npm (`npm`, `npx`, `npm exec …`,
`node …/npm-cli.js`, `node …/npx-cli.js`). On each request it reads only
`<home>/.cache/rembric/host-sessions/<host pid>.json` and sends its `sessionId`
when `pid` and `start` match. It never looks past its host: a host that
publishes no binding (opencode, which injects `sessionId` per call instead) gets
no header even when an outer host, such as the Claude Code terminal it was
started from, has one. Reading per request is what makes a new session after
`/clear` take effect without restarting the bridge. The host's lifecycle code
publishes those files (the Claude Code and Codex hooks, the Hermes plugin); the
bridge never writes or deletes them. No matching file, no host within 8 hops, or
Windows, means no header, and the server falls back to its own attribution.

The bridge forwards MCP frames without creating a second client handshake. It
uses the path `/mcp/<slug>` when a valid slug is found, otherwise `/mcp`. Plain
HTTP and HTTPS are both accepted. HTTP errors reach the host unchanged; the
bridge never re-initializes or retries. The `/healthz` version check is
advisory and never prevents a connection.

## Compatibility

The bridge replaces `mcp-remote` for standard stdio MCP hosts. Host-specific runs are recorded below; an unverified host is supported by the transport contract, not claimed as a measured host run.

| Host         | Status and evidence                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code  | **Verified 2026-08-15 on Linux, Claude Code 2.1.233**: initialize/clientInfo passthrough and a normal tool call were exercised against the recorded Streamable HTTP stub (`measurements/gate-arms-run.log`). |
| opencode     | **Supported, host run unverified**: its plugin starts this exact stdio bridge; subprocess tests cover initialize passthrough, HTTP/SSE framing, and error propagation.                                       |
| Codex CLI    | **Supported, host run unverified**: its manifest starts the same stdio bridge from the installed plugin directory.                                                                                           |
| Hermes Agent | **Verified by operator configuration**: Hermes requires the documented explicit `mcp_servers.rembric.env` map; the bridge works once that map is present.                                                    |
| Pi           | **Not applicable**: Pi has its own in-process MCP client and does not use this bridge.                                                                                                                       |
| Windows      | **Supported, host run unverified**: no Windows CI or recorded run exists.                                                                                                                                    |
