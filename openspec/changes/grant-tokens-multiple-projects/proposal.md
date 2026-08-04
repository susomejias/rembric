## Why

An agent that works in three repositories cannot be given a token that reaches those three repositories. `apps/server/src/services/tokens.ts:52` admits exactly four arms:

```ts
export type TokenScope = '*' | 'read:*' | `project:${string}` | `read:project:${string}`;
```

and the type immediately below it says so in as many words (`:55-57`):

> Reach is either global (the caller names the scope literal) or a single project (the caller hands over the resolved row and an access verb).

So "these three repos" has exactly one representable answer: `*`. That is not a narrower grant with a rough edge — it is the **admin** scope. `*` is write-everywhere (`tokens.ts:273`, `if (scope === '*') return true`), and it is the only scope the dashboard login accepts (`server/dashboard-router.ts:156`, `if (resolved.scope !== '*')`) and the only scope that passes the maintenance gate (`dashboard/maintenance.ts:143`, `if (!token || token.scope !== '*')`). An operator who wants to grant three repositories is being asked to hand over the whole server.

**The gap is structural, not a matter of operator patience.** A client install holds exactly **one** token, while the project is decided per-repository by a file on disk. `apps/plugin/bin/rembric-bridge.mjs:43-44` reads the credential from the environment once:

```js
const baseUrl = process.env.REMBRIC_SERVER_URL;
const token = process.env.REMBRIC_API_TOKEN;
```

and then, per invocation, derives the endpoint from `<projectDir>/.rembric` (`:54-61`): `const cfg = parseDotenv(readFileSync(configFile, 'utf8')); const slug = cfg.PROJECT_SLUG; … scopedPath = `/mcp/${slug}``. There is one token slot to fill it from — `.claude-plugin/mcp.json:8` is `"REMBRIC_API_TOKEN": "${user_config.api_token}"`, a single scalar in the user config; Codex and opencode export the same variable from the shell, Hermes reads it from `~/.hermes/.env`. **There is no "second token for the second repo."** One install, N repositories, one credential. The workaround the four-arm grammar implies does not exist at the client.

So today the honest menu for a three-repo agent is: `*` (admin, dashboard login, write to every project including ones created later) or nothing.

## What Changes

- **`TokenScope` gains a set arm — `projects` and `read:projects` — backed by a new `token_projects` join table, and the set is the FK-enforced truth.** `CREATE TABLE token_projects (token_id … REFERENCES tokens, project_id … REFERENCES projects, PRIMARY KEY (token_id, project_id)) WITHOUT ROWID` was measured as **purely additive: no `tokens` rebuild, existing rows byte-identical, `foreign_key_check` empty, `integrity_check` ok.** The FK does exactly the job `tokens.project_id` does on the single-project arm — inserting a **slug** instead of an id was REJECTED with `SQLITE_CONSTRAINT_FOREIGNKEY`, as was an unknown token id. The set arm carries `tokens.project_id IS NULL`, and `scope = 'projects'` with `project_id IS NULL` is **accepted by the existing `tokens_project_scope_check`** through its `project_id IS NULL` disjunct (`db/schema/tokens.ts:40`), so **no table rebuild is needed**. This refines — does not contradict — the prediction at `openspec/changes/archive/2026-08-03-mint-the-token-the-operator-asked-for/design.md:176`: "Adding a fifth scope arm (`all_projects`, or a silo-scoped form) **that also carries a `project_id`** will need the `CHECK` extended, which is another `tokens` table rebuild." The emphasis is the condition, and this arm does not meet it.
- **Authorization becomes `legacy(scope) OR membership(set)` — additive only, never subtractive.** Measured over the full cross-product of 5 scope strings × 4 targets × 2 actions with an **empty** grant set (what every pre-existing row has): **40 cells, 0 divergences**, with a non-vacuity control — 15 of the 40 cells are TRUE, so the comparison is not over an all-false set. Rejected: any rule that can turn a `true` into a `false`, because every existing row would then be a candidate for silent narrowing.
- **The set arm MUST NOT reuse `*` or `read:*` as its base scope.** The same probe caught the leak: with base `read:*`, a set naming `{A, C}` returned **true for project B** — the set is simply irrelevant when the base already reaches everything. The `projects` / `read:projects` literals exist precisely so the base authorizes nothing on its own: measured, `pinnedProjectId('projects') === null` and `isAuthorized('projects', …)` is **false for every target and both actions**. That fail-closed base is what makes the union safe.
- **One access verb for the whole set in v1**, extending `dashboard/spec.md:189`'s "two independent controls" from 2×2 to 2×N rather than replacing the composition rule. **BREAKING** for nothing; **deferred** capability, stated honestly: read-shared/write-own (read a common docs project, write your own) is not expressible with one verb, and because a client install has one token slot it is not expressible as two tokens either. The deferral is cheap and measured: `ALTER TABLE token_projects ADD COLUMN access text NOT NULL DEFAULT 'write'` on the populated `WITHOUT ROWID` table was **ACCEPTED with no rebuild** (control: the same `ADD COLUMN` without a default was correctly rejected).
- **The project set is authorization state and SHALL NOT be cached.** `openspec/specs/auth/spec.md:69` requires that "Every authenticated request, whether or not it hits that lookup cache, SHALL re-read the token's current `revoked_at` / `expires_at` state from storage before authorizing it." Removing project B from a token must take effect on the next request, exactly as revoking the token does. `verifiedCache` (`tokens.ts:149-156`) is therefore the wrong place — it caches only the plaintext→id mapping and is permitted to live forever _precisely because_ it never substitutes for the fresh check.
- **The three literal admin gates stay literal.** `server/dashboard-router.ts:156`, `server/http.ts:489`, `dashboard/maintenance.ts:143` keep comparing against `'*'` as a string. This is the security invariant of the change: **a set naming every project MUST NOT become admin.** Rejected: computing "reaches all projects ⇒ admin", which would make adding one project silently escalate a token.
- **`project.use({autocreate: true})` is refused for a set token.** `mcp/project-tools.ts:107` gates it on `isAuthorized(ctx.scope, 'write', { scope: 'project', projectId: null })`, true only for `*`. A brand-new project is not in the set, and it is stated rather than left emergent.
- **Multi-project OAuth is an explicit non-goal.** RFC 8707 `resource` is one URL and `server/oauth-provider.ts:61-71` extracts one slug (`const slug = path.slice('/mcp/'.length).split('/')[0]`), so a multi-project grant is not expressible on that wire. `services/oauth.ts` and `dashboard/oauth-consent.ts` are unaffected; `openspec/specs/mcp-oauth/spec.md:150` keeps its exact meaning.
- **Ordering: this change lands after `retire-the-global-scope`.** Recorded as D1 with three measured hazards (migration filename ordering, the shared `isAuthorized` rewrite, the `Scope`/`TokenScope` 1:1 break). Not a correctness dependency in the other direction — reversed, nothing breaks, but `projectPinRemedy` would learn to describe a set and then have that branch deleted.

