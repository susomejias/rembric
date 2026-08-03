# Design — mint the token the operator asked for

## Context

Two defects, one cause. The dashboard is the **only production writer of a persisted project-scoped token string**, and it writes a slug where the reader expects an id; the same twenty lines also make the two form controls mutually exclusive in the handler while presenting them as independent in the UI. Both were re-reproduced on `main @390170c` through the real form and the real HTTP boundary, each with a passing admin control — see `proposal.md` for the measured table.

Four structural facts shape the fix.

**Fact 1 — the producer/consumer disagreement is not detectable by the type system as written.** `TokenScope` is `'*' | 'read:*' | \`project:${string}\` | \`read:project:${string}\`` (`services/tokens.ts:47`). `'project:probe-proj'`is a perfectly valid inhabitant. So`authorizeRow`'s `row.scope as TokenScope` (`:165`) is not a lying cast — the type genuinely cannot separate a slug from a ULID. Any fix that leaves the scope string caller-supplied leaves the defect one keystroke away.

**Fact 2 — the enforcement already exists in the schema and is unused.** `tokens.project_id` has an enforced FK to `projects(id)` from migration `0000` (`0000_initial_tables.sql:89,93`) and `db/client.ts` sets `foreign_keys = ON`. Measured directly against a migrated test database:

| Inserted `tokens.project_id`                          | Result                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| `'01JQZZZZZZZZZZZZZZZZZZZZZZ'` (a real `projects.id`) | **ACCEPTED** (control)                                      |
| `'probe-proj'` (the slug)                             | **REJECTED** — `SqliteError: FOREIGN KEY constraint failed` |

The dashboard bypasses it with `projectId: null` at `dashboard/tokens.ts:208`. `seed-dev.ts:131-140` — the only other project-arm creator — already passes `projectId: proj.id`, so the FK path is exercised in dev today and nothing about it is speculative.

**Fact 3 — OAuth already ships the shape, and its spec says so.** `openspec/specs/mcp-oauth/spec.md:150`:

> An OAuth grant SHALL be bound to the project it was consented for, and that binding SHALL be a property of the minted token, not merely of the connection URL. […] An access token bound to a project SHALL authorize as the project-restricted `TokenScope` (`project:<id>` for a write grant, `read:project:<id>` for a read grant) — so it SHALL be rejected when used against a different project or against global scope, exactly as a static `project:<id>` / `read:project:<id>` token is.

Implemented at `services/oauth.ts:245` (`scope: projectScopedGrant(resolveGrantedScope(token.scope), token.projectId)`) with the comment at `:241-244` stating the derivation. But note the asymmetry that matters for D3: `oauth_tokens.scope` was **designed** to hold the OAuth wire vocabulary (`mcp`, `read`), never a `TokenScope`. `tokens.scope` has always held a `TokenScope`. OAuth is not a retrofit; the static side would be.

**Fact 4 — the consumers of the format are two functions, both in one file.** `isAuthorized` (`services/tokens.ts:265-268`) and `pinnedProjectId` (`:279-283`). `pinnedProjectId`'s docstring is itself an artifact of the defect: "Derived from the scope string rather than `tokens.project_id`, which the only production creation path leaves NULL — the scope string is what `isAuthorized` compares against." Its single caller is `mcp/_shared.ts:114`. The blast radius of changing the representation is therefore small, which is what makes the structural option affordable rather than aspirational.

## Goals / Non-Goals

**Goals:**

- Every path through the token form SHALL mint the token the operator selected — all four arms of the grammar `openspec/specs/auth/spec.md:41` fixes, including the currently unmintable `read:project:<id>`.
- Writing a slug into the project segment SHALL stop compiling, and writing a non-project into `tokens.project_id` SHALL stop being storable.
- The redundancy between `tokens.scope` and `tokens.project_id` SHALL be enforced by the database, not by single-writer discipline.
- Existing malformed rows SHALL stay inert and SHALL become visible to the operator.
- The suite SHALL cover the create → authorize boundary, which no test crosses today.

**Non-Goals:**

