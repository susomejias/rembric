## Context

`project.bind_repository` (change `select-project-by-repo-fingerprint`) lets an admin token bind the client's repository to an existing project from an agent session. Creating the project itself is dashboard-only by contract. The dashboard's create action already creates a project and binds a fingerprint in one submission (`apps/web/src/app/dashboard/projects/actions.ts:41`): `ProjectsService.create`, then `RepositoryBindingsService.bindWithChoice` per target, collecting refused binds as messages rather than undoing the creation.

## Goals / Non-Goals

**Goals:** an admin creates a project from an agent session, and optionally binds the current repository to it, without the dashboard.

**Non-Goals:** moving or removing a binding over MCP; creating projects with a non-admin token; changing the plugins' session-start text; renaming or archiving projects over MCP.

## Decisions

### 1. Binding is opt-in

`bindRepository` defaults to false. An admin can create a project for another codebase while working in an unbound checkout; binding that checkout by default would send the next session's memories to the wrong project, and memory is append-only with no reassignment verb, so the misfiling would be permanent. The caller states the intent; the server checks whether the repository can be bound.

Alternative rejected: bind automatically whenever the repository is a candidate. It saves one argument and turns an unrelated creation into a permanent misfiling.

### 2. Create, then bind through `bindUnbound`; a refused bind does not undo the creation

The tool calls `ProjectsService.create`, then `RepositoryBindingsService.bindUnbound` — the method `project.bind_repository` uses, so the binding carries the same pending-row cleanup and remote copy. When the request has no fingerprint, the tool does not call `bindUnbound`; when `bindUnbound` refuses with `repository_already_bound`, the tool reports it. In both cases the project stays created and `binding.status` is `skipped` with the reason code.

This matches the dashboard's create action and the request as stated ("bind it when the repository is git and a bind candidate"). A creation that is rolled back because the repository is already bound would make the admin call the tool twice for one intent.

Alternative rejected: one transaction around both steps, refusing the whole call when the bind cannot happen. It needs a new cross-service method for a case the caller can read from the response, and it would refuse the creation the caller asked for.

### 3. `admin_token_required` comes before any check beyond the input schema

The MCP SDK validates the strict input schema before the handler runs, so an unknown property or a slug outside 1–128 characters is refused with a schema error for every token. The admin check is the handler's first statement, so a non-admin token learns nothing about the slug rule or which slugs exist. Same order as `project.bind_repository`.

### 4. A duplicate slug answers `project_already_exists`

`ProjectsService.create` throws `conflict` on a taken slug. The tool maps that one case to `project_already_exists`, whose message names `project.bind_repository({ slug })`: the usual reason an agent tries to create an existing project is that it wants to bind to it. The mapping catches the service's error rather than pre-checking, so a concurrent creation still lands on the same code.

### 5. No effective scope

Like `project.bind_repository`, the tool resolves no effective scope, so it works on path-scoped, path-less and unbound requests, and never switches the connection's project. A connection at `/mcp/<slug>` reaches the new project from its next call, because the server resolves the slug on every request; a binding applies from the next session, because the client resolves it once at session start.

## Risks / Trade-offs

- **Any `*` token can now create projects from an agent.** For a static admin token this adds a surface, not an authority: the same token already creates projects from the dashboard, whose login requires it. An OAuth grant consented on the path-less `/mcp` connection also resolves to `*` (`mcp-oauth`: "A grant consented on the path-less `/mcp` connection SHALL remain unbound") and can now create projects, which it could not before, because dashboard login accepts static tokens only. Such a grant is issued only after an operator signs in to the dashboard with the admin token and consents, so it is authority the admin delegated; `project.bind_repository` already accepts it the same way. → Mitigation: the admin check is the tool's first statement and is mutation-tested; a project-bound or read OAuth grant is refused.
- **A project created by mistake stays.** There is no delete; archive is dashboard-only. → The tool is opt-in for the agent like any write, and an empty project costs one row.
