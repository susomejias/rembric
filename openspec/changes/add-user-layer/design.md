## Context

Today one string carries two unrelated meanings. The token scope `*` is both "read and write every project" (data reach, evaluated by `isAuthorized`, `packages/core/src/services/tokens.ts:373`) and "administer this server" (every admin gate):

| Gate                                                | Check today                                                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.bind_repository`                           | `ctx.scope !== '*'` → `admin_token_required` (`packages/mcp/src/project-tools.ts:157`)                                                                                             |
| `project.create`                                    | `ctx.scope !== '*'` → `admin_token_required` (`packages/mcp/src/project-tools.ts:190`)                                                                                             |
| `project_not_found` / `project_unbound` remedy text | `scope === '*'` names `project.create` / `project.bind_repository` (`packages/mcp/src/_shared.ts:33`, `:76`)                                                                       |
| Dashboard login                                     | `resolved.scope !== '*'` → refused (`apps/web/src/app/dashboard/login/verify/route.ts:32`)                                                                                         |
| Every dashboard server action                       | `resolved.session.scope !== '*'` → `admin_required` (`apps/web/src/lib/actions/guard.ts:34`)                                                                                       |
| Maintenance, wrapped, debug counters                | `scope !== '*'` (`apps/web/src/app/dashboard/maintenance/data.ts:184`, `apps/web/src/app/dashboard/wrapped/page.tsx:16`, `apps/web/src/app/api/[slug]/debug/counters/route.ts:20`) |

An OAuth grant derives its internal scope from the wire scope: any write-capable request (`mcp`, `*`, `*:write`) yields `*` (`packages/core/src/services/oauth.ts:288-294`), narrowed to `project:<id>` only when the grant is project-bound (`packages/core/src/services/oauth.ts:219`, `projectScopedGrant` at `packages/core/src/services/tokens.ts:403-406`). The `mcp-oauth` spec requires a path-less grant to stay unbound (`openspec/specs/mcp-oauth/spec.md:152`). An authenticated OAuth bearer becomes a synthetic token `oauth:<clientId>` with that scope (`apps/web/src/lib/mcp-auth.ts:183-194`, duplicated in `apps/web/src/lib/auth.ts:107-118`), so the MCP tools cannot tell it from a static admin token. The pinned test `apps/web/src/test/mcp-http.test.ts:1716-1744` asserts exactly that: a path-less grant creates a project.

Two facts make a user layer cheap:

- **A grant already records who consented.** The consent POST issues the code with `subject: resolved.session.tokenId` (`apps/web/src/app/dashboard/oauth/consent/route.ts:63`), persisted on `oauth_authorization_codes.subject` and `oauth_tokens.subject` (`packages/db/src/schema/oauth.ts:23`, `:47`), and rotation already treats the subject as the owner by invalidating its descendants (`packages/core/src/services/tokens.ts:191`).
- **Authority is already re-read per request.** A dashboard session resolves its token's scope through a join on every request (`packages/db/src/repositories/dashboard-sessions-repository.ts:24-36`), and static authentication re-reads lifecycle and membership state (`packages/core/src/services/tokens.ts:221-252`).

The tokens table has no owner column (`packages/db/src/schema/tokens.ts:6-27`). The bootstrap inserts a single `admin` token with scope `*` when the table is empty (`packages/core/src/services/tokens.ts:264-283`). The migration runner is forward-only and wraps each migration in `PRAGMA foreign_keys = OFF` → transaction → `foreign_key_check` (`packages/db/src/migrate.ts:62-108`); `tokens` has been rebuilt once before (`packages/db/src/migrations/0029_tokens_project_binding.sql`) and is the FK parent of `dashboard_sessions`, `sessions` and `token_projects` (`packages/db/src/schema/sessions.ts:11`, `agent-sessions.ts:16`, `token-projects.ts:11`).

## Goals / Non-Goals

**Goals:**

- A connector can be granted unbound read/write data access without project administration, and the consent screen can say so.
- Administrative capability has one definition and one predicate, used by every gate in the table above.
- The request context names the acting user.
- Every existing static admin token keeps working, unchanged, after the upgrade.

**Non-Goals:**

- Multi-tenant isolation, per-user data partitioning, user passwords, user management UI, disabling users (see `proposal.md`).
- Changing data reach: `isAuthorized` and the scope grammar are untouched.

## Decisions

### D1. Users are a table with a role; credentials point at their owner

`users(id TEXT PK, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('admin','member')), created_at INTEGER NOT NULL)`. `tokens.user_id TEXT NOT NULL REFERENCES users(id)`. Users are never deleted in this change (no verb exists), and the role is the only mutable attribute a later change could add a verb for.

An OAuth grant's owner is **derived**, not stored: the owner of the static token named by the grant's `subject`. That matches what consent already records, needs no change to the OAuth tables' identity columns, and keeps rotation's "subject owns the family" rule as the single ownership link.

Assumption: every production `subject` is a static token id, because the consent route is the only code path that issues codes (`apps/web/src/app/dashboard/oauth/consent/route.ts:57-64`). A subject that resolves to no token (test fixtures use `'oauth-subject'`, `apps/web/src/test/mcp-http.test.ts:1728`) yields a grant with **no owner**, which keeps its data reach and has no administrative capability.

- _Alternative: store `user_id` on `oauth_authorization_codes` and `oauth_tokens`._ Rejected for now: SQLite cannot add a NOT NULL FK column without a rebuild, two more tables would need a backfill from `subject`, and the stored copy could drift from the subject's owner. Revisit if a grant must survive its subject token's deletion.

### D2. Administrative capability = owner role ∧ credential delegation

```
canAdminister(principal) =
  principal.user !== null
  && principal.user.role === 'admin'
  && principal.credential.delegatesAdministration
