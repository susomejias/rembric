# Handoff — read this before touching anything here

State as of 2026-08-15. This change is **NOT ready to apply**. Two things must
happen first, in order.

The change was called `replace-mcp-remote-with-rembric-mcp` while the artifacts were
being written. Renamed: it named a package that no longer exists under that name, and it
described only half the change — swapping the transport — when the substance is that
Rembric stops renting the client side and owns it. Older references may still use the old
folder name.

## 0. Package name and configuration surface (settled — do not reopen)

The published package is **`@rembric/mcp-bridge`** — owner's call, closed. The artifacts
in this folder were written against `@rembric/mcp-proxy`; rename to `@rembric/mcp-bridge`
when revising for §1.

`@rembric/mcp` was considered and rejected. The case for it was that the host sees this
package as an MCP server (it goes in `mcpServers`, is spawned as `command`, speaks stdio),
so the shorter name describes what a user is adding; and the collision worry is weak
because the Rembric server ships as a Docker image and is never published to npm. The
case against, which won: `mcp` is not a name, it is a category — it says nothing about
which of Rembric's MCP-related parts it is — and it forecloses the obvious name should
anything else Rembric-and-MCP ever need publishing. `-bridge` also keeps the vocabulary
already used across ~20 normative spec requirements, so those requirements migrate onto
the package with their wording intact.

Glossary after the integration: **"the bridge" = `@rembric/mcp-bridge`**, the published
client-side piece; `rembric-bridge.mjs` = its deprecated on-disk launcher, kept only for
opencode configs written before this change.

Its configuration surface is **exactly `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN`**,
nothing else required — the conventional shape, matching the generic name. Two rules:

- **The token is read from the environment and MUST NOT be accepted in `argv`.** Process
  arguments are world-readable via `ps` on the host; the current manifests inject it from
  the system keychain through `${user_config.api_token}`, and that property must survive.
- The `.rembric` slug is **not** user configuration. It is discovered from the project
  directory (`CLAUDE_PROJECT_DIR` > `PWD` > `cwd`) with a documented fallback to
  path-less `/mcp`, so it never enters the public config surface.

## 1. The proposal's transport design is superseded

`proposal.md` / `design.md` specify a package built on `@modelcontextprotocol/sdk`
transports. **That decision was reversed after the artifacts were written**, for two
measured reasons:

- **Dependency tree grows, it does not shrink.** Measured in a clean directory
  (`npm install --ignore-scripts`): `mcp-remote@0.1.38` → 80 packages / 7.0 MB;
  `@modelcontextprotocol/sdk@1.29.0` → 93 packages / 25 MB. The SDK declares
  `express`, `hono`, `cors`, `jose`, `eventsource`, `express-rate-limit` in
  `dependencies` (not peer). Building on it makes the supply-chain surface worse than
  the thing being replaced.
- **`initialize` passthrough is unproven with SDK transports.** With an SDK
  `Client`/`Server` pair the proxy re-initiates its own handshake, which is exactly how
  `mcp-remote` ends up rewriting `clientInfo`.

**Superseding decision: hand-rolled, zero-dependency**, following the precedent already
shipping in this repo — `apps/plugin/.pi-plugin/index.ts` is a working Streamable HTTP
MCP client with `dependencies: {}` that already parses SSE (see its `data:` line
handling around lines 110-130). Zero-dep wins on both objections: no tree at all, and
`clientInfo` passthrough becomes trivial because a raw pipe never constructs its own
`initialize`.

Everything else in the proposal stands: the integrated end-state, the exact-pin policy,
publishing via the existing trusted-publishing OIDC flow, and the recorded evidence.

## 2. The prototype gate has NOT been run to completion

The gate is phase 1 of `tasks.md` and carries an explicit STOP. Status:

| Arm                                                                  | Status                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| 404 → re-init → retry, standalone                                    | PASSED (SDK prototype)                                       |
| Real Claude Code recovers through the proxy                          | PASSED — `clientInfo=claude-code@2.1.233` reached the server |
| **roots/list relayed bidirectionally over the tool-call SSE stream** | **NOT RUN — this is the real STOP**                          |
| Server restart mid-session → recovery                                | NOT RUN                                                      |
| Session-start latency vs the mcp-remote chain                        | NOT RUN                                                      |

The two passing arms used the SDK prototype (`measurements/prototype-sdk-based.mjs`),
so they are **not** evidence for the zero-dep design. Re-run them against a zero-dep
prototype.

The roots arm is the whole risk: Pi's client sends `capabilities: {}` and therefore
never exercises a server-initiated `roots/list`, so the repo has no precedent for
relaying it. If that relay cannot be made to work hand-rolled, **stop** — do not
proceed to implementation.

Why the gate comes first, in this repo's own words: `evict-stale-transport-state` was
reverted the day before (`ba555da`) after ~1600 lines were built ahead of its merge
gate, which then failed.

## Reproduction assets (preserved from tmpfs)

- `measurements/session-terminating-stub.mjs` — Streamable HTTP stub that kills each
  session after its first successful `tools/call` and then answers `404`/`-32001`, per
  the MCP spec's session-management rules. Logs every request with timestamp and the
  `clientInfo` of each `initialize`. Run with `STUB_LOG=<path> node <file>`; listens on
  `127.0.0.1:8923`. Self-test it with curl before trusting any arm (call 1 → 200,
  call 2 → 404, fresh initialize → new session).
- `measurements/prototype-sdk-based.mjs` — the superseded SDK prototype. Kept as the
  record of the two passing arms, not as a starting point.
- `measurements/gate-arms-run.log` — the stub's request log from those arms.

## Protocol context that bounds this whole change

MCP revision `2026-07-28` **removes protocol-level sessions, the GET stream endpoint,
server-initiated JSON-RPC requests, and the `initialize` handshake** (per-request
`_meta.io.modelcontextprotocol/*` replaces it; roots/sampling/elicitation move to MRTR).
When the ecosystem reaches it:

- The `404`/re-init problem this change exists to fix **ceases to exist**.
- `SessionRouter` (keyed on `mcpSessionId`), most of `McpTransportManager`, the
  `c2affef` unknown-session `404`, issues #328/#348, and the roots-discovery design all
  need rework or deletion.

That migration is not imminent: `@modelcontextprotocol/sdk@1.29.0` declares
`LATEST_PROTOCOL_VERSION = '2025-11-25'` and does not support `2026-07-28` at all; the
2024-11-05 HTTP+SSE transport was deprecated in 2025-03-26 and is still only "eligible
for removal" 16 months later. The session-based world plausibly lasts a year or more,
which is what justifies fixing the hang now rather than waiting.

## Unrelated state left on disk

`main` carries **11 unpushed commits** from the issue-triage session (`7d3ba3c` through
`c2affef`): the #338 and #337 fixes, the `evict-stale-transport-state` implementation
and its revert, and the kept `404` + docstring commit. This branch
(`feat/rembric-mcp-bridge`) was cut from that HEAD, so it includes them. Pushing them is
a separate decision from anything in this folder.