## Capabilities

### New Capabilities

None. The set arm is an extension of the token scope grammar `auth` already owns.

### Modified Capabilities

- `auth`: amends **"Tokens MUST support scope and expiration"** (`spec.md:39-41`) — the closed enumeration at `:41` gains the `projects` / `read:projects` arms. This amendment is the price of choosing the honest-reporting shape (see `design.md` D3); it is one enumeration sentence. Adds three requirements: the set arm authorizes **nothing by scope string alone** and is resolved only through membership; authorization is the **additive union** `legacy(scope) OR membership(set)`; and the membership set is **authorization state**, re-read from storage on every authenticated request and never cached — the same rule `:69` states for `revoked_at`/`expires_at`. Adds the non-escalation requirement: a set naming every project is not admin and does not authenticate the dashboard. `spec.md:218-226` (the project-row binding) is **extended, not amended** — `project_id IS NULL` for the set arm is exactly what `:226` already requires of non-single-project tokens. `spec.md:264-283` (legacy inert rows) is untouched and its scenarios must keep passing verbatim.
- `dashboard`: amends **"Tokens MUST be manageable from the dashboard"** (`spec.md:185-210`). The 2×2 table at `:191-196` becomes 2×N: the project control becomes multi-select, `access` stays one verb for the whole selection, and the composition rule at `:189` ("Neither control SHALL void the other") is unchanged in force. `:206` ("The list SHALL render the project as a slug") extends from one cell to N slugs in one cell. `:208` (unresolvable ⇒ `inert`, "State precedence SHALL be `revoked`, then `expired`, then unresolvable, then `active`") is amended for the collision this change introduces: a set token with **zero** members also authorizes nothing, but must NOT be rendered `inert`, because `inert` is the state `auth/spec.md:268` says must never be repaired, whereas an empty set is repairable by the operator. `:210` ("This requirement introduces no new design tokens") is preserved and re-asserted — the checkbox rule reuses `--lime` and `--fg-faint`.
- `persistence`: adds the additive `token_projects` requirement — the DDL, `WITHOUT ROWID`, the composite primary key, both foreign keys, the fact that the migration performs **no table rebuild** (so `tokens` rows are untouched and the `foreign_keys = OFF` envelope at `spec.md:587` is not being relied on for a parent drop), and the recorded `ADD COLUMN access` extension path.

Checked and deliberately **not** given a delta:

- `mcp-oauth` — `spec.md:146-150` keeps its exact meaning; a multi-project OAuth grant is not expressible (non-goal, D8) and no OAuth code path changes.
- `http-api` — `spec.md:339-342` ("project-scoped tokens are valid for availability checks") is unchanged; a set token behaves the same on `/healthz`.
- `mcp-api` — `spec.md:20-25` path-scoped isolation and `:116`'s `project_required` are untouched. A set token on `/mcp/<slug>` is either in the set or forbidden; the isolation contract for the connection it does get is identical.
- `projects` — slug rules, autocreate semantics and the legacy-slug guarantee are untouched.
- `data-access` — no new pattern: the new SQL goes into a repository under `db/repositories/`, scoped reads take the `Scope`, unscoped dashboard reads carry the `admin*` prefix, exactly as `spec.md:23` and `:37` already require.

