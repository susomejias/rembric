## Context

`include_global` reached the codebase on 2026-07-12 via `improve-recall-and-plugin-parity`, which built it to satisfy `memory/spec.md:77` ("when scoped to a project, results MAY also include `global` memories at the caller's request"). An internal audit the day before had flagged that requirement as unimplemented drift. The implementation closed it and opened two others, because it was never cross-checked against the two requirements that already constrained the argument's reach:

- `mcp-api/spec.md:24` — "The `includeGlobal` argument SHALL be ignored on path-scoped connections", with a scenario at `:34-40` that names `includeGlobal=true` explicitly.
- `auth/spec.md:63-66` — a project-restricted token invoking a read tool whose effective scope is global is rejected with `forbidden`.

Both were checked by execution rather than reading, against `main` at f1aa568, using a throwaway vitest probe with a real `project:<id>` token instead of the `*` scope every existing test in the file uses:

```
✓ isAuthorized denies global reads to a project-pinned token
✗ memory.search with include_global returns global rows to that same token
  token scope 'project:01KYYJ56…' -> 2 rows, 1 global: [ 'SECRET user-wide preference' ]
✗ path-scoped search must ignore includeGlobal
  admin token on /mcp/<slug> -> [ 'project:project-A preference', 'global:SECRET user-wide preference' ]
```

The authorization half matters most through OAuth, where the scopes minted for a `/mcp/<slug>` grant are exactly the project-pinned ones (`services/oauth.ts:343`): a connector consented for one project reads all user-wide memory. The isolation half matters most in practice, because the shipped plugin only ever opens path-scoped connections — one MCP entry per client, and `bin/rembric-bridge.mjs:56-72` derives the path from `.rembric`.

Constraint that shapes everything below: `include_global` exists on exactly one tool. `memory-tools.ts:150` declares it and `:960` consumes it; nothing else in `apps/server/src/mcp/` mentions it. So the entire fix is one guard in one function.

## Goals / Non-Goals

**Goals:**

- A token that `isAuthorized` denies for global reads receives no global rows from `memory.search`, by any argument.
- Path-scoped connections behave as `mcp-api/spec.md:24` already specifies, on all three branches the argument reaches.
- A legitimate client that passes `include_global` habitually keeps working, with narrower results, rather than starting to fail.
- No spec requirement is rewritten. The code moves to the published contract; only genuinely-new behaviour is added as spec text.

**Non-Goals:**

