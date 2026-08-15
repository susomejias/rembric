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

The bridge replaces `mcp-remote` for standard stdio MCP hosts. Host-specific runs are recorded below; an unverified host is supported by the transport contract, not claimed as a measured host run.

| Host         | Status and evidence                                                                                                                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code  | **Verified 2026-08-15 on Linux, Claude Code 2.1.233**: initialize/clientInfo passthrough, normal tool call, one 404 recovery, and server-initiated `roots/list` relay were exercised against the recorded Streamable HTTP stub (`measurements/gate-arms-run.log`, `gate-arm3-roots-relay.log`). |
| opencode     | **Supported, host run unverified**: its plugin starts this exact stdio bridge; subprocess tests cover initialize passthrough, HTTP/SSE framing, and 404 recovery.                                                                                                                               |
| Codex CLI    | **Supported, host run unverified**: its manifest starts the same exact-pinned stdio bridge.                                                                                                                                                                                                     |
| Hermes Agent | **Verified by operator configuration**: Hermes requires the documented explicit `mcp_servers.rembric.env` map; the bridge works once that map is present.                                                                                                                                       |
| Pi           | **Not applicable**: Pi has its own in-process MCP client and does not use this bridge.                                                                                                                                                                                                          |
| Windows      | **Supported, host run unverified**: no Windows CI or recorded run exists.                                                                                                                                                                                                                       |
