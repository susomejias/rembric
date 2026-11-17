## Why

A Rembric client finds its project only through a `.rembric` file in the exact directory the host started in, or a `REMBRIC_PROJECT_SLUG` default. Every reader checks that one directory and never its parents (`apps/plugin/mcp-bridge/rembric-dotenv.mjs:26`, `apps/plugin/mcp-bridge/slug.mjs:19`, `apps/plugin/scripts/_api.sh:76`, `apps/plugin/.hermes-plugin/__init__.py:216`), so a session started in a subdirectory, a fresh clone, a second machine or a linked worktree whose `.rembric` is not committed finds nothing. When nothing is found the bridge connects path-less and the session writes into the server's **default project**, warned only on stderr (`apps/plugin/mcp-bridge/bridge.mjs:84`). Memory is append-only and has no reassignment verb, so every row such a session writes stays misfiled for good, and nobody sees it happen.

The fix cannot be a guess. A repository or directory name does not identify a project — `acme/api` and `other/api` share one — and a wrong guess is the same permanent misfiling. This change identifies a repository by the root commit of its history, lets an admin bind that identity to a project once, and makes every client in every checkout of that repository resolve to it, while a repository nobody has bound fails loudly instead of landing in the default project.

## What Changes

- **Repository fingerprint.** Clients identify a git repository by the root commit reached from `HEAD` through first parents (`git rev-list --first-parent --max-parents=0 HEAD`). Shallow clones, repositories with no commit and hosts without `git` have no fingerprint.
- **One resolution cascade for all five clients, run once per session**: the nearest `.rembric` walking up to the checkout root (outside git, only the start directory), then `REMBRIC_PROJECT_SLUG`, then — inside a git work tree — the fingerprint through a new `POST /api/repositories/resolve`. The outcome is fixed for the session. **BREAKING**: `.rembric` is now found in parent directories up to the checkout root.
- **Bindings** `(fingerprint, project)`, unique per pair, visible only through the token's read reach; several visible bindings are an ambiguity, never a guess, and a binding the token cannot see answers exactly like none. A known-remote check holds back a different project that started from the same boilerplate history.
- **Unbound mode.** Inside a git work tree a path-less request carrying the new `X-Rembric-Repo-Fingerprint` header resolves to no project: every scope-resolving tool answers `project_unbound`, hooks register nothing, and the session-start text explains the remedy. **BREAKING**: inside a git work tree a client never falls back to the default project — not when unbound, not when the server lacks the endpoint, not on a timeout. Outside git nothing changes.
- **Admin-only binding.** A new `project.bind_repository` MCP tool (admin token `*` only) binds an unbound fingerprint; moving and removing bindings is dashboard-only. A root `.rembric` reported by any writing token becomes a pending suggestion for an admin to accept.
- **Pending repositories**: deduplicated per `(fingerprint, kind, project)`, bounded by `REMBRIC_REPO_PENDING_TTL_DAYS` (14) and `REMBRIC_REPO_PENDING_MAX_PER_TOKEN` (20), storing credential-stripped remotes and never a local path; discards are remembered.
- **Explicit selection wins** over a binding and is reported as a conflict in the session-start text, in `project.current` and in the dashboard.
- **Dashboard**: a Repositories section on project create/edit (bound list, pending list, bind by fingerprint), a pending count on the projects list, and a pending view with kinds, discard and restore.
- **Release**: server first, then all five clients in one plugin release. Upgrade is a clean cut: checkouts that silently used the default project become unbound and pending; nothing already written moves.

This change touches two load-bearing invariants and declares each exception: **path-scoping** (a path-less connection resolves to the default project, except an unbound request; `project.bind_repository` names a project other than the connection's, without switching it) and **append-only memory** (unaffected: bindings and pending rows are configuration, and no memory or session row is moved or rewritten). Scope stays resolved at the service layer: the header never selects a project, and the bind tool resolves no effective scope.

**Depends on** `collapse-mcp-onto-stateless-sdk-v2`: its code has shipped but it is not archived, and this change's `projects`, `mcp-api`, `mcp-bridge` and `claude-code-plugin` deltas are written against the text it publishes. Archive it first; until then `pnpm run check:delta-freshness` and `pnpm run check:delta-sections` report those deltas.

## Capabilities

### New Capabilities

- `repository-binding` — the fingerprint, the client cascade, remote normalization, binding visibility and ambiguity, the unknown-remote check, explicit-selection conflicts, unbound mode, the no-default-fallback rule, pending repositories and their limits, header validation, and the single-release rollout.

### Modified Capabilities

- `projects` — the unbound scopeless state; the fingerprint header never selects a project.
- `mcp-api` — path-less resolution gains the unbound exception; `project.current` reports `unbound` and a `repository` field; new `project.bind_repository`.
- `mcp-bridge` — `.rembric` walk, fingerprint step, header forwarding, no default fallback inside git, shared resolver module.
- `http-api` — new `POST /api/repositories/resolve`.
- `claude-code-plugin` — path-less fallback limited to outside git; `_api.sh` resolves once per session and caches the outcome.
- `opencode-plugin`, `pi-plugin`, `hermes-agent-plugin` — the shared cascade replaces the cwd-only `.rembric` read.
- `dashboard` — Repositories section, pending view and count.
- `auth` — only an admin token creates a binding.

## Impact

- **Database**: new tables `project_repositories` and `repository_pending` (with its token join) in `packages/db/src/schema/`, migration `packages/db/src/migrations/0039_repository_bindings.sql`, repositories under `packages/db/src/repositories/`, `packages/db/src/test-support/schema-inventory.ts`, `packages/db/src/schema/schema-drift.test.ts`.
- **Server**: a binding service in `packages/core/src/services/`; `packages/core/src/services/errors.ts` (`project_unbound`, `repository_ambiguous`, `repository_already_bound`, `repository_fingerprint_unavailable`, `invalid_repository_fingerprint`); `packages/core/src/server-context/request-context.ts`; `packages/mcp/src/_shared.ts` (`resolveEffectiveScope`), `packages/mcp/src/project-tools.ts`, `packages/mcp/src/server.ts`; `apps/web/src/app/mcp/[[...path]]/route.ts` and `apps/web/src/lib/mcp-auth.ts` (header validation); new `apps/web/src/app/api/repositories/resolve/route.ts`.
- **Dashboard**: `apps/web/src/app/dashboard/projects/page.tsx`, `apps/web/src/components/dashboard/projects-sheets.tsx`, `apps/web/src/components/dashboard/projects-table.tsx`, a pending view under `apps/web/src/app/dashboard/projects/`.
- **Clients**: new `apps/plugin/mcp-bridge/rembric-project.mjs`; `apps/plugin/mcp-bridge/{bridge,slug,rembric-dotenv}.mjs`; `apps/plugin/bin/rembric-plugin-core.mjs`; `apps/plugin/scripts/_api.sh` and every hook script that calls `rembric_read_project_slug`; `apps/plugin/.opencode-plugin/plugin.ts`; `apps/plugin/.pi-plugin/index.ts`; `apps/plugin/.hermes-plugin/__init__.py`; client READMEs and `docs/agents.md`.
- **Tests**: `apps/web/src/test/invariants.test.ts` (shared-module invariant gains `rembric-project.mjs`), `apps/web/src/test/mcp-tool-surface.test.ts` (third project tool), `apps/web/src/test/mcp-http.test.ts`, per-client plugin tests.
- **No dependency added.** The bridge stays zero-dependency (`node:child_process` for `git`).