- Turning `global` into an ordinary default project, the silo model, and `all_projects`. A separate, later direction — see §Constraints on the later scope collapse.
- Changing what a project-pinned token resolves to on a path-less `/mcp` connection. Rejected in `openspec/changes/archive/2026-08-02-tell-the-truth-about-unresolvable-scopes/design.md:109-116`, whose §Rejected reads: "**Rejected — resolving a project-pinned token on path-less `/mcp` to its own project.** Issue #302's primary proposal. Out of scope by decision, not oversight" — because "There is a working, one-call workaround (`project.use({slug})`)" and because "It moves `memory.save({scope:'project'})` on a path-less connection from `project_required` to a silent write into the token's project."
- Repairing, re-scoping or revoking any existing token row (D5).
- Changing `isAuthorized`, the read/write classification, or any scope-resolution path.
- Whether a token pinned to a project that is later **archived** should keep authorizing. That is pre-existing behaviour (`isAuthorized` does not consult `archived_at`), unchanged here — but populating `project_id` makes it visible in the list for the first time, so it is named rather than left to be discovered.

## Decisions

### D1 — The two controls compose: reach from the project selector, verb from a new `access` control

`project` (empty → all projects, else an existing slug) × `access` (`write` default, `read`) → all four arms:

| `project` | `access` | `tokens.scope`      | `tokens.project_id` |
| --------- | -------- | ------------------- | ------------------- |
| `''`      | `write`  | `*`                 | `NULL`              |
| `''`      | `read`   | `read:*`            | `NULL`              |
| slug      | `write`  | `project:<id>`      | `<id>`              |
| slug      | `read`   | `read:project:<id>` | `<id>`              |

The default submission (`project=''`, `access=write`) yields `*`, which is what the current default (`project=''`, `scope=''`) already yields at `dashboard/tokens.ts:187` — so no existing default behaviour moves.

_Why not keep the controls exclusive and warn when both are set._ A warning documents the defect rather than removing it, and leaves `read:project:<id>` unmintable — the whole reason the third row of the reproduction table is the only correct one. #309's own suggested direction is composition, for the same reason.

_Why the field is renamed `scope` → `access`, and an old `scope` field is rejected rather than ignored._ The control's meaning changes from "override the whole scope" to "pick the verb"; keeping the name would leave a field whose values (`''`/`'*'`/`'read:*'`) no longer describe what it does. And silently dropping a field the caller sent **is** the #309 failure mode — a scripted POST carrying the old field must get an error naming `access`, not a token with a different reach than the caller asked for. This is the one **BREAKING** surface in the change and it is breaking in the fail-loud direction.

_Why the minted scope is echoed in the one-time-view panel._ #309's core complaint is that "Nothing in the response or the tokens list tells the operator their choice was dropped." Composition removes the drop; echoing the result removes the class — the operator sees the artifact, not just the secret. Server-rendered, so it needs no JS and no new design token; `openspec/specs/dashboard/spec.md:247` ("No frontend build pipeline SHALL be required") is unaffected. A live client-side preview of the resulting scope was considered and rejected as JS for something the confirmation panel states authoritatively.

### D2 — Populate `tokens.project_id`; the day-one FK does the enforcing

`TokensService.create` sets it for the project arm. Per Fact 2 this makes a slug in that column a database error rather than a convention violation. Nothing else is required to get this — the constraint has been there since `0000`.

### D3 — RECOMMENDED: the constructor takes the resolved `Project` row. NOT: make the column the sole truth and derive the string

The two options the owner asked to be costed against each other.

**Chosen — `CreateTokenInput` becomes a discriminated grant.**

```ts
type TokenGrant =
  | { scope: '*' | 'read:*'; project?: never; access?: never }
  | { project: Project; access: 'read' | 'write'; scope?: never };

type CreateTokenInput = { name: string; expiresAt?: Date | null } & TokenGrant;
```

`create` composes `{ scope, projectId }` from the grant in one place. Measured with `tsc --strict` on exactly this shape:

| Call site                                               | Result                               |
| ------------------------------------------------------- | ------------------------------------ |
| `create({ name, scope: '*' })`                          | compiles                             |
| `create({ name, scope: 'read:*' })`                     | compiles                             |
| `create({ name, project, access: 'write' \| 'read' })`  | compiles                             |
| ``create({ name, scope: `project:${slug}` })``          | **TS2322** — the defect              |
| ``create({ name, scope: `project:${proj.id}` })``       | **TS2322** — even the correct string |
| `create({ name, scope: '*', project, access: 'read' })` | **TS2322** — the #309 shape          |
| `create({ name, project })`                             | **TS2345** — `access` missing        |

