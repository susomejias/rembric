## Context

Project identity in Rembric is the cross-machine logical handle for a scope of memories. Today, every code path that admits a slug into the database does so as a side effect:

- `rembric token create --project=<slug>` lazily mints a project (`src/cli/token-cli.ts:34`).
- The dashboard token form does the same (`src/dashboard/tokens.ts:157`).
- `project.use({slug, autocreate:true})` over MCP mints on demand.

There is no first-class "create a project" entry point. Operators who want to pre-seed a project (so an agent can hit `/mcp` with no friction) have to mint a throwaway token or call MCP themselves. This is friction the dashboard already exposes for tokens, sessions, and memories — projects are the odd one out.

The second pain point is the silent fallback to `scope='global'`. The flow we observed today:

```
1. agent: project.current() → { slug: null, suggestedSlugs: ['rembric'] }
2. agent: project.use({slug:'rembric'}) → project_not_found
3. agent: memory.session_start() → ok, scope='global'
```

Step (3) is the bug. The MCP server _knows_ there is a pending root suggestion the agent hasn't acted on, but `memory.save` / `memory.session_start` default to `scope='project'` which the request-context resolver then downgrades to `'global'` because no project is pinned. The data is lost to the global scope without the agent or the user noticing.

`/mcp/<slug>` path-scoped connections already enforce strict isolation via `scope_locked`. The looser `/mcp` (path-less) entry needs a similar gate, but tuned for the discovery case: refuse the silent downgrade _only_ when there is a pending root suggestion the agent hasn't resolved.

## Goals / Non-Goals

**Goals:**

- Add a dedicated `rembric project create <slug>` CLI subcommand and a `rembric project list` sibling, modeled on the existing `session list` shape.
- Add an always-visible "Create project" form on `/dashboard/projects`, CSRF-protected, validating the slug client-side via the same regex and server-side via `ProjectsService.create`.
- Surface `project_suggestion_pending` from `memory.save` (default `scope='project'`) and `memory.session_start` (no `project` arg) when (a) the connection is path-less (`/mcp`), (b) no project is pinned via `project.use`, and (c) at least one suggested slug from roots-based discovery does not match an existing project.
- Make the new error code self-describing: include the suggested slugs and a hint about the two resolutions (pass `scope='global'` explicit, or call `project.use({slug, autocreate:true})`).

**Non-Goals:**

- Auto-creating projects on first save. The agent must still take an explicit step.
- Touching path-scoped (`/mcp/<slug>`) behavior. That surface already returns `scope_locked` on misuse.
- Introducing a new schema or migration. `ProjectsService.create` already does what we need.
- Bulk operations, project import/export, or project metadata beyond `slug` + `displayName`.
- Inferring the active project from the operating system's process cwd. Discovery stays on MCP roots only.

## Decisions

### 1. New CLI: `rembric project create <slug> [--name <displayName>]`

Mirrors the `token create` / `session list` conventions: lazy-imported action function in `src/cli/project-cli.ts`, JSON output on success, exit code 2 on `DomainError` (invalid_slug), exit code 1 on conflict (slug already exists), exit code 0 on success. We also expose `rembric project list` so operators can confirm what they minted without opening the dashboard.

_Alternative considered:_ Reuse `rembric token create --project=<slug>` and call the lazy-create a feature. Rejected — pulling a project into existence by minting a throwaway token is exactly the friction we are removing.

### 2. Dashboard form: always-visible block above the tables

A single `<form action="/dashboard/projects/create" method="post" class="inline">` block sits between the intro paragraph and the "Active" table. Two text inputs (slug, displayName), CSRF input, submit button. On success we redirect with `?created=<slug>`; on error we redirect with `?error=<message>` so the URL is the source of truth and a refresh doesn't double-submit. We render the flash from the query string with the existing `flash success` / `flash error` template classes.

_Alternative considered:_ Open the form in a modal or behind a "+ New" toggle. Rejected per user request ("siempre presente"); also keeps the surface server-rendered + plain forms, no JS dependency.

### 3. `project_suggestion_pending` error code

This is the load-bearing decision. The new code fires from two places:

- `memory.session_start` when `args.project` is unset, the connection is path-less, and the request context has pending suggested slugs.
- `memory.save` when `args.scope` is unset (default `'project'`), the connection is path-less, no project is pinned, and the request context has pending suggested slugs.

The response payload is:

```json
{
  "code": "project_suggestion_pending",
  "message": "No project is active and roots-based discovery surfaced suggestions. Either pass scope:'global' explicitly, or call project.use({slug:'<one of suggestedSlugs>', autocreate:true}).",
  "suggestedSlugs": ["rembric"]
}
```

The hint is verbatim in the error — agents must not need to read separate docs to recover.

We surface the pending slugs from the same `request-context` field that `project.current` already exposes. If the field is empty (no roots, or all suggested slugs already exist as projects), the gate is a no-op and the call proceeds as before. **This is the key non-invasiveness property** — operators who don't use roots-based discovery see zero behavior change.

_Alternative considered (rejected):_ Promote the error code to an MCP transport-level rejection rather than a structured tool response. Rejected because the MCP spec does not give us a clean way to attach structured payloads to transport errors, and our agents already pattern-match on response-level `code` values (see `cross_scope_relation`, `scope_locked`, `project_not_found`).

_Alternative considered (rejected):_ Auto-pin the first suggested slug if it exists. Rejected because it sidesteps the user's intent; if the agent landed on `/mcp` it explicitly chose not to use the path-scoped form, and we shouldn't second-guess that.

### 4. What counts as "pending suggestion"

A slug is a pending suggestion iff:

- It was surfaced by the most recent `roots/list` call against the active MCP session.
- It does not currently exist as a row in the `projects` table.

If _any_ of the suggested slugs matches an existing project, we don't gate — the agent could have used `project.use` to pin it but chose not to, and that's a deliberate choice we respect. If _all_ suggestions are unminted, the gate fires.

### 5. Resolution paths

After the agent receives `project_suggestion_pending`, two resolutions are valid:

- `scope:'global'` on the same tool call → no project gating, write goes to global.
- `project.use({slug, autocreate:true})` (after asking the user) → mints the project and pins it. Subsequent calls without `scope` default to `'project'` and resolve to the newly minted slug.

The agent is expected to surface the choice to the user; the system prompt for the MCP server already tells agents to "ASK THE USER before passing either flag" for `project.use`. We extend that contract to cover this case.

## Risks / Trade-offs

- **Existing flows that relied on the silent fallback to global will now error** → low risk: the only flow that hit it is `memory.session_start` without `project` on a `/mcp` connection with pending root suggestions, which is exactly the case we want to fix. We update the changelog to note the behavior change and bump the minor version.
- **Concurrent dashboard / CLI creates of the same slug** → `projects.create` already throws `DomainError('conflict')` on the unique-slug violation; both code paths catch it cleanly.
- **Roots-based discovery is per-MCP-session state** → an agent that holds a long-lived session and re-runs `project.current` after minting a project will see the suggestion disappear (the slug now exists). Behavior is consistent across paths because both gates consult the same in-memory list.
- **CSRF-only protection on the form** → matches every other write form in the dashboard; no new threat vector.

## Migration Plan

- No DB migration required.
- Ship as a minor version bump because `project_suggestion_pending` is a new structured error code that pre-existing agents may not recognize. They will see the error message and fall back to user-visible failure rather than silent data loss in global — strictly better than the current behavior.

## Open Questions

None — the user has stated all constraints explicitly.