- Widening any automatic recall path. `memory.context` and `POST /:slug/memory/recall` stay project-only; that question is issue #299 and is deferred pending content in `global` worth finding and a measurement from `test/retrieval/`.
- Widening `memory.get`. `mcp-api/spec.md:24` has a separate clause returning `not_found` for a cross-scope id "to avoid leaking existence across scopes", and changing it is a different decision.
- Adding a token scope meaning "this project **and** global". `TokenScope` is `'*' | 'read:*' | project:<id> | read:project:<id>` (`services/tokens.ts:47`) — all-or-one-project, no combination. Introducing one means new parsing, dashboard UI, and OAuth mapping, and is not needed to close either gap.
- Fixing the `project.use`-less path where a project-pinned token on `/mcp` gets `forbidden` from `memory.context` (issue #302). Same axis, opposite direction, separate change.

## Decisions

### D1 — Ignore rather than reject

Chosen: drop the widening and serve project-only results.

`mcp-api/spec.md:24` already picked the verb — "SHALL be ignored" — so the path-scoped half is not a free choice. Applying the same verb to the token half keeps one rule for one argument instead of two behaviours depending on how project scope was reached.

_Alternative: reject with `forbidden`._ Closer in spirit to `auth/spec.md:63-66`, and arguably more honest. Rejected because the caller **is** authorized for every row it receives, so failing the call punishes a client for asking rather than for accessing; and because it would make the two halves of the same argument diverge. A rejection also breaks any existing caller that passes the flag by default, for zero security gain over narrowing.

_Alternative: reject on the token half, ignore on the connection half._ Rejected as the worst of both — the same argument would behave two ways for reasons the agent cannot see.

### D2 — Silent, with no marker in the response

Chosen: no `includeGlobalIgnored` field or equivalent.

"Ignored" in the existing requirement means ignored. Adding a marker means specifying it, budgeting for it in the hottest read response, and keeping it accurate on three branches.

_Trade-off accepted:_ an agent that passed the flag cannot tell why it got nothing global, and may retry. Accepted because on path-scoped connections — the overwhelming majority, being every plugin client — the correct long-run answer is that the agent stops passing the flag at all, and the tool description is the place to say so, not the response.

### D3 — Gate all three branches at one point

Chosen: normalise the argument once in `handleSearch`, before building `SearchMemoriesInput`, so lexical, dense and entity branches all receive the already-decided value.

`memory-entities/spec.md:271` defines the entity widening as mirroring "the widening the ranked branches already implement for `include_global`", so the two cannot legitimately diverge. Deciding once upstream makes divergence impossible rather than merely discouraged; gating each branch separately would leave three places to forget.

_Alternative: gate inside `MemoryService.search`._ Rejected: the decision needs `getRequestContext()` (token scope and `requestedSlug`), and reading request context in a service would break the layering that keeps services callable from the dashboard and scripts. The MCP boundary is where transport facts belong.

### D4 — `ctx.requestedSlug` as the path-scoped discriminator

Chosen: `ctx.requestedSlug !== null`, matching the write-side `scope_locked` gate at `memory-tools.ts:786`, whose comment states the rule: "path-scoped" means the URL carried a slug, whether or not it resolved to an existing project.

_Alternative: `ctx.project !== null`._ Rejected: it is false for a slug that does not resolve, which would silently re-open the widening on exactly the malformed-configuration case, and it would make read and write disagree about what "path-scoped" means.

### D5 — ADDED requirements, not MODIFIED

Chosen: both delta specs use `## ADDED Requirements`.

The path-scoped isolation requirement and `auth`'s scope-enforcement requirement are not changing — the code is moving to them. What is new is the normative statement that a _result-set widening_ is authorized separately from the _effective scope_, which no requirement states today. An `ADDED` requirement says that without touching text that is already correct, and avoids the failure mode where a partially-copied `MODIFIED` block silently reverts detail at archive time.

_Known ambiguity deliberately left:_ the existing scenario at `mcp-api/spec.md:1657` ("Entity combines with include_global") says globals are returned when the tool is "called in the project scope" with `entity` and `include_global`. Read by layer that means the `project.use` case and is consistent with this change, but the phrasing does not exclude a path-scoped reading — and that class of ambiguity is what shipped this defect. Left as-is because disambiguating it requires a `MODIFIED` copy of the long requirement at `:1604` for a wording change, and the new requirement here carries an explicit path-scoped entity scenario that constrains the case more specifically. Worth folding into any future change that touches `:1604` for other reasons.

## Risks / Trade-offs

- [Risk] An operator today relying on `include_global` from a path-scoped connection loses results silently after upgrade → Mitigation: they keep the capability by connecting at `/mcp` and calling `project.use`, which the `scope_locked` error text already points at; and the behaviour they lose was never specified as available. Worth a CHANGELOG line rather than a migration.
- [Risk] The guard is written against `ctx.requestedSlug` and a future transport (a third path shape, a new header) resolves project scope without setting it, re-opening the hole → Mitigation: the token half of the gate still holds in that case, so the authorization bypass cannot reappear even if the isolation half is bypassed. The two conditions are deliberately independent rather than nested.
- [Trade-off] No response marker (D2) → Accepted because the alternative specifies new surface on the hottest read for an agent-visible hint that the tool description can carry instead.
- [Trade-off] `mcp-api/spec.md:1657` stays ambiguous (D5) → Accepted because a botched `MODIFIED` delta is a worse failure than an ambiguity that the added scenarios already cover for the case that matters.
- [Risk] The existing test at `memory-tools.test.ts:628` passes today and will keep passing, giving false confidence that the area is covered → Mitigation: the new tests must use a project-pinned token and an explicit `include_global: true`, and each must be observed failing before the guard lands. A test that is green both before and after proves nothing here.

## Migration Plan

None. No schema change, no data change, no dependency change, no plugin change. Rollback is reverting the commit; no state is written that a rollback would strand.

Disclosure sequencing is an operational matter rather than a migration step: this change's text describes the bypass, so it lands on `main` unpushed until the operator decides to release, with GHSA-cc4j-ch4r-9pf5 published after an image carrying the fix exists.

## Open Questions

None blocking. Two deliberately deferred to their own issues: whether `memory.get` should gain token-gated widening (#299's neighbourhood), and whether a project-pinned token on a path-less connection should resolve to its own project rather than to global (#302).
