## Why

The `/dashboard/tokens` form has two controls — a project selector and a scope override — and **no combination of them mints a working project-scoped token**. Re-measured on `main @390170c` through the real form and the real HTTP boundary, each probe paired with an admin control that must pass:

| Operator submits                  | Stored `tokens.scope`                                       | `POST /api/<own-project>/memory/recall`                                                       | Control (admin `*`, same endpoint) |
| --------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| `project=probe-proj`, no override | `project:probe-proj`                                        | **403** `{"ok":false,"code":"forbidden","message":"token scope does not cover this project"}` | 200                                |
| `project=alpha`, `scope=read:*`   | `read:*` — the project selection is **absent from the row** | 200 on `alpha`, **200 on `never-selected`**                                                   | 200                                |
| no project, `scope=read:*`        | `read:*`                                                    | correct                                                                                       | 200                                |

The first row fails **closed** (#307): `dashboard/tokens.ts:187` writes ``scope = projectSlug ? `project:${projectSlug}` : '*'`` with `projectSlug = p.slug` from `:171`, while `services/tokens.ts:265-268` reads that segment as a project **id** (`target.projectId === id`) — a ULID. A slug never equals a ULID, so the token authorizes nothing, on every endpoint, forever. The second fails **open** (#309): the override branch at `:181-185` never reads `projectSlug` again, so the project the operator chose is silently discarded and the token reaches every project. `read:project:<id>` is not mintable at all — the `<select name="scope">` at `:132-136` offers exactly three options (`:133-135`).

Both defects live in the same twenty lines and exhaust the form's two paths, so a fix for either alone leaves the form still unable to produce a narrow token. And the tokens list gives the operator no signal in either case: the headers rendered today are `name`, `scope`, `created`, `expires`, `state`, `actions` (`dashboard/tokens.ts:99-104`), while `openspec/specs/dashboard/spec.md:187` has required a **project** column since it was written:

> The `/dashboard/tokens` view SHALL list existing tokens (name, scope, project, created_at, revoked_at, expires_at) and SHALL allow creating a new token (shown in plaintext exactly once) and revoking an existing token (setting `revoked_at`).

The reason this shipped is that nothing binds the producer to the grammar. `openspec/specs/auth/spec.md:41` fixes the grammar — "Every token SHALL carry a `scope` (one of `*` for full access, `project:<id>` for project-restricted, `read:*` for read-only, or `read:project:<id>` for read-only project-restricted)" — and `openspec/specs/dashboard/spec.md:189-192` says only that the form "SHALL generate a token, store its hash in `tokens`, and render the plaintext token exactly once". No requirement joins the two, and no test crosses the create → authorize boundary: the only test that mints through the form (`test/dashboard-e2e.test.ts:209-213`) passes `project: ''`, so neither branch of the conditional is exercised.

The structural fix is already in the repo, on the OAuth side. `oauth_tokens.project_id` is the persisted truth and the `TokenScope` is composed at authenticate time (`services/oauth.ts:245`, whose comment at `:241-244` says exactly that), which is why an OAuth project-bound token cannot have this defect — and `openspec/specs/mcp-oauth/spec.md:150` states it as a requirement: "An OAuth grant SHALL be bound to the project it was consented for, and that binding SHALL be a property of the minted token, not merely of the connection URL." The static-token side is the odd one out. `tokens.project_id` has carried an **enforced FK to `projects(id)` since migration 0000** (`db/migrations/0000_initial_tables.sql:89,93`) with `foreign_keys = ON` from `db/client.ts`, and the dashboard bypasses it by passing `projectId: null` for every token (`:208`). Measured directly: inserting a token row with `project_id = '<real project id>'` is **ACCEPTED**; inserting `project_id = 'probe-proj'` (the slug) is **REJECTED** with `SqliteError: FOREIGN KEY constraint failed`. The guard has been in the schema since day one, unused.

## What Changes

- **The two form controls compose instead of one voiding the other.** Reach comes from the project selector (absent → all projects); the verb comes from a new `access` control (`write` default, `read`). That yields all four arms of the grammar `auth/spec.md:41` already fixes, including the currently unmintable `read:project:<id>`, and removes the silent discard rather than warning about it. Rejected: keeping the two controls mutually exclusive and warning when both are set — a warning would document the defect instead of removing it, and would still leave `read:project:<id>` unmintable.
- **The scope string stops being caller-supplied for the project arm.** `CreateTokenInput.scope` narrows from `TokenScope` to `'*' | 'read:*'`, and a second arm takes the resolved `Project` row plus `access`. `TokensService.create` composes `` `project:${project.id}` `` / `` `read:project:${project.id}` `` **and** sets `projectId`. Measured against `tsc --strict`: `` scope: `project:${slug}` `` and even `` scope: `project:${proj.id}` `` become compile errors, `{ project, access }` without `access` is a compile error, and passing both arms at once — the #309 shape — is a compile error, while all 31 existing `scope: '*'` / `scope: 'read:*'` call sites keep compiling unchanged. Rejected: making `tokens.project_id` the sole truth with the string derived at authenticate time (costed in `design.md` D3) and branding `ProjectId` (also costed; measured to work, but ~10× the churn and it leaves `project_id` NULL).
- **`tokens.project_id` becomes populated, so the day-one FK does the enforcing.** A slug in that column is rejected by SQLite, not by convention.
- **A legacy-safe `CHECK` closes the drift the redundancy would otherwise allow.** `CHECK (project_id IS NULL OR scope = 'project:' || project_id OR scope = 'read:project:' || project_id)` makes a scope string that disagrees with `project_id` unrepresentable. Same shape and same justification as `0026_confirmation_verdict_check.sql`, and — unlike `0011`/`0012`, where the constraint encoded a tunable number — this one encodes a representational invariant that will never need retuning. The rebuild is **total, not abortable**: every legacy row has `project_id IS NULL` and therefore passes unchanged.
- **Existing malformed rows are NOT migrated.** They are inert because the defect fails closed; rewriting them would fail **open**, activating credentials the operator has never seen work. They are surfaced in the tokens list instead, as a distinct state that is honest about being neither active nor revoked.
- **The tokens list gains the `project` column `dashboard/spec.md:187` already requires**, rendering the project **slug** (never the ULID — `dashboard/spec.md:1040` forbids id columns, and `dashboard/consolidation.ts:42-47` is the precedent, asserted at `test/dashboard-e2e.test.ts:542,552`), plus the scope actually minted echoed in the one-time-view panel so the operator can see what they got.
- **The missing test arm crosses create → authorize.** A unit test on the handler would assert the same wrong string the handler produces, so the new arm posts the real form and then uses the returned plaintext against the real HTTP boundary, with two controls: the admin token must succeed on the same endpoint, and the minted token must be **denied on a different project**. Without the second control, a fix making `isAuthorized` return true unconditionally would pass.
- Not **BREAKING** for any working token. Every `*` / `read:*` row is untouched; every `project:<slug>` row keeps behaving exactly as it does today (denied everywhere). **BREAKING** for one caller shape only: a scripted `POST /dashboard/tokens` carrying the old `scope` field is now rejected with a message naming `access`, rather than silently minting something else — silently ignoring an unrecognized field is the #309 failure mode and is not retained.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `auth`: adds a requirement binding the **producer** to the grammar `spec.md:41` already fixes — a persisted project-scoped token SHALL carry `project_id` referencing the project row, and the `project:` / `read:project:` segment SHALL be that same id, enforced by the database rather than by convention. Also states what happens to a token whose scope names a project it does not resolve to: it authorizes nothing and is not repaired. `spec.md:41` and its scenarios at `:43-47` are unchanged — the producer is moving to them.
- `dashboard`: modifies "Tokens MUST be manageable from the dashboard" (`spec.md:185-197`). The form's reach and access controls SHALL compose and SHALL be able to mint every arm of the grammar; the minted scope SHALL be echoed in the one-time-view panel; the list SHALL render the `project` column the requirement already names, as a slug; and a token whose project binding does not resolve SHALL be marked distinctly from `active` and from `revoked`.
- `persistence`: adds the `tokens` table-rebuild requirement — the `CHECK`, its legacy-total `INSERT … SELECT`, the indexes the `DROP TABLE` takes with it, and the fact that `tokens` is an FK **parent** of `sessions` and `dashboard_sessions` so the runner's `foreign_keys = OFF` / `foreign_key_check` envelope is what makes the drop legal.

Checked and deliberately **not** given a delta:

- `mcp-oauth` — already conforms; `spec.md:150` is the requirement this change brings the static-token side up to, and no OAuth behaviour changes.
- `mcp-api` — `isAuthorized`'s semantics, the read/write classification and every scope-resolution contract are untouched. Only what gets written into `tokens.scope` changes.
- `http-api` — `/api/<slug>/memory/recall` is the new test's instrument, not a changed contract; no requirement moves.
- `projects` — slug rules, autocreate semantics and `projects/spec.md:33`'s legacy-slug guarantee are untouched.
- `data-access` — no SQL leaves `db/`, no new `admin*` or `unsafe*` method: the project column is served by the `ProjectsService.list(true)` the router already calls at `dashboard/tokens.ts:66`.

## Impact

Durable invariants touched: **none weakened.** Scope is still resolved at the service layer and repositories still enforce the filter they are given; this change only fixes what a token's scope _says_. Append-only, `topic_key` convergence, fresh-context judgment and derived-never-stored review state are untouched. No memory row is read or written.

Code:

- `apps/server/src/services/tokens.ts` — `CreateTokenInput` (`:49-54`) gains the discriminated grant; `create` (`:83-105`) composes scope + `projectId`; the scope-grammar docstring (`:33-38`) states where the string is composed; `pinnedProjectId`'s docstring (`:276-278`) currently asserts "`tokens.project_id`, which the only production creation path leaves NULL" — no longer true and must be corrected.
- `apps/server/src/dashboard/tokens.ts` — the form (`:130-137`), the create handler (`:160-210`), the list headers (`:99-104`) and rows (`:36-64`), `stateOf` (`:30-34`), `scopeBadge` (`:249-253`), the one-shot panel (`:68-80`).
- `apps/server/src/db/schema/tokens.ts` — the `CHECK` in the Drizzle declaration and the scope docstring (`:7-12`).
- `apps/server/src/db/migrations/0029_tokens_project_binding.sql` — new; the rebuild.
- `apps/server/src/scripts/seed-dev.ts:131-140` and `apps/server/src/scripts/seed-volumetric.ts:527` — the only non-dashboard `create` call sites; seed-dev already passes `projectId: proj.id` and moves to the grant arm.

Tests:

- `apps/server/src/test/dashboard-e2e.test.ts` — the missing create → authorize arms (`:200-236` and `:576-579` also move to the `access` field).
- `apps/server/src/test/schema-drift.test.ts` — `tokens` index snapshot (`:226-227`); columns are compared as sorted sets (`:400-405`) so the column list needs no edit if the rebuild preserves it.
- `apps/server/src/services/tokens.test.ts`, plus the 31 `create({…})` call sites across 21 test files — all but the project-arm ones compile unchanged, measured.

No dependency change. No `apps/plugin/` change: nothing in the plugin tree mints or parses a token scope. Migration `0029` is the one thing that must be smoked against pre-existing seeded data.

Closes #307 and #309.
