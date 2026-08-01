## 1. Failing tests first

Every test in this group MUST be observed failing before any guard lands (design D-Risk: a test green on both sides proves nothing here). Add to `apps/server/src/mcp/memory-tools.test.ts`, with a helper that builds a request context carrying a real project-pinned `TokenScope` — the existing helpers all use `ADMIN_TOKEN_SCOPE = '*'`, which authorizes global legitimately and is why this shipped.

- [x] 1.1 Add a context helper accepting an arbitrary `TokenScope` (the file's `fakeContext` hardcodes `'*'`); assert `isAuthorized('project:<id>', 'read', {scope:'global'})` is `false` so the premise is pinned in the suite, not just in `tokens.ts`.
- [x] 1.2 Failing test: token `project:<id>` on a connection whose effective scope is that project, `memory.search({query, include_global: true})` returns zero rows with `scope === 'global'` AND the call does not error (`auth` delta, scenario "Project-restricted token requests global widening"). Observe it fail; record the observed global row count in the commit body.
- [x] 1.3 Same as 1.2 for `read:project:<id>`.
- [x] 1.4 Failing test: `*` token on a path-scoped connection (`requestedSlug` non-null), `memory.search({query, include_global: true})` returns no `global` row (`mcp-api` delta, scenario "Path-scoped connection with a full-access token"; also the pre-existing unmet `mcp-api/spec.md:34-40`). Observe it fail.
- [x] 1.5 Failing test: the entity branch under the same path-scoped condition — a global memory and a project memory linked to the same entity value, `memory.search({entity, include_global: true})` returns only the project one (`mcp-api` delta, scenario "The entity branch is gated identically"). Observe it fail.
- [x] 1.6 Control tests that MUST pass before and after: `*` token on a path-less connection with an active `project.use` gets globals with `include_global: true` (`mcp-api` delta, scenario "`project.use` scope with an authorized token"); and `search({})` without the argument is unchanged on every scope shape. A control that fails means the harness is wrong, not the code.
- [x] 1.7 Failing test: token `project:<id>` on a path-less connection with `project.use` active for its own project, `include_global: true` → succeeds, no global rows (`mcp-api` delta, scenario "`project.use` scope with a project-restricted token"). This is the case the token half of the gate exists for.

## 2. The guard

- [x] 2.1 In `handleSearch` (`apps/server/src/mcp/memory-tools.ts`, ~:944-960), resolve the effective value of the widening once before constructing `SearchMemoriesInput`: false when `ctx.requestedSlug !== null` (per design D4, matching the write-side gate at `:786`), else `args.include_global && isAuthorized(ctx.scope, 'read', { scope: 'global' })`. Pass only the resolved value onward, so no branch can be widened while another is narrowed (design D3).
- [x] 2.2 Use the non-throwing `isAuthorized` from `services/tokens.ts`, not `assertAuthorized` — denial must narrow the result, not reject the call (design D1). Do not add a marker field to the response (design D2).
- [x] 2.3 Confirm every test in group 1 is now green and every control in 1.6 is still green.
- [x] 2.4 Verify no other consumer of `args.include_global` exists: `grep -rn "include_global" apps/server/src/mcp/` should show only the schema declaration, the handler's parameter type, and this one resolution point.

## 3. Tool description and instructions text

- [x] 3.1 Update the `include_global` description in `memory-tools.ts` (~:150) to state that it has no effect on a path-scoped connection and requires a token authorized for global reads — this is where the agent learns not to pass it (design D2's mitigation). Keep within `DESCRIPTION_MAX_LENGTH`; the `entity` description at `:137` also names `include_global` among the narrowing filters and must stay accurate.
- [x] 3.2 Reword `apps/server/src/mcp/instructions.ts:33`. It currently tells a path-scoped agent to "open `/mcp` for user-wide memory", which the agent cannot do — one MCP entry per client, and the bridge derives the path from `.rembric`. State that global is reachable only on a connection the operator configures without a project slug.
- [x] 3.3 Confirm no plugin file needs a matching edit: `grep -rn "include_global" apps/plugin/` should be empty.

## 4. Verification

- [x] 4.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 4.2 `pnpm test` fully green, with no test skipped or weakened to accommodate the guard. If an existing test goes red, that is a finding to report, not a test to adjust.
- [x] 4.3 Confirm `apps/server/src/test/invariants.test.ts` is unaffected (no SQL moved, no `admin*` / `unsafe*` call added).
- [x] 4.4 Confirm `POST /:slug/memory/recall` behaviour is untouched — `api-router.test.ts`'s recall cases pass unchanged and `grep -n "includeGlobal" apps/server/src/server/api-router.ts` stays empty (`http-api/spec.md:386`).
- [x] 4.5 Re-run the two original reproduction probes from the advisory and record that both now behave correctly, in the commit body.

## 5. Close-out

- [x] 5.1 `/simplify` over the diff, then `/code-review`; resolve findings before archiving.
- [x] 5.2 Archive via the `sdd-archiver` agent; verify both delta specs merged into `openspec/specs/{auth,mcp-api}/spec.md` and that neither overwrote an unrelated requirement.
- [x] 5.3 `pnpm run check:spec-provenance` clean.
- [ ] 5.4 **Operator decision before push.** This change's text describes the bypass, so pushing publishes it ahead of any released fix. Commit to `main` and STOP; the operator decides when to push and when to publish GHSA-cc4j-ch4r-9pf5.
