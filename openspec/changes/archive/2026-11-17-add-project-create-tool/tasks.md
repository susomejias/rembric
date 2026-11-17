# Tasks

## 1. Contract

- [x] 1.1 Add `openspec/changes/add-project-create-tool/` (`proposal.md`, `design.md`, this `tasks.md`) and the `projects`, `mcp-api`, `auth` and `repository-binding` deltas. `node scripts/check-delta-sections.mjs` and `node scripts/check-delta-freshness.mjs` report no blocking problem for this change; their REVIEW lines are this change's deliberate rewrites. `openspec validate --strict` was not run: the `openspec` CLI is not installed in this checkout.

## 2. The tool

- [x] 2.1 `packages/mcp/src/project-tools.ts`: `projectCreateSchema` (`slug`, `displayName?`, `bindRepository?`), `projectCreateOutput`, and `handleCreate` — admin check first, `ProjectsService.create` with `conflict` mapped to `project_already_exists`, then `RepositoryBindingsService.bindUnbound` only when `bindRepository` is true and the request carries a fingerprint; `repository_already_bound` is reported as `skipped`, not thrown.
- [x] 2.2 `packages/mcp/src/server.ts`: register `project.create` with `WRITE_ANNOTATIONS` and a description naming the admin token and the opt-in bind.
- [x] 2.3 Admin remedy names `project.create`: `unboundMessage` and `unresolvableSlugError` in `packages/mcp/src/_shared.ts`, and the `project_not_found` message of `bindUnbound` in `packages/core/src/services/repository-bindings.ts`.
- [x] 2.4 `docs/agents.md`: "Creating a project from an agent", and the places that said no tool creates a project.
- [x] 2.5 `packages/db/src/repositories/projects-repository.ts`: `insert` ignores a `slug` conflict, so `ProjectsService.create` raises `conflict` as `projects` specifies and the dashboard's create form shows an error on a taken slug instead of throwing.

## 3. Proof

- [x] 3.1 `apps/web/src/test/mcp-http.test.ts` drives `project.create` through the real `/mcp` route: create + bind from an unbound session, opt-in with the connection's project unchanged, not a candidate (bound, no header, `unavailable`), non-admin refusal before validation for a project-scoped and a set token with an admin control, invalid and existing slugs, a client at `/mcp/<slug>` that creates its project and saves into it on the next call, strict schema. All seven were RED before the tool existed.
- [x] 3.2 Tool-surface tests (`mcp-tool-surface`, `mcp-transport`, `unresolvable-slug`), `unbound-message`, `projects.test.ts` (RED before 2.5: a raw `SqliteError`) and `projects-repositories-actions.test.tsx` cover the new tool, the remedies and the conflict.
- [x] 3.3 `scripts/mutate.mjs`: nine mutations, each caught — the admin check, the `bindRepository` opt-in, the fingerprint check, the already-bound report, the conflict mapping, the admin-only `project_not_found` remedy, the `project_unbound` remedy, and the repository's `slug` conflict (against the service and the dashboard action tests).
- [x] 3.4 `pnpm run typecheck`, `pnpm run lint` and `pnpm test` pass.

## 4. Archive

- [x] 4.1 Operator-only: archive after `select-project-by-repo-fingerprint`, whose `repository-binding` delta this change's `repository-binding` delta modifies.
- [x] 4.2 At archive time, hand-edit what this change's deltas cannot reach while `select-project-by-repo-fingerprint` is unarchived: rename the `mcp-api` requirement "The MCP server MUST expose three project-management tools under the `project.*` namespace" to four tools, list `project.create` in its first paragraph and its "No project-switching or project-creating tool is offered" scenario, and replace "No tool SHALL activate, switch or create a project … projects are created from the dashboard" with the exception stated in "The MCP server MUST expose `project.create` to admin tokens". A RENAMED delta cannot carry it now: its `FROM:` header is not published yet, so `check:delta-sections` and `check:delta-freshness` refuse it.
- [x] 4.3 At archive time, after `select-project-by-repo-fingerprint` publishes its version of the `claude-code-plugin` requirement "A path-less bridge connection MUST resolve to the default project, and a new slug MUST be created from the dashboard": replace "The project SHALL be created from the dashboard; no agent-side bootstrap call exists" with the dashboard or, for an admin token, `project.create`, and update the quoted `project_not_found` text in its "Bootstrap for new slugs" note, which now ends with `or with project.create({ slug: '<slug>' })` for an admin token. A delta now would race that change's MODIFIED block of the same requirement: whichever archived second would silently revert the other.
