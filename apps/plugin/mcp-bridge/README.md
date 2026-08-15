# @rembric/mcp-bridge

A zero-dependency MCP stdio-to-Streamable-HTTP bridge for Rembric. It is started
with `npx -y @rembric/mcp-bridge@<exact-version>` and takes no arguments.

Set `REMBRIC_SERVER_URL` (without `/mcp`) and `REMBRIC_API_TOKEN` in the
process environment. `REMBRIC_PROJECT_SLUG` is an optional fallback. A
`.rembric` file in the resolved project directory wins over that fallback.
The directory is selected from `CLAUDE_PROJECT_DIR`, then `PWD`, then the
current working directory. A valid `.rembric` slug wins over
`REMBRIC_PROJECT_SLUG`; otherwise the bridge uses path-less `/mcp`.

The bridge forwards MCP frames without creating a second client handshake. It
uses the path `/mcp/<slug>` when a valid slug is found, otherwise `/mcp`. Plain
HTTP and HTTPS are both accepted. The `/healthz` version check is advisory and
never prevents a connection.

## Compatibility

| Host         | Status and evidence                                                                                                                                                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code  | **Verified 2026-08-15 on Linux, Claude Code 2.1.233**: initialize/clientInfo passthrough, normal tool call, one 404 recovery, and server-initiated `roots/list` relay were exercised against the recorded Streamable HTTP stub (`measurements/gate-arms-run.log`, `gate-arm3-roots-relay.log`).                                  |
| opencode     | **Unverified**: no real opencode host run is recorded; the Node subprocess tests cover initialize passthrough, HTTP/SSE framing, and 404 recovery but do not establish opencode compatibility.                                                                                                                                   |
| Codex CLI    | **Unverified for session-level arms**: an authenticated Codex process reaches production through its account-level connector, so it is not driven against the probe stack. The same package/bin resolution is shared by construction, but Codex's manifest changes in this change; it does not inherit an untouched shared file. |
| Hermes Agent | **Unverified**: the README/config block is documented and the bridge package is tested as a Node subprocess, but no real Hermes host run is recorded.                                                                                                                                                                            |
| Pi           | **Not applicable**: Pi has its own in-process MCP client and does not use this bridge; no bridge compatibility claim is made.                                                                                                                                                                                                    |
| Windows      | **Unverified**: this repository has no Windows CI and no Windows run is recorded. The package uses Node built-ins only, but that is not a measurement.                                                                                                                                                                           |