Requiring the `Project` **row** rather than a `projectId: string` is load-bearing: a bare string re-admits the slug. The row can only have come from `findBySlug` / `create` / `getById`, so the caller has already resolved it — and the dashboard handler already holds it as `p` at `dashboard/tokens.ts:169-170`.

Churn, measured: 31 `create({…})` call sites across 21 test files plus 4 non-test ones. All but the project-arm sites (`seed-dev.ts:131,136`, `dashboard/tokens.ts:205`) pass `scope: '*'` or `scope: 'read:*'` and compile **unchanged**, because the first arm keeps the `scope` key. The 10 raw `insert(tokens)` fixtures bypass the service and are unaffected. `bootstrapAdmin` (`services/tokens.ts:181-200`) also inserts through the repository directly; it writes `scope: '*', projectId: null`, which the `CHECK` in D4 permits, so it is left alone.

**Rejected — `tokens.project_id` as sole truth, `TokenScope` derived at authenticate time (the OAuth shape).**

One line: `authorizeRow` (`:158-166`) returns `projectScopedGrant(row.scope as '*' | 'read:*', row.projectId)` instead of `row.scope as TokenScope`. Genuinely elegant, and it is what OAuth does. Rejected on three grounds, in order of weight:

1. **It leaves the database in exactly the shape the owner said not to leave it in.** Because existing rows may not be rewritten (D5), `tokens.scope` would have to keep honouring the legacy `project:*` string form forever. One column, two vocabularies, distinguished only by row age, with a compat branch that no future migration is allowed to retire. That is the "BD un poco rarita" outcome.
2. **It contradicts a requirement that already exists.** `openspec/specs/auth/spec.md:41` — "Every token SHALL carry a `scope` (one of `*` for full access, `project:<id>` for project-restricted, `read:*` for read-only, or `read:project:<id>` for read-only project-restricted)" — would become false of the persisted column. The chosen option leaves that sentence literally true of every row, old and new. (OAuth needs no such reconciliation because `oauth_tokens.scope` never held a `TokenScope`; see Fact 3.)
3. **It has no compile-time guard.** Nothing would stop the next author writing `` scope: `project:${slug}` `` again; the string would simply be **ignored**. A silent wrong replaces a loud wrong. The chosen option makes that line fail to compile.

**Also rejected — branding `ProjectId`.** Measured to actually work: with `type ProjectId = string & { readonly [b]: 'ProjectId' }`, ``take(`project:${slug}`)`` against a `` `project:${ProjectId}` `` parameter fails with `TS2345`, and ``take(`project:${id}`)`` passes. So the mechanism is real, not folklore. Rejected on cost and completeness: the brand would have to flow through `Project.id`, every projects repository method, `Scope`, `isAuthorized`, `pinnedProjectId`, `projectScopedGrant`, the MCP tool argument types and the ~dozens of tests that hand-build `` `project:${proj.id}` `` — an order of magnitude more surface than D3 — and it still would not populate `tokens.project_id`, so the database would stay exactly as odd as it is today. D3 buys the same guarantee at the one site that persists a scope, and D2+D4 buy the database half that branding cannot.

### D4 — A legacy-safe `CHECK` closes the drift the redundancy would otherwise allow

D2+D3 leave `scope` and `project_id` encoding the same fact. The FK proves `project_id` names a real project; nothing proves the string agrees with it. So:

```sql
CONSTRAINT tokens_project_scope_check CHECK (
  project_id IS NULL
  OR scope = 'project:' || project_id
  OR scope = 'read:project:' || project_id
)
```

Truth table on the rows that exist:

| Row                                                                      | Verdict               |
| ------------------------------------------------------------------------ | --------------------- |
| `*` / `read:*`, `project_id IS NULL` (admin, `bootstrapAdmin`)           | passes                |
| legacy `project:<slug>`, `project_id IS NULL` (the malformed population) | **passes, unchanged** |
| new `project:<id>`, `project_id = <id>`                                  | passes                |
| `project:<id-of-X>`, `project_id = <id-of-Y>` (drift)                    | **rejected**          |

