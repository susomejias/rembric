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

## 1. Transport design: SDK → zero-dependency (APPLIED to the artifacts)

The artifacts originally specified a package built on `@modelcontextprotocol/sdk`
transports. That was reversed, and the reversal **has now been written into the
artifacts**: `specs/mcp-bridge/spec.md` requires an empty `dependencies` object and adds
a normative requirement for the server-initiated-request relay, and the package name is
normalised to `@rembric/mcp-bridge` throughout. The remaining `@rembric/mcp-proxy`
mentions are deliberate historical record (this file, and the header of the superseded
SDK prototype).

The two measured reasons, kept here because the spec states the rule and not the whole
history:

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

## 1b. The spec deltas are STALE and would be refused at archive

`node scripts/check-delta-freshness.mjs --strict-body` reports **16 blocking problems**
across six capabilities: `claude-code-plugin`, `codex-distribution`, `hermes-agent-plugin`,
`opencode-plugin`, `open-source-distribution`, `supply-chain-hygiene`.

Verified pre-existing, not introduced by the zero-dep revision: the same 16 appear with
the revision stashed. They are a defect in how the deltas were constructed — MODIFIED
headers that match no published requirement (so archive would ADD a duplicate rather than
replace), published scenarios missing from the delta, and published body lines not
reproduced verbatim.

The fix is what the tool says: for each flagged requirement, take the **published** text
from `openspec/specs/<capability>/spec.md` and re-apply only this change's edits on top,
rather than writing the requirement afresh. Do this before the applier runs — a stale
delta silently reverts what another change published, and `archive` refuses it anyway.

## 2. The prototype gate — STOP arm CLEARED, two arms still open

The gate is phase 1 of `tasks.md`. Its STOP condition has been discharged: the
zero-dependency design is viable. Status:

| Arm                                                                  | Status                                                                 |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **roots/list relayed bidirectionally over the tool-call SSE stream** | **PASSED (zero-dep) — this was the STOP**                              |
| 404 → re-init → retry                                                | PASSED (zero-dep, and separately with the SDK prototype)               |
| `clientInfo` passthrough                                             | PASSED (zero-dep) — verbatim, unlike the SDK path where it was a guess |
| Server restart mid-session → recovery                                | NOT RUN                                                                |
| Session-start latency vs the mcp-remote chain                        | NOT RUN                                                                |

**The STOP arm, verbatim from `measurements/gate-arm3-roots-relay.log`** — a real
`claude` CLI driving a real `dev:docker:up` server through
`measurements/prototype-zerodep.mjs` on a path-less `/mcp`:

```
[proto0] up. url=http://127.0.0.1:8788/mcp
[proto0] server-initiated request on stream: roots/list id=0 -> host
[proto0] host response id=0 -> server
```

The server initiated `roots/list` on a tool call's SSE stream, the proxy handed it to
the host, the host answered, and the proxy posted that answer back. This was the only
genuinely unknown mechanism in the design — Pi's client sends `capabilities: {}` and
never exercises it, so the repo had no precedent. **Hand-rolled relay works.**

Two notes on reading that run, so nobody re-derives them:

- The probe's `project.current` resolved to the **default** project, not to the
  directory's slug. That is an artifact of the harness, not a relay failure: the
  `demo-writer` token is pinned to project `demo`, so it could not activate `billing`
  regardless of what roots reported (an earlier arm surfaced the explicit
  `forbidden … this token is pinned to project 'demo'` refusal). Use an admin token or a
  matching project when re-running.
- The host swallows an MCP server's stderr, so the proxy's own log is invisible if you
  rely on stderr passthrough. Wrap the command (`sh -c 'exec node proto.mjs 2>>log'`) to
  capture it — the first attempt at this arm produced no evidence for exactly this
  reason.

Arms 1-2 were also re-run under zero-dep (`measurements/gate-arms12-zerodep.log`):
`clientInfo=zerodep-probe@7.7` reached the server verbatim, and a killed session
recovered `s1 → 404 → s2 → call ok`. The older SDK-prototype results in
`measurements/gate-arms-run.log` are superseded.

Why the gate came first, in this repo's own words: `evict-stale-transport-state` was
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
