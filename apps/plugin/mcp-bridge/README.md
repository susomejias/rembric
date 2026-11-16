# @rembric/mcp-bridge

A zero-dependency MCP stdio-to-Streamable-HTTP bridge for Rembric. It is started
with `npx -y @rembric/mcp-bridge@<exact-version>` and takes no arguments.

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
| Codex CLI    | **Supported, host run unverified**: its manifest starts the same exact-pinned stdio bridge.                                                                                                                  |
| Hermes Agent | **Verified by operator configuration**: Hermes requires the documented explicit `mcp_servers.rembric.env` map; the bridge works once that map is present.                                                    |
| Pi           | **Not applicable**: Pi has its own in-process MCP client and does not use this bridge.                                                                                                                       |
| Windows      | **Supported, host run unverified**: no Windows CI or recorded run exists.                                                                                                                                    |