Noted as **pre-existing and out of scope**: `dashboard/spec.md:710` describes "a dashboard session with `scope = 'project:<id>'`", which cannot exist because login requires `*` (`dashboard-router.ts:156`; measured: 401). It is vacuous today, independently of this change, and folding it in would mix an unrelated reconciliation into an authorization change. Left as an open question.

## Impact

Durable invariants: **none weakened.** Scope is still resolved at the service layer and repositories still enforce the filter they are given. Append-only memory, `topic_key` convergence, fresh-context judgment and derived-never-stored review state are untouched — **no memory row is read or written by this change.** The one invariant this change deliberately strengthens by restating it: `*` remains the only admin scope, as a string comparison.

Code — rewritten:

- `apps/server/src/services/tokens.ts:268-290` — `isAuthorized`, the union point. Seven direct non-test call sites: `mcp/_shared.ts:96` (inside `isAuthorizedFor`, itself reached from `assertAuthorized` at `:138`, which is the gate every MCP tool passes), `mcp/project-tools.ts:107` and `:200`, `server/api-router.ts:99`, `:139`, `:183`, `:225`.

Code — extended:

- `apps/server/src/services/tokens.ts:59-63` — `TokenGrant` / `CreateTokenInput` gain a third arm carrying `projects: Project[]`, **never `string[]`**: the existing comment at `:56-57` says "A bare project id would re-admit a slug, so the row itself is required", and that discipline carries to the set.
- `apps/server/src/services/tokens.ts:214-221` — `composeGrant` returns the set literal plus the membership rows to insert; `TokensService.create` writes both inside one transaction.
- `apps/server/src/services/tokens.ts:52` — the `TokenScope` union; `:33-43` — the scope-grammar docstring; `:55-57` — the "either global … or a single project" comment, now false.

Code — kept but re-documented:

- `apps/server/src/services/tokens.ts:303-314` — `pinnedProjectId`. Its docstring opens "The single project a token is pinned to", which stops being the whole truth. Measured: it returns `null` for `'projects'`, which is the correct fail-closed answer and needs no code change — only the docstring moves.

Code — unaffected:

- `apps/server/src/services/tokens.ts:298-301` — `projectScopedGrant`, still the single-project writer and still used by the OAuth path.
- `apps/server/src/mcp/project-tools.ts:200` (`project.list`'s filter) and `:128` (`project.use`'s read gate) are already `isAuthorized`-driven and become correct for a set token **for free**, with no edit.

Code — changed:

- `apps/server/src/mcp/_shared.ts:108-121` — `projectPinRemedy` names one slug (`:116-119`). For a set token it must name several or stay empty; under-reporting here is fail-closed-looking rather than a security bug.
- `apps/server/src/dashboard/tokens.ts` — `unresolvable`/`stateOf` (`:37-47`), the project cell (`:56`), `scopeBadge` (`:286-290`), and the create form's project control (`:153-161`, currently a single `<select name="project">`).
- `apps/server/src/db/schema/tokens.ts:6-19` — the scope-semantics docstring; new `apps/server/src/db/schema/token-projects.ts`.
- New `apps/server/src/db/migrations/00NN_token_projects.sql` — additive `CREATE TABLE`, no rebuild. Number assigned at apply time, after `retire-the-global-scope`'s migration exists, because `db/migrate.ts:55-57` is `readdirSync().filter(…).sort()` with no duplicate-prefix detection (D1).
- New repository under `apps/server/src/db/repositories/` for the membership reads/writes.

Dashboard styling cost, measured: `input[type='checkbox']` is styled **only** under `.filters .group` (`dashboard/styles/core/patterns.css:253-269`). The create-form scope (`.main`, `class="stack"` at `dashboard/tokens.ts:147`) styles text-ish inputs, `select` and `textarea` (`styles/core/content.css:226-235`) and no checkbox. A `<select multiple>` would inherit `.main select`'s `appearance: none` plus arrow background and `min-height` (`content.css:260-272`), cosmetically wrong for a listbox. So a checkbox list requires extending the `patterns.css:253` rule to the form scope — **a new selector reusing existing tokens (`--lime`, `--fg-faint`)**, which does not touch the locked `:root` token set (`dashboard/spec.md:565-572`). No `data-confirm` modal is involved (creating a token is not destructive, per `dashboard/spec.md:210`); timestamps already go through `formatTs`.

Tests:

- `apps/server/src/test/schema-drift.test.ts:377` asserts `expect(tables).toEqual([...EXPECTED_TABLES].sort())` — an exact table set, so the new table **reds this test first**. That is the proof the table landed, and it is updated in the same commit.
- `apps/server/src/services/tokens.test.ts`, `apps/server/src/test/dashboard-e2e.test.ts`, plus the mutation runs required by `tasks.md` phase 6.

No dependency change. No `apps/plugin/` change: nothing in the plugin tree parses a token scope — the bridge only forwards the credential. The migration and the authorization union are both smoked against pre-existing seeded data in Docker.