The rebuild is therefore **total, not abortable** — the property `0026_confirmation_verdict_check.sql` established and `openspec/specs/persistence/spec.md:933` states: "The rebuild SHALL be total rather than abortable […] instead of failing the `CHECK` mid-migration and leaving an operator with a server that will not boot and no way forward." Here it is total without any normalisation at all, because every legacy malformed row has `project_id IS NULL`. No `CASE` is needed and none is written; the `INSERT … SELECT` is a verbatim copy.

The `CHECK` deliberately does **not** try to assert "a project-shaped scope implies a non-NULL `project_id`" — that form is the one that would reject the legacy population and force either an abort or the forbidden rewrite. The producer-side half of that implication is bought by D3 instead, where it costs a compile error rather than a migration.

_Why a `CHECK` at all, given this repo added one in `0011` and dropped it one migration later._ `0012_drop_summary_length_check.sql` removed the `sessions.summary` cap because the constraint encoded a **tunable policy number**: "The cap now lives solely in the server (`SUMMARY_MAX_CHARS`), so changing it is a one-line constant edit with no further table rebuilds." This constraint encodes a **representational invariant** — two columns must name the same project — which has no tuning dimension and no plausible future value. It is the `0026` class, not the `0011` class.

_Rejected alternative:_ skip the `CHECK` and rely on `create` being the single writer. Cheaper (no rebuild, no boot risk) and the drift it prevents has never occurred. Rejected because "one function is careful" is exactly the guarantee that failed here: `dashboard/tokens.ts` **was** the single writer, and it wrote the wrong thing for the entire life of the feature. Recorded as OQ2 because the rebuild is the riskiest item in the change and the owner may prefer to sequence it separately.

### D5 — Existing malformed rows are left inert and surfaced, never repaired

Owner's decision, and the reasoning is worth recording because it inverts the usual instinct. The defect **fails closed**: every `project:<slug>` row authorizes nothing, anywhere, today. A migration rewriting the segment to the resolved id would **fail open** — it would activate a credential the operator has never seen work, possibly still sitting in an MCP config on a machine they retired, with no revocation event and no audit trail. The population is small by construction (tokens are minted one at a time through a form; there is no bulk path). Leaving them inert keeps the operator in control; the tokens list is where they learn the rows exist.

_Rejected alternative:_ set `revoked_at` on them during the migration. Superficially attractive — it is the fail-closed direction, and it would let the `CHECK` be written in its stronger form. Rejected because `revoked_at` records an operator action, and writing it for rows nobody revoked makes the audit trail lie; and because the owner's instruction is to surface them, and a `revoked` pill hides them among rows that were deliberately retired.

_Detection, for the list:_ a row is anomalous when its scope names a project (`pinnedProjectId(scope) !== null`) and that value is not the id of an existing project. This is the inverse of the precedent at `dashboard/consolidation.ts:42-47`, whose `scopeLabel` resolves `project:<id>` to a slug and falls back to the raw string. The state is rendered as its own pill, distinct from both `active` and `revoked`; `inert` is the default label unless the owner prefers other wording. Precedence in `stateOf` (`dashboard/tokens.ts:30-34`): `revoked` → `expired` → anomalous → `active`, because a revoked malformed row is revoked first.

### D6 — The tokens list gains the `project` column the spec already requires, as a slug

`openspec/specs/dashboard/spec.md:187` has required it since it was written; the implementation renders six headers and none is `project` (measured: `<thead><tr><th>name</th><th>scope</th><th>created</th><th>expires</th><th>state</th><th>actions</th></tr></thead>`). This is a conformance gap being closed, not a new feature — which is why the requirement is _modified_ rather than added.

The cell renders the **slug**, resolved from `project_id`, never the ULID: `dashboard/spec.md:1040` ("Dashboard list tables SHALL NOT render a dedicated `id` column") and the sibling precedent at `dashboard/consolidation.ts:42-47`, asserted with `not.toMatch(/<td>project:01[A-Z0-9]+<\/td>/)` at `test/dashboard-e2e.test.ts:542` and `:552`. Resolution uses the `ProjectsService.list(true)` the router already calls at `dashboard/tokens.ts:66` (with archived included, so a token pinned to an archived project still shows its slug), built once into an id → slug map. No new repository method, no `admin*` call site, no SQL outside `db/` — `openspec/specs/data-access/spec.md` is untouched.

