## Why

An admin working from an agent session cannot finish setting up a repository without leaving it. In a git checkout nobody has bound, every scope-resolving tool answers `project_unbound`, and the remedy it names is `project.bind_repository({ slug })` — which binds only to a project that already exists. When the project is new, `project.bind_repository` refuses with `project_not_found` and its message sends the admin to the dashboard (`packages/core/src/services/repository-bindings.ts:225`), because the published contract forbids any MCP tool from creating a project (`openspec/specs/projects/spec.md:13`, `openspec/specs/mcp-api/spec.md:2649`). The dashboard already creates a project and binds a fingerprint in one form (`apps/web/src/app/dashboard/projects/actions.ts:41`); the agent has no equivalent.

The rule was written when the only creation path over MCP was `project.use({ autocreate: true })`, which created a project as a side effect of naming it, for any writing token. What the rule protects is still worth protecting: a token reaching a set of projects must not mint new ones, and resolving a URL slug must never insert a row. Neither depends on the dashboard being the only surface. An explicit tool, restricted to the admin token that can already create projects from the dashboard, keeps both.

## What Changes

- **New `project.create` MCP tool**, admin token (`*`) only. Strict input: `slug`, optional `displayName`, optional `bindRepository`. It creates the project through `ProjectsService.create` (same slug rule and conflict detection as the dashboard) and returns `{ slug, projectId, displayName, binding, message }`.
- **Opt-in repository binding.** With `bindRepository: true`, the tool binds the repository identified by the request's `X-Rembric-Repo-Fingerprint` header to the new project when the repository is a bind candidate: the header carries a fingerprint and that fingerprint has no binding. Otherwise the project is still created and `binding` reports `skipped` with `repository_fingerprint_unavailable` or `repository_already_bound`. Without `bindRepository`, nothing is bound and `binding.status` is `not_requested`. The fingerprint is never a tool argument.
- **Refusals**: a non-admin token gets `admin_token_required` before any validation; an invalid slug gets `invalid_slug`; an existing slug gets `project_already_exists`, naming `project.bind_repository` as the way to bind to it.
- **Remedy text**: the `project_unbound` message and the `project_not_found` message of a connection whose slug names no project name `project.create` for an admin token, and `project.bind_repository`'s `project_not_found` message names it too. A client without plugin connected at `/mcp/<slug>` for a project that does not exist yet can create it and keep working on the same URL: the slug is resolved on every request.
- **Fix: a taken slug answers `conflict`.** `ProjectsService.create` was specified to fail with `conflict` on a taken slug ("Concurrent `create` with the same slug"), but the repository's `INSERT` threw the raw SQLite `UNIQUE` error, so the dashboard's create form threw on a duplicate slug instead of showing an error. The insert now ignores a `slug` conflict and returns nothing, which the service already turns into `conflict`.
- **Contract**: "projects are created from the dashboard only" becomes "from the dashboard, or by an admin token through `project.create`". Set-scoped and project-scoped tokens still have no path to create a project, and resolution still never creates one.

This change touches the **path-scoping** invariant and declares the exception: `project.create`, like `project.bind_repository`, names a project other than the connection's, and resolves no effective scope; it never switches the connection's project. **Append-only memory** is unaffected: a project row and a binding are configuration, and no memory or session row is written, moved or rewritten.

**Depends on** `select-project-by-repo-fingerprint`: its code has shipped but it is not archived. This change's `repository-binding` delta modifies a requirement that change adds, so archive it first. The `mcp-api` project-tools requirement that change renames to "three project-management tools" cannot be renamed again by a delta until it is published; task 4.2 carries that edit to archive time, and the new `project.create` requirement states the exception in the meantime.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `projects`: projects are created from the dashboard or by an admin token through `project.create`.
- `mcp-api`: a fourth `project.*` tool, `project.create`, with its contract; the authorization requirement names it as the only tool that creates a project.
- `auth`: only an admin token may create a project; set-scoped tokens still have no path to one.
- `repository-binding`: the admin remedy in the `project_unbound` message names `project.create`.

## Impact

- `packages/mcp/src/project-tools.ts`: `projectCreateSchema`, `projectCreateOutput`, `handleCreate`.
- `packages/mcp/src/server.ts`: registers `project.create` with write annotations.
- `packages/mcp/src/_shared.ts`: admin remedy in `unboundMessage` and `unresolvableSlugError` (which now takes the token scope); `packages/mcp/src/session-tools.ts` passes it.
- `packages/core/src/services/repository-bindings.ts`: `project_not_found` message in `bindUnbound`.
- `packages/core/src/services/errors.ts`: `project_already_exists`.
- `packages/db/src/repositories/projects-repository.ts`: `insert` ignores a `slug` conflict.
- Tests: `apps/web/src/test/mcp-http.test.ts`, `apps/web/src/test/mcp-tool-surface.test.ts`, `apps/web/src/test/mcp-transport.test.ts`, `apps/web/src/test/dashboard/projects-repositories-actions.test.tsx`, `packages/core/src/services/projects.test.ts`, `packages/mcp/src/unresolvable-slug.test.ts`, `packages/mcp/src/unbound-message.test.ts`.
- `docs/agents.md`: the admin path from an agent session.
- No schema, migration, dependency or plugin change. The plugins' session-start text keeps naming the dashboard and `project.bind_repository`; it is generated client-side in five clients and stays out of this change.
