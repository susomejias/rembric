## 0. Owner decisions (block implementation)

- [ ] 0.1 Owner resolves `design.md` Q1 (existing path-less OAuth grants lose administration, proposed, or keep it via backfill) and Q2 (offer the consent choice at all); update `specs/mcp-oauth/spec.md` and D6 if the answer differs from the proposal, then re-run `openspec validate add-user-layer --strict`.

## 1. Persistence: users, token ownership, grant delegation (high risk, item 1: own commit, ~350 lines)

- [ ] 1.1 Write the migration test first (RED): a populated fixture at schema 0041 with active, revoked, expired, soft-deleted, project-bound and set-scoped tokens, dashboard sessions, agent sessions and memberships; assert after migration that every token column is unchanged, every `user_id` is the bootstrap administrator, exactly one `users` row with role `admin` exists, `PRAGMA foreign_key_check` returns nothing, `memory`/`sessions` rows are byte-identical, and both OAuth tables have `administers = 0` on every row.
- [ ] 1.2 Add `packages/db/src/schema/users.ts` (`role` CHECK `admin`/`member`, unique `name`) and `tokens.user_id NOT NULL REFERENCES users(id)`; add `administers integer NOT NULL DEFAULT 0` to `oauth_authorization_codes` and `oauth_tokens`; generate `0042_*` with drizzle-kit and hand-edit it into the D5 sequence (explicit column list in the `INSERT … SELECT`, bootstrap user insert, `tokens_project_scope_check` and `tokens_name_unique` recreated verbatim, no index `schema-drift.test.ts` does not expect).
- [ ] 1.3 Add DB-constraint tests: inserting a token with NULL or unknown `user_id` fails, and the same insert with an existing user succeeds (control); a `users.role` outside the vocabulary fails.
- [ ] 1.4 Add `packages/db/src/repositories/users-repository.ts` (find by id, oldest admin, insert) and register it; update `apps/web/src/test/schema-inventory.ts`; add mechanical `userId` to schema-derived `Token` literals in tests.
- [ ] 1.5 Advance the migration inventory 41 → 42 in `apps/web/Dockerfile` and `.github/workflows/ci.yml`; run the executable gate test so it rejects 41 and 43.
- [ ] 1.6 GREEN: `pnpm vitest run packages/db` and the new migration test pass; `pnpm run typecheck` passes.

## 2. Acting user and the capability predicate (~400 lines)

- [ ] 2.1 RED tests in `packages/core`: `tokens.authenticate` returns the owner and `canAdminister`; a `*` token owned by a `member` user and a `projects` token owned by an `admin` user both report `canAdminister: false`; changing the owner's role in storage flips the result on the next call with a warm credential cache.
- [ ] 2.2 Implement one exported predicate in `packages/core` (owner present ∧ role `admin` ∧ delegation) and use it from `tokens.authenticate` (join `users`), `oauth.authenticateAccessToken` (subject → token row regardless of `deleted_at` → user; `administers` ∧ derived `*`), and `dashboardSessions.resolveActive` (join `users`); extend `ResolvedToken`, `ResolvedAccessToken`, `SessionContext` and `RequestContext` with `user` and `canAdminister`.
- [ ] 2.3 `bootstrapAdmin` attaches the token to the oldest `admin` user, creating one in the same transaction when none exists; dashboard token creation sets `userId` to the session credential's owner. Tests: first start yields one `*` token owned by an `admin` user; a minted token is owned by the minting session's user.
- [ ] 2.4 Build `RequestContext` in `apps/web/src/lib/mcp-auth.ts` and `apps/web/src/lib/auth.ts` from the new fields (keep the synthetic `oauth:<clientId>` id for attribution). Tests: an ownerless grant (subject names no token) authenticates with `user: null`, `canAdminister: false`, and its data reach unchanged.
- [ ] 2.5 GREEN: `pnpm vitest run packages/core apps/web/src/lib` pass; mutation-check each conjunct of the predicate with `node scripts/mutate.mjs` and confirm the naming tests go red.

## 3. Gates switch to the capability (~300 lines)

- [ ] 3.1 RED in `apps/web/src/test/mcp-http.test.ts`: flip "an OAuth grant consented on the path-less /mcp creates a project; one bound to a project does not" so a path-less grant without delegation is refused `admin_token_required` (no row), while a grant issued with `administers = 1` creates the project; add the same pair for `project.bind_repository`; add a `member`-owned `*` static token refused on both with `memory.save` succeeding as control.
- [ ] 3.2 Replace `ctx.scope !== '*'` in `packages/mcp/src/project-tools.ts` and the remedy builders in `packages/mcp/src/_shared.ts` (`unresolvableSlugError`, `unboundError`, `unboundMessage`) with `canAdminister`; tests assert the `project_not_found` and `project_unbound` messages name `project.create` / `project.bind_repository` only for an administering caller and never for a `*` grant without delegation.
- [ ] 3.3 Switch `apps/web/src/app/dashboard/login/verify/route.ts`, `apps/web/src/lib/actions/guard.ts`, `apps/web/src/app/dashboard/maintenance/data.ts`, `apps/web/src/app/dashboard/wrapped/page.tsx` and `apps/web/src/app/api/[slug]/debug/counters/route.ts` to the predicate. Tests: login refuses a `member`-owned `*` token and an `admin`-owned non-`*` token with the invalid-token response and creates no `dashboard_sessions` row; an `admin`-owned `*` token logs in (control).
- [ ] 3.4 Upgrade test: run the 0041 fixture through the migration, then log in to the dashboard, resolve the pre-existing session cookie and call `project.create` with the pre-existing static admin token; all succeed.
- [ ] 3.5 GREEN: focused suites pass; mutation-check each switched gate (restore the literal `*` check and confirm the OAuth-without-delegation tests go red).

## 4. Consent offers administration (~350 lines)

- [ ] 4.1 RED: route tests for `apps/web/src/app/dashboard/oauth/consent/route.ts` — approve without the choice issues a code with `administers = 0`; with the choice on a path-less write request issues `administers = 1`; the choice on a read-only or project-bound request, or from a session without capability, is refused `invalid_request` with no code row.
- [ ] 4.2 Implement: `IssueCodeInput.administers`, persisted on the code; `redeemCode` and `refresh` copy it into every token of the family; the `/token` response `scope` is unchanged. Service tests cover redemption and refresh propagation.
- [ ] 4.3 Render the unchecked choice in `apps/web/src/app/dashboard/oauth-consent/consent-card.tsx` only for path-less write consents, with copy that separates data access from administration; follow the `rembric-dashboard-ui` skill. Component test asserts presence/absence per request kind.
- [ ] 4.4 End-to-end in `mcp-http.test.ts`: a grant approved with administration creates a project, and so does an access token from refreshing it; a grant approved without it is refused.
- [ ] 4.5 GREEN: focused suites pass; real-browser check of the consent screen at desktop and 390px width with a scratch database.

## 5. Docs and closure

- [ ] 5.1 Update `docs/agents.md` ("Creating a project from an agent") and the upgrade notes: **BREAKING** for path-less connectors, the one-time backup advice, and how to re-authorize with administration.
- [ ] 5.2 Run `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, `openspec validate add-user-layer --strict`, `pnpm run check:delta-freshness`, `pnpm run check:delta-sections`, `pnpm run check:spec-crossrefs`; record observed results here.
- [ ] 5.3 Operator: smoke against the local dev server with a copy of a real-shaped database (`rembric-smoke-tests` skill): upgrade, dashboard login with the existing admin token, OAuth consent with and without administration, `project.create` from each connector.
