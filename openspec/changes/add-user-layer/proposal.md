## Why

Administrative authority is the literal token scope `*`, and a grant consented on the path-less `/mcp` connector is minted as `*` (`packages/core/src/services/oauth.ts:288-294`), so a remote connector authorized once to read and write memories can also create projects and bind repositories (`packages/mcp/src/project-tools.ts:157`, `:190`). The consent screen cannot say "data access, but no project administration", and the server has no notion of who is acting: every `*` holder is "the admin" (issue #531). A project created by mistake can only be archived, never deleted, so the authority leak leaves permanent residue.

## What Changes

- Add a lightweight **user layer**: a `users` table with a `role` (`admin` or `member`). Every static token belongs to exactly one user, enforced by the database. An OAuth grant belongs to the user who owns the dashboard credential that consented it (the grant's existing `subject`).
- **Administrative capability** = the owning user's `admin` role **and** the credential's own delegation. A static token delegates administration exactly when its scope is `*` (the dashboard's explicit Administrator type, unchanged). An OAuth grant delegates administration only when the operator ticked a new, unchecked-by-default consent choice. Reaching every project still confers nothing.
- `project.create`, `project.bind_repository`, the dashboard login and the remedy text in `project_not_found` / `project_unbound` refusals check administrative capability instead of `ctx.scope === '*'`. The request context carries the acting user.
- **BREAKING** A path-less OAuth grant keeps unbound `*` **data** reach but no longer administers projects unless administration was granted at consent. Existing grants issued before this change carry no administrative capability (safest default; marked as an open decision for the owner in `design.md`). Re-consenting with the new choice restores it.
- One forward-only migration creates the `users` table, inserts a single bootstrap administrator user, and assigns every existing token to it. No credential's secret, scope, binding, membership or provenance changes, so every existing static admin token keeps working after the upgrade.
- `REMBRIC_ADMIN_TOKEN` bootstrap creates the admin token owned by that bootstrap administrator.

## Non-goals

- No multi-tenant isolation: users do not partition projects or memories; data reach stays the token scope grammar.
- No user management UI, user passwords, per-user login or disabling a user in this change. Creating `member` users and assigning tokens to them is a follow-up; the role column exists so that follow-up needs no second migration of `tokens`.
- No change to the OAuth wire scope vocabulary (`mcp`, `read`), to project-bound grants, or to the consent requirement owned by the active change `harden-client-identity-and-oauth-audience`.
- No new MCP tool and no project deletion.

## Capabilities

### New Capabilities

None. The user layer is authentication and authorization state, so it lands in `auth`.

### Modified Capabilities

- `auth`: users, credential ownership enforced by the database, the administrative-capability definition, the bootstrap administrator, and the migration of existing tokens; the existing "admin token" requirements reference that definition instead of the literal `*`.
- `mcp-oauth`: a path-less grant's administrative capability is an explicit, separate consent choice; grants issued before the change carry none.
- `mcp-api`: `project.create`, `project.bind_repository`, the authorization model and the `project_not_found` / `project_unbound` remedy text check administrative capability.
- `dashboard`: the login accepts only a credential with administrative capability.
- `repository-binding`: the unbound-mode remedy text follows administrative capability.

## Impact

- Persistence: new `packages/db/src/schema/users.ts`; `packages/db/src/schema/tokens.ts` gains `user_id NOT NULL REFERENCES users(id)`; `packages/db/src/schema/oauth.ts` gains `administers` on `oauth_authorization_codes` and `oauth_tokens`; one generated-then-hand-edited migration `0042_*`; `packages/db/src/repositories/{tokens,oauth,dashboard-sessions}-repository.ts`; new `users-repository.ts`; `apps/web/src/test/schema-inventory.ts`.
- Services: `packages/core/src/services/tokens.ts` (`authenticate`, `bootstrapAdmin`, `create`), `packages/core/src/services/oauth.ts` (`issueCode`, token pair, `authenticateAccessToken`), `packages/core/src/services/sessions.ts` (`SessionContext`), `packages/core/src/server-context/request-context.ts`.
- MCP: `packages/mcp/src/project-tools.ts`, `packages/mcp/src/_shared.ts`.
- Web: `apps/web/src/lib/{auth,mcp-auth}.ts`, `apps/web/src/lib/actions/guard.ts`, `apps/web/src/app/dashboard/login/verify/route.ts`, `apps/web/src/app/dashboard/oauth/consent/route.ts`, `apps/web/src/app/dashboard/oauth-consent/consent-card.tsx`.
- Tests: `apps/web/src/test/mcp-http.test.ts` (the pinned "an OAuth grant consented on the path-less /mcp creates a project; one bound to a project does not" flips for a grant without delegation), new migration test, service and route tests.
- Delivery: `apps/web/Dockerfile` and `.github/workflows/ci.yml` migration inventory advance from 41 to 42.
- Docs: `docs/agents.md` ("Creating a project from an agent").
- Invariants: append-only memory is untouched (no `memory`, `sessions` or `consolidation_ops` row is updated or deleted; `createdBy: token:<id>` provenance is unchanged). Scope stays resolved at the service layer; users add no scope.