For an anomalous legacy row the project cell renders `—` (its `project_id` is NULL, and printing the unresolvable slug from the scope string would look like a working pin); the raw segment stays visible in the `scope` cell, which already renders it verbatim via `scopeBadge` (`:249-253`).

No `data-confirm` modal is involved: creating a token is not destructive, and the existing revoke form already carries the modal correctly (`:53-55`). No design token changes — the new pill reuses the existing pill classes.

### D7 — The missing test arm crosses create → authorize, at the HTTP boundary, with two controls

A unit test on the create handler would assert the same wrong string the handler produces, which is precisely why 31 test call sites encode the contract correctly while the one producer that violates it went untested. So the arm must: post the real form to `/dashboard/tokens`, take the plaintext out of the redirect's `created` query parameter, and use it as a bearer against a real endpoint. `test/dashboard-e2e.test.ts` already boots a real server over `@hono/node-server` and drives it with `fetch`, so the harness exists.

Both controls are mandatory, and each rules out a specific broken-probe or broken-fix outcome:

- **The admin `*` token must succeed on the same endpoint.** Without it, a 403 cannot be distinguished from a misconfigured endpoint or an empty corpus.
- **The minted token must be denied on a _different_ project.** Without it, a "fix" making `isAuthorized` return `true` unconditionally passes the whole arm.

### D8 — `pinnedProjectId` keeps parsing the scope string

Its single caller (`mcp/_shared.ts:114`) has a `TokenScope`, not a `Token` row, and the canonical string remains the input `isAuthorized` compares — so there is nothing to gain from switching it to `project_id` and a signature change to lose. Its docstring, however, currently asserts something this change makes false ("`tokens.project_id`, which the only production creation path leaves NULL") and must be corrected in the same commit; a stale comment claiming the opposite of the new invariant is worse than no comment.

## Constraints on the later scope collapse

The owner intends to collapse `Scope` to a single arm later (`global` as an ordinary default project, the silo model, `all_projects`). Recording where this change helps and where it charges rent:

- **Helps:** once `project_id` is the FK-enforced binding on every new token, "which project is this token for" stops being a string-parsing question. A future `global`-as-project token is `project:<id-of-global>` with `project_id` set, and both the FK and the `CHECK` accept it with no migration.
- **Charges rent:** the `CHECK` enumerates the two project-shaped prefixes literally. Adding a fifth scope arm (`all_projects`, or a silo-scoped form) that also carries a `project_id` will need the `CHECK` extended, which is another `tokens` table rebuild. That is a known, bounded cost — one migration in the change that introduces the new arm — and the alternative (no `CHECK`) buys freedom from it by giving up the enforcement (see OQ2).
- **Does not constrain:** `project_id IS NULL` currently means "not project-pinned". If the later direction gives that state a name (`all_projects`), nothing here has to move — `*` and `read:*` keep meaning what they mean, and the `CHECK`'s `project_id IS NULL OR …` disjunct already permits any scope string alongside a NULL binding.

## Risks / Trade-offs