```

- Static token: `delegatesAdministration ⇔ tokens.scope = '*'`. The dashboard already makes Administrator an explicit, warned token type that maps to `*` (`openspec/specs/dashboard/spec.md:213-219`), and promotion sets `*` after a danger confirmation (`openspec/specs/auth/spec.md:490-494`). That is a deliberate delegation, so no new column on `tokens`.
- OAuth grant: `delegatesAdministration ⇔ grant.administers = 1 ∧ derived scope = '*'`. Only an unbound write grant can administer; a project-bound grant never can.
- Reaching every project, by any scope arm or membership set, still confers nothing (the existing "A token reaching every project MUST NOT be an admin token" rule, restated against the predicate).

The role is the ceiling and the credential is the delegation: a credential can never carry more authority than its owner, and an admin owner does not leak administration into every credential they mint or consent.

- _Alternative A: role alone (every credential of an admin user administers)._ Rejected: the consenting operator is always an admin, so every connector would still administer and the issue would be unsolved.
- _Alternative B: a separate admin capability without users_ (the issue's narrower direction): an `administers` flag on grants and tokens, no `users` table. It solves the connector leak with less schema, but leaves "who is acting" unanswered and gives teammates' tokens no ceiling. The owner chose the user layer; this design keeps B's delegation flag as the credential half of D2, so B is a strict subset of this change.
- _Alternative C: exclude OAuth-issued tokens (`oauth:` synthetic ids) from admin tools._ Rejected: encodes provenance instead of capability, and blocks a connector the operator deliberately trusts.
- _Alternative D: a new advertised OAuth scope (e.g. `admin`) the client requests._ Rejected: clients request whatever the metadata advertises, so the decision would move from the operator to the client; consent stays the operator's choice and the wire vocabulary stays `mcp`, `read`.

### D3. The request context carries the acting user and the capability

`RequestContext` (`packages/core/src/server-context/request-context.ts:7-15`) gains `user: { id: string; role: 'admin' | 'member' } | null` and `canAdminister: boolean`, computed once at authentication. `SessionContext` (`packages/core/src/services/sessions.ts:11-15`) gains the same two fields. Both are re-read on every request, never cached, exactly like revocation and membership: `tokens.authenticate` joins `users`, `oauth.authenticateAccessToken` resolves subject → token → user, and `dashboardSessions.resolveActive` joins `users`. The synthetic `oauth:<clientId>` token id stays as the data-attribution identity, so provenance (`createdBy: token:<id>`) is unchanged.

Every gate in the Context table switches to `ctx.canAdminister` / `session.canAdminister`. `_shared.ts`'s remedy builders take the capability instead of the scope. Dashboard-internal checks become the same predicate; their spec text (`scope = '*'`) stays correct because the login now admits only administering credentials, so it needs no delta.

### D4. Consent offers administration as a separate, unchecked choice

On a path-less consent whose derived scope is `*`, the consent card shows one additional unchecked checkbox, "Also allow this connector to administer projects (create projects, bind repositories)". It is not shown for read-only or project-bound consents. The consent POST records `administers = 1` on the authorization code only when the box is ticked **and** the consenting session can administer; a ticked box from a session that cannot administer, or on a consent where the choice is not offered, is refused with `invalid_request` and no code (never silently dropped). Code redemption and refresh copy `administers` into every token of the family. The token response's `scope` echo is unchanged.

The requirement "The human MUST authenticate and consent before a code is issued" is modified by the active change `harden-client-identity-and-oauth-audience`; this change ADDs a separate requirement instead of competing for that block.

### D5. Migration: one bootstrap administrator owns every existing token

One forward-only migration, generated by drizzle-kit and hand-edited for the backfill, inside the runner's FK-off transaction:

1. `CREATE TABLE users (...)`.
2. `INSERT INTO users (id, name, role, created_at) VALUES ('operator', 'operator', 'admin', COALESCE((SELECT MIN(created_at) FROM tokens), <migration time ms>))`. Unconditional: on a fresh database it is the user the bootstrap token is attached to.
3. Rebuild `tokens` as in 0029: `CREATE TABLE tokens_new` with every current column, the existing `tokens_project_scope_check` verbatim, and `user_id text NOT NULL REFERENCES users(id)`; `INSERT INTO tokens_new SELECT <every current column>, 'operator' FROM tokens`; `DROP TABLE tokens`; `ALTER TABLE tokens_new RENAME TO tokens`; recreate `tokens_name_unique` (and no index `schema-drift.test.ts` does not expect).
4. `ALTER TABLE oauth_authorization_codes ADD administers integer DEFAULT 0 NOT NULL` and the same on `oauth_tokens` (a constant default needs no rebuild).
5. The runner's `foreign_key_check` gate proves `dashboard_sessions`, `sessions` and `token_projects` still reference live token ids.

Every token keeps its id, name, hash, scope, binding, timestamps and memberships, so its authority is identical: a `*` static token is owned by an admin user and delegates administration, i.e. it still administers.

`bootstrapAdmin` (`packages/core/src/services/tokens.ts:264`) attaches the admin token to the oldest `admin` user, creating one when none exists, in one transaction. New tokens minted from the dashboard are owned by the session's user.

**Append-only and reversibility.** No `memory`, `sessions`, `consolidation_ops` or provenance row is updated or deleted; `tokens` rows are copied verbatim plus one column. The runner has no down migrations. The change is reversible at the data level because nothing is lost: dropping `users`, rebuilding `tokens` without `user_id` and dropping the two `administers` columns restores the previous shape byte-for-byte except for grants consented with administration after the upgrade (they would revert to administering, as all path-less grants do today). The upgrade note tells operators to take the dashboard's backup snapshot first; the migration test asserts a verbatim copy of every token column and a passing `foreign_key_check` on a populated fixture.

### D6. Existing OAuth grants carry no administration (OPEN DECISION)

The `administers` column defaults to `0`, so every grant issued before the upgrade keeps its data reach and loses administration. Safest default: those grants were consented on a screen that never mentioned administration, and refresh rotation would otherwise carry the authority forward indefinitely (each refresh mints a new refresh token, default TTL 30 days, `apps/web/src/lib/services.ts:231-232`). A connector that needs it is re-consented with the box ticked.

The alternative is to backfill `administers = 1` for path-less write grants (`project_id IS NULL` and a write-capable wire scope), preserving today's behaviour until the family is revoked. **Owner decision required** (Open Questions, Q1).

### D7. Capability matrix after the change

| Surface                                     | Static `*` token, admin owner | Static non-`*` token   | OAuth path-less write, box ticked | OAuth path-less write, not ticked / pre-upgrade | OAuth project-bound or read |
| ------------------------------------------- | ----------------------------- | ---------------------- | --------------------------------- | ----------------------------------------------- | --------------------------- |
| Data reach (`isAuthorized`)                 | every project                 | its scope              | every project                     | every project                                   | its project / read          |
| `project.create`, `project.bind_repository` | allowed                       | `admin_token_required` | allowed                           | `admin_token_required`                          | `admin_token_required`      |
| Remedy text names the admin tools           | yes                           | no                     | yes                               | no                                              | no                          |
| Dashboard login, actions                    | allowed                       | refused                | n/a (bearer only)                 | n/a                                             | n/a                         |
| Offer administration at consent             | yes                           | n/a (cannot log in)    | —                                 | —                                               | —                           |

## Risks / Trade-offs

- [Risk] The `tokens` rebuild runs on every instance and touches the table every request authenticates against; a wrong column list would drop data or fail the FK gate. → The INSERT names columns explicitly, the migration test asserts a verbatim copy of each column and of child references on a populated fixture, and the runner aborts the whole transaction on any `foreign_key_check` row.
- [Risk] Connectors that use `project.create` today stop being able to (D6 default). → **BREAKING** entry in the release notes and `docs/agents.md`, a refusal message that names re-authorizing the connector with administration, and the owner's open decision.
- [Risk] Deriving the grant owner from `subject` makes a grant ownerless if its subject token is ever hard-deleted. → Tokens are only soft-deleted (`deleted_at`), so the row and its `user_id` survive; the derivation reads the row regardless of `deleted_at`.
- [Trade-off] One extra join per authenticated request (users is a handful of rows, primary-key lookup). → Accepted because authority must be re-read per request anyway; the join rides the existing token read.
- [Trade-off] The `member` role is unreachable until a follow-up adds user management. → Accepted because it lets that follow-up land without a second `tokens` rebuild, and the CHECK documents the closed vocabulary now.
- [Trade-off] Static-token delegation stays tied to `scope = '*'`, so a static credential cannot have full data reach without administration. → Accepted because no one asked for it and the dashboard has no such type; the OAuth column shows the shape a later static flag would take.

## Migration Plan

1. Ship schema, migration and the read-side (`user`, `canAdminister` in contexts) behind no flag; gates switch in the same release, because a split release would leave the predicate unused or the gates without data.
2. Release notes: **BREAKING** for path-less connectors (D6), the one-time backup advice, and how to re-consent with administration.
3. Rollback: restore the pre-upgrade backup, or apply the reverse shape described in D5; no memory data is involved.

## Open Questions

- **Q1 (OPEN DECISION, owner).** Do existing path-less write OAuth grants keep administration (backfill `administers = 1`) or lose it (default `0`, proposed)?
- **Q2.** Should the consent checkbox be offered at all, or should administration be reserved to static admin tokens (connectors never administer)? Proposed: offer it, unchecked, because the issue keeps "a connector the admin deliberately trusts" as a use case.
- **Q3.** Name of the bootstrap user (`operator` proposed) and whether it should be renamable from the dashboard in this change or the user-management follow-up.
- **Q4.** Is the user-management follow-up (create `member` users, assign tokens at creation) wanted soon enough to fold into this change instead?
- **Q5.** Should a revoked or deleted subject token also revoke its OAuth grants' data reach? Today it does not (only rotation invalidates them, `packages/core/src/services/tokens.ts:191`); this change keeps that and only removes administration from ownerless grants.
