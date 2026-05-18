## Why

Today a project can only be minted as a side-effect of `rembric token create --project=<slug>` (or the equivalent dashboard form), and when an MCP client lands on `/mcp` with no project pinned and no matching project for the slugs surfaced by roots-based discovery, every write silently falls through to `scope='global'`. Both behaviors confuse new operators and bury data in the wrong scope. We want a first-class "create project" path on the CLI and dashboard, and we want the MCP surface to refuse silent fallback to global when there is a pending project suggestion the agent has not yet acted on.

## What Changes

- **New CLI subcommand**: `rembric project create <slug> [--name <displayName>]` mints a project after validating with the existing `SLUG_REGEX`, prints the new row as JSON on success, exits non-zero (with a descriptive stderr) on conflict or invalid slug.
- **New CLI subcommand**: `rembric project list [--all] [--table]`, mirroring the existing `session list` shape (JSON by default; `--all` includes archived; `--table` switches to text).
- **Dashboard create form**: `/dashboard/projects` SHALL render a CSRF-protected mini-form (slug required + regex-validated, displayName optional) above the existing tables; it SHALL be always visible (no toggle), persist via `POST /dashboard/projects/create`, redirect with a `created=<slug>` flash on success and `error=<message>` on a DomainError.
- **MCP project-suggestion gate**: when an `/mcp` (path-less) request has no active project pinned and `roots/list` surfaced one or more candidate slugs that do not match any existing project, write tools (`memory.save` with default `scope='project'`, `memory.session_start` with no `project` arg) SHALL respond with structured code `project_suggestion_pending` and the candidate slugs, instead of falling through to global. Agents can resolve this by either passing `scope='global'` explicitly, or by calling `project.use({slug, autocreate:true})` to mint the suggested project (after asking the user). Path-scoped (`/mcp/<slug>`) connections are unaffected — they already enforce `scope_locked`.

## Capabilities

### New Capabilities

_None._ This change extends existing capabilities.

### Modified Capabilities

- `projects`: adds a "MAY be created via CLI or dashboard form" requirement and the matching display semantics for the dashboard form.
- `mcp-api`: adds a "MUST surface `project_suggestion_pending` instead of silently falling to global" requirement for `/mcp` (path-less) writes when the agent has pending root suggestions and no active project.

## Impact

- **Code**: new `src/cli/project-cli.ts`, new commander subtree in `src/cli.ts`, new POST handler + form block in `src/dashboard/projects.ts`, new branch in `src/server/session-router.ts` / `src/mcp/tools.ts` / `src/mcp/sessions-tools.ts` that consults the pending-suggestion list before defaulting the scope.
- **Schema / DB**: none — `projects.create` already validates and `agentSessions`/`memory` schemas are unchanged.
- **Tests**: new CLI tests in `src/cli/cli.test.ts`, new dashboard E2E case in `src/test/dashboard-e2e.test.ts`, new MCP integration cases asserting the new error code path.
- **Docs**: short `agents.md` section explaining how to handle `project_suggestion_pending`, plus a one-line CLI reference update.