- **[Risk] The `0029` rebuild `DROP`s a table that is an FK parent of `sessions` (`0003_sessions_and_slugs.sql:27`) and `dashboard_sessions` (`0000_initial_tables.sql:103-108`), on a live populated database.** → Mitigation: the migration runner already wraps every migration in `PRAGMA foreign_keys = OFF` → `BEGIN IMMEDIATE` → body → `PRAGMA foreign_key_check` → `COMMIT` (`openspec/specs/persistence/spec.md:587`), which is exactly what makes a parent drop legal and what proves nothing dangled before commit; `0012_drop_summary_length_check.sql` rebuilt `sessions` — itself an FK parent — under the same envelope. The migration adds no pragma of its own. Verified by a real Docker smoke against pre-existing seeded data, not by reasoning.
- **[Risk] A `DROP TABLE` takes every index with it.** → Mitigation: `tokens` currently has exactly one explicit index, `tokens_name_unique` (`tokens_revoked_at_idx` was dropped by `0028_drop_unusable_indexes.sql`), plus the `sqlite_autoindex_tokens_1` that `id text PRIMARY KEY` creates. `test/schema-drift.test.ts:409` asserts the index set as an **exact set** including both names (`:226-227`), so an omission is a red test rather than a silent regression.
- **[Risk] A hand-edited database with a non-NULL `project_id` that disagrees with its scope string would fail the new `CHECK` and abort the boot.** → Mitigation: no code path can produce such a row — the only two writers that ever set `project_id` are `seed-dev.ts:131-140` (which sets it equal to the scope's id) and, after this change, `create`; the dashboard has always passed `null`. The migration is nonetheless written as a verbatim copy so the failure mode, if it ever occurs, is a clean pre-commit abort with the row identifiable by `foreign_key_check`-adjacent inspection rather than a partial write. Tasks include probing the abort path deliberately so its behaviour is known rather than assumed.
- **[Trade-off] `tokens.scope` and `tokens.project_id` remain redundant for project-arm rows.** → Accepted because the redundancy is what keeps `auth/spec.md:41` literally true of every row and keeps `isAuthorized` untouched, and because D4 makes the redundancy non-drifting at the database level. The alternative (D3's rejected branch) trades this redundancy for a column with two vocabularies, which is the worse odd shape.
- **[Trade-off] An operator with a scripted `POST /dashboard/tokens` sending `scope=read:*` gets an error after upgrade.** → Accepted, and deliberate: the alternative is to keep silently ignoring a field the caller sent, which is the #309 defect. The error message names `access` and the mapping, so the fix is one substitution. Called out in the release notes as the change's single breaking surface.
- **[Trade-off] Legacy malformed tokens stay dead.** → Accepted (D5). The operator's remedy is to mint a replacement through the now-working form and revoke the old row; the list tells them which rows those are.
- **[Risk] The new e2e arm could pass while proving nothing** — the failure mode this repo has hit three times in one session. → Mitigation: D7's two controls plus `scripts/mutate.mjs` runs that weaken each new condition separately and confirm the naming test goes red. A test green on both sides of the change is treated as a finding, not a pass.

## Migration Plan

1. `0029_tokens_project_binding.sql` rebuilds `tokens` with the `CHECK`, copies every row verbatim, and recreates `tokens_name_unique`. Idempotent by the runner's `_migrations` ledger (`openspec/specs/persistence/spec.md:63`).
2. First boot after upgrade: no behaviour change for any working token. `*` and `read:*` rows authenticate and authorize exactly as before. Legacy `project:<slug>` rows continue to be denied — unchanged, by design (D5) — and begin rendering with the anomalous state pill.
3. No derived data is invalidated. `memory_fts`, `memory_vec` and the three entity tables are functions of `memory`, which this change does not read or write; the entity recipe hash is untouched, so no re-scan is triggered.
4. **Rollback:** downgrading the server binary leaves the rebuilt `tokens` table in place. The older binary's `INSERT` shapes all satisfy the `CHECK` (`bootstrapAdmin` writes `project_id = NULL`; the old dashboard handler writes `projectId: null`), so a rolled-back server keeps working — it simply resumes minting inert `project:<slug>` rows. The `CHECK` is not itself a downgrade barrier. There is no data-shape rollback to perform because no row's data changed.

## Open Questions

1. **Should the create handler keep auto-creating a project row from an unknown slug?** `dashboard/tokens.ts:169-170` runs `findBySlug(projectInput) ?? create({slug: projectInput})` before the scope is decided, and #309 notes this "reinforc[es] the impression that the selection took effect". The `<select>` only offers existing projects (`:135`), so the branch is now reachable only by a hand-crafted POST. Removing it would make a typo an error instead of a phantom project pinned to a live token; keeping it preserves a documented convenience. **Default if unanswered: keep it**, since removing behaviour is not what either issue asks for — but the delta spec must state which, so it stops being incidental.
2. **Does the `CHECK` earn its table rebuild in _this_ change, or should D2+D3 land first and D4 follow separately?** The rebuild is the only item here that touches a populated table and the only one that can fail a boot. **Default if unanswered: ship it here**, because without it the two columns are redundant-and-unenforced and the change would leave precisely the "future headache" shape it exists to remove — and because splitting it means two `tokens` rebuilds instead of one if the later scope collapse extends the constraint anyway.
