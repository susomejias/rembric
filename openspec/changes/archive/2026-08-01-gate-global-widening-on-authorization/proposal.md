## Why

`memory.search`'s `include_global` widens a project-scoped search to also return `global` rows without re-authorizing against the global scope, so a token deliberately pinned to one project reads the entire user-wide scope. Measured against `main` (f1aa568) with a real `project:<id>` token: `isAuthorized` denies the global read, and the search returns the global row anyway. The same call site also fails the isolation contract `mcp-api` has specified since before `include_global` existed.

Both are conformance gaps, not contract changes: `openspec/specs/mcp-api/spec.md:24` already states the argument "SHALL be ignored on path-scoped connections", and `openspec/specs/auth/spec.md:63-66` already forbids a project-restricted token from reading global. The code never enforced either.

## What Changes

- `memory.search` SHALL ignore `include_global` on path-scoped connections (`/mcp/<slug>` or `X-Rembric-Project`), enforcing `mcp-api` §"Path-scoped connections MUST enforce strict project isolation" as already written. Applies to all three branches the argument reaches — lexical, dense, and entity — since `memory-entities` §271 defines the entity widening as mirroring `include_global`.
- On a connection that reached project scope via `project.use` rather than a path slug, `memory.search` SHALL honour `include_global` only when the request token authorizes a global read. When it does not, the widening SHALL be dropped and project-only results served — **not** an error, matching the "ignored" verb `mcp-api` already uses for the path-scoped case.
- `instructions.ts` no longer promises what the agent can act on: its "open `/mcp` for user-wide memory" line is reworded, since a path-scoped agent cannot open a second connection (one MCP entry per client; the bridge derives the path from `.rembric`).
- Not **BREAKING** for any authorized caller: `*` and `read:*` tokens on a path-less connection keep the widening. Behaviour changes only where it was never authorized, or on connections the spec already declared isolated.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `auth`: adds a scenario for result-set widening. The existing scenario at `spec.md:63-66` covers a project-restricted token whose _effective scope_ is global; it does not cover an authorized project scope whose _results_ are widened past it, which is the measured bypass.
- `mcp-api`: adds scenarios pinning `include_global` behaviour on a `project.use`-derived project scope (authorized → honoured, unauthorized → ignored). The path-scoped requirement and its scenario at `:24`/`:34-40` are unchanged — the code is moving to them.

## Impact

Durable invariants touched: **scope enforced at the service layer**. This change strengthens it — no scope resolution moves, and no repository read gains or loses a scope parameter; the widening argument simply stops being trusted unconditionally. Append-only, `topic_key` convergence and judgment freshness are untouched.

Code:

- `apps/server/src/mcp/memory-tools.ts` — `handleSearch` (~:944-960), the sole consumer of `args.include_global`; the guard lands beside the existing `assertAuthorized('read', scope)`.
- `apps/server/src/mcp/instructions.ts:33` — the reworded line.

Tests:

- `apps/server/src/mcp/memory-tools.test.ts` — the existing "no globals leak" case (:628) calls `search({})` without the argument, and every context helper uses `ADMIN_TOKEN_SCOPE = '*'`; both gaps are why this shipped. New cases need a project-pinned token and an explicit `include_global: true`.

No migration, no schema change, no dependency change, no plugin change. `/api/<slug>/memory/recall` is untouched — it never set `include_global` (`http-api/spec.md:386`) and stays that way.

Related: GHSA-cc4j-ch4r-9pf5 (private advisory, this is its fix), issues #299 (whose reproduction surfaced it) and #302 (the same "effective scope resolved without regard to what the token authorizes" axis, from the opposite direction; fixed separately).
