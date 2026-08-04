## Context

`TokenScope` (`apps/server/src/services/tokens.ts:52`) has four arms and the type below it (`:54-58`) documents the reason: reach is "either global … or a **single** project". Every consumer was written against that reading. `pinnedProjectId` (`:310-314`) parses one id out of the string; `projectPinRemedy` (`mcp/_shared.ts:108-121`) names one slug in its remedy text; `dashboard/tokens.ts:51` resolves one `projectId` to one cell; `isAuthorized` (`:268-290`) compares one id against one target.

The demand this change answers — one agent, three repositories — is unrepresentable, and the client cannot route around it: `apps/plugin/bin/rembric-bridge.mjs` reads one `REMBRIC_API_TOKEN` from the environment (`:43-44`) and derives the endpoint per-repository from `.rembric::PROJECT_SLUG` (`:54-61`). One credential slot, N endpoints. So the only mintable answer today is `*`, which is admin.

Two constraints bound every option below.

**Existing rows must not change meaning.** Real installations hold `*`, `read:*`, working `project:<id>` rows and — per `auth/spec.md:264-283` — legacy malformed rows that must stay inert forever. Any authorization rule that can flip an existing `true` to `false` silently narrows a live credential; any rule that flips a `false` to `true` on the legacy population activates a credential the operator never saw work, which is the exact failure `auth/spec.md:268` forbids.

**`*` is the admin scope, by string comparison, in three places** (`server/dashboard-router.ts:156`, `server/http.ts:489`, `dashboard/maintenance.ts:143`). A reach construct that can be _computed_ into admin is a privilege-escalation surface.

## Goals / Non-Goals

**Goals:**

- One token can reach an operator-chosen set of projects, without that set being `*`.
- Every pre-existing token behaves byte-identically, at every endpoint, in status and error code.
- A set naming every project is still not admin and still cannot log in to the dashboard.
- The migration is additive and the schema change is loud (a red test) rather than silent.
- The deferred per-project-verb capability has a recorded, measured upgrade path.

**Non-Goals:**

- **Multi-project OAuth grants** (D10).
- **Per-project access verbs** in v1 (D5) — deferred, with the ALTER measured.
- **`all_projects`** as an MCP-visible widening (D13) — related, not unblocked by this change.
- **Reconciling `dashboard/spec.md:710`**, which is vacuous today for reasons predating this change (OQ6).
- Any change to memory, sessions, consolidation or retrieval. No memory row is read or written.

## Decisions

### D1 — This change lands after `retire-the-global-scope`, and the ordering is a hard sequence, not a preference

Three measured hazards, in descending severity.

1. **Migration numbering is not protected.** `db/migrate.ts:55-57` is `readdirSync(opts.migrationsDir).filter((f) => f.endsWith('.sql')).sort()`, and the ledger is keyed on filename. Executed with two branches both writing `0030_*`: **both were applied, ordered by the alphabetical suffix rather than by intent, with no duplicate-prefix detection**. Control: a re-run applied nothing, so idempotency itself is fine — the defect is that "0030" is not a unique slot. The migration number is therefore assigned at apply time, after the predecessor's file exists.
2. **`isAuthorized` is rewritten by both changes, in different dimensions.** `retire-the-global-scope` deletes the `scope: 'global' | 'project'` arm of its third parameter (`tokens.ts:271`); this change rewrites its **first** parameter. Same 22-line function, same seven direct non-test call sites. Merged in the wrong order the union retains a dead `target.scope === 'global'` branch that reads as intentional.
3. **The `Scope`/`TokenScope` 1:1 breaks here.** `Scope` (`services/scope.ts:17`, `{ kind: 'global' } | { kind: 'project'; projectId: string }`) is the request's effective scope; `TokenScope` is the credential's reach, and today they line up one-to-one through `pinnedProjectId` / `projectScopedGrant`. This change makes the credential a set while the request stays singular. `retire-the-global-scope` changes `Scope`'s shape. Nothing in the type system relates the two, and the only reconciler is `isAuthorized` — which both changes rewrite.

Reversed, nothing breaks: `projectPinRemedy` would simply learn to describe a set and then have that whole branch deleted. Throwaway work, not a defect. So the sequence is chosen for hazard 1 and 2, and the cost of getting it wrong is a bad merge, not a bad database.

### D2 — The set is a new scope literal (`projects` / `read:projects`) plus a `token_projects` join table, with `tokens.project_id IS NULL`

Measured on a populated database:

- `CREATE TABLE token_projects (token_id text NOT NULL REFERENCES tokens(id), project_id text NOT NULL REFERENCES projects(id), PRIMARY KEY (token_id, project_id)) WITHOUT ROWID` — **accepted, purely additive, no `tokens` rebuild.** Existing `tokens` rows byte-identical, `PRAGMA foreign_key_check` empty, `PRAGMA integrity_check` → `ok`.
- The FK enforces the same discipline `tokens.project_id` does: inserting a **slug** was REJECTED with `SQLITE_CONSTRAINT_FOREIGNKEY`, and so was an unknown token id. Convention is not doing the work.
- `INSERT` of `scope = 'projects'` with `project_id = NULL` is **ACCEPTED by the existing `tokens_project_scope_check`**, whose first disjunct is `project_id IS NULL` (`db/schema/tokens.ts:40`). **No table rebuild.**

This **refines** the prediction at `openspec/changes/archive/2026-08-03-mint-the-token-the-operator-asked-for/design.md:176`:

> **Charges rent:** the `CHECK` enumerates the two project-shaped prefixes literally. Adding a fifth scope arm (`all_projects`, or a silo-scoped form) that also carries a `project_id` will need the `CHECK` extended, which is another `tokens` table rebuild.

The condition is "that also carries a `project_id`", and this arm does not. The same design's `:177` anticipated the escape: "the `CHECK`'s `project_id IS NULL OR …` disjunct already permits any scope string alongside a NULL binding." So the rent was correctly costed and is not owed here.

`WITHOUT ROWID` is chosen because the table is nothing but its composite key: every read is `WHERE token_id = ?` and the primary-key index _is_ the table, so a rowid would be a second copy of the data for no lookup.

### D3 — Option 1 (new literal) over option 1b (keep `project:<primary>`, put the extras in the join table) — **this is the shape decision, and the one an owner might reasonably overturn**

**Option 1b works and is cheaper on paper:** the row keeps `scope = 'project:<primary-id>'` and `project_id = <primary-id>`, the join table holds the additional projects, and `auth/spec.md:41`'s closed enumeration **needs no amendment at all**.

It is rejected because `pinnedProjectId` (`:310-314`) and the dashboard `project` column (`dashboard/tokens.ts:51,56`) then **under-report reach**: they say one project when the token reaches three. Under-reporting is the _safe_ direction — nothing over-authorizes — but the result is a **misreporting column**, and removing a misreporting column is precisely what `2026-08-03-mint-the-token-the-operator-asked-for` existed to do. `dashboard/spec.md:206` now requires "The `project` column SHALL show the slug of the project named by `tokens.project_id`, resolved at render time"; under 1b that sentence stays literally true while being operationally misleading, which is worse than a sentence that needs editing.

Amending one enumeration sentence (`auth/spec.md:41`) is cheaper than reintroducing that defect class. **Recorded as chosen; the explorer offered no default here, and an owner who weights "no spec amendment" above "no misreporting column" would land on 1b instead.** The cost of overturning is bounded: it changes which literal `composeGrant` writes and deletes the `auth/spec.md:41` delta; the join table, the union rule, the repository and every test in `tasks.md` are identical either way.

### D4 — Option 2 (a delimited project list inside the `scope` string) is disqualified on measurement, not on taste

- `INSERT` of `scope = 'project:<A>,<B>'` with `project_id = <A>` was **REJECTED** by `tokens_project_scope_check`. It is accepted **only** with `project_id = NULL` — i.e. only by abandoning the FK binding that `auth/spec.md:222` exists to enforce.
- `pinnedProjectId('project:A,B')` returns the string `"A,B"`, and `isAuthorized` is consequently **false for both A and B**. The construct authorizes nothing.
- Worse, `dashboard/tokens.ts:37-45` renders such a row as **`inert`** — `pinned !== null && !slugById.has(pinned)` is true for `"A,B"` — which makes it **indistinguishable from a legacy malformed row**, the population `auth/spec.md:268` says "SHALL continue to authorize nothing … No migration, boot-time repair, or lazy fix-up SHALL rewrite its `scope`". Two populations, one shape, opposite required treatments. That is unfixable without a shape-distinguishing heuristic, and `auth/spec.md:270` already rules heuristics out: "Legacy project slugs are not shape-distinguishable from other values … so no heuristic can safely separate them."

### D5 — One access verb for the whole set in v1, with the upgrade path measured

Reasons in order of weight:

1. `dashboard/spec.md:189` locks **"two independent controls"** composing reach × verb. One verb turns 2×2 into **2×N** — an extension of that rule. A per-project verb replaces the enumerated table with a row-per-project control, which is a different requirement, not an extension of this one.
2. `project.use` gates only on `'read'` (`mcp/project-tools.ts:128`, `assertAuthorized('read', projectScope(project.id), deps)`). A per-project verb therefore lets a connection **open** for a project the token can only read, deferring the write refusal to `memory.save`. Not broken, but it splits one refusal into two and needs its own scenarios.
3. The stated need is "three repos", one verb.

**The honest counter, recorded:** read-shared/write-own — read a common docs project, write your own — is **not** expressible with one verb, and because a client install has one token slot (`rembric-bridge.mjs:43-44`) it is not expressible as two tokens either. v1 defers a real capability.

**The deferral is cheap and measured, so "one verb now" is not a lock-in:** `ALTER TABLE token_projects ADD COLUMN access text NOT NULL DEFAULT 'write'` on the populated `WITHOUT ROWID` table was **ACCEPTED with no rebuild**. Control: the same `ADD COLUMN` **without** a default was correctly rejected (SQLite cannot add a NOT NULL column with no default to a non-empty table), which is what tells us the acceptance came from the default and not from an empty table.

### D6 — Authorization is `legacy(scope) OR membership(set)`: additive only, never subtractive — and the set arm must not sit on a `*`/`read:*` base

The union is one `||`. It can only add `true`s.

Measured over the full cross-product of **5 scope strings × 4 targets × 2 actions** with an **empty** grant set — the state of every pre-existing row: **40 cells, 0 divergences** against today's `isAuthorized`. Non-vacuity control: **15 of the 40 cells are TRUE**, so this is not a comparison over an all-false set.

**The leak the same probe caught, and the reason the new literals exist:** with base `read:*` and a set of `{A, C}`, the probe returned **true for project B**. The base already reaches everything, so the set is decorative. Therefore the set arm **MUST NOT** reuse `*` or `read:*`. The `projects` / `read:projects` literals give it a fail-closed base, measured: `isAuthorized('projects', …)` is **false for every target and both actions**, and `pinnedProjectId('projects')` is `null`. The set arm authorizes **nothing by string alone**, which is exactly the base the union needs — and it also means legacy readers stay well-behaved on the new literal (the dashboard renders `—`/`active` rather than a false `inert`, because `pinned === null` short-circuits `unresolvable` at `dashboard/tokens.ts:38-39`).

### D7 — The membership set is authorization state and SHALL NOT be cached

`openspec/specs/auth/spec.md:69`, verbatim:

> When a token is revoked, the server SHALL reject any further request using that token starting with the next request. The server MAY cache the mapping from a successfully-verified plaintext credential to its token id, so a repeat request from the same caller does not repeat the password-hash derivation — but SHALL NOT cache the authorization outcome (valid / revoked / expired) for any duration. Every authenticated request, whether or not it hits that lookup cache, SHALL re-read the token's current `revoked_at` / `expires_at` state from storage before authorizing it. A credential-lookup cache entry MAY persist indefinitely (bounded by capacity, not by time) precisely because it never substitutes for that fresh authorization check.

Removing project B from a token must take effect on the next request, exactly as revoking the token does — otherwise "narrow this token" is a weaker operation than "revoke this token", which no operator would predict.

`verifiedCache` (`tokens.ts:149-156`) is therefore the **wrong** place. Its own comment states why: "A cache hit only ever skips the scrypt verify, never the authorization check: revoked/expired/missing is re-read fresh every time." It is permitted to live forever _precisely because_ it never substitutes for the fresh check, and putting the project set in it would void that justification.

Implementation is either a single `LEFT JOIN` inside `findById` or a second indexed read (see D11 — both measured, both negligible; the choice is a readability call for the applier).

**Flagged:** `:69` enumerates only `revoked_at` / `expires_at` and does not literally settle whether "which projects" is authorization state. **The reading recorded here is that it is** — a project set is the authorization outcome's input in exactly the way expiry is, and the operator-facing promise ("narrowing takes effect next request") is the same promise. An owner could read `:69` as an exhaustive list instead and permit caching. Recorded as OQ2.

### D8 — The three admin gates stay literal string comparisons; reaching every project is not admin

`server/dashboard-router.ts:156` (`if (resolved.scope !== '*')`), `server/http.ts:489` (same), `dashboard/maintenance.ts:143` (`if (!token || token.scope !== '*')`). None of them consults `isAuthorized`, and none of them starts to.

This is the security invariant of the change. Any rule of the form "reaches all N projects ⇒ admin" makes **creating a project** a privilege operation on unrelated tokens, and makes admin a property that appears and disappears as the project table changes. Explicitly rejected. Tested as a control (`tasks.md` 5.3a): a set token naming **every** project must be **denied** `POST /dashboard/login` and every `/admin/*` route.

### D9 — A set token cannot autocreate a project

`mcp/project-tools.ts:107` gates `project.use({autocreate: true})` on `isAuthorized(ctx.scope, 'write', { scope: 'project', projectId: null })`, whose comment (`:103-106`) explains the shape: "A project minted here can never match a project-pinned token id, so gate on an anonymous project target BEFORE creating the row." That is true only for `*`. A brand-new project is by construction not in the set, so the refusal is correct and emerges for free — but it is recorded rather than left emergent, because "my token reaches three projects but cannot create a fourth" is a question an operator will ask.

### D10 — Multi-project OAuth is an explicit non-goal

RFC 8707 `resource` is one URL, and `server/oauth-provider.ts:61-71` extracts exactly one slug from it (`const slug = path.slice('/mcp/'.length).split('/')[0]`, then `projects.findBySlug(slug)?.id ?? null`). A multi-project grant is not expressible on that wire, so `mcp-oauth/spec.md:150` — "An OAuth grant SHALL be bound to the project it was consented for" — keeps its exact meaning. `services/oauth.ts` and `dashboard/oauth-consent.ts` are untouched, and `projectScopedGrant` (`tokens.ts:298-301`) survives unchanged as the OAuth path's writer.

### D11 — No measurable cost; and the two instruments are reported separately or not at all

**Isolated statements** (better-sqlite3, warmed):

| Operation                                            | Measured       |
| ---------------------------------------------------- | -------------- |
| today's scope string compare                         | 0.065–0.082 µs |
| `Set.has` membership test                            | 0.009–0.016 µs |
| `findById` — **already one query per request today** | 2.07–2.18 µs   |
| `findById` + members (two reads)                     | 3.77–4.41 µs   |
| membership probe alone                               | 1.02–1.17 µs   |
| single `LEFT JOIN group_concat`                      | 1.99–2.89 µs   |

Marginal cost of the set: **~1.2–2.2 µs**.

**End-to-end HTTP** (p50 of 400): `GET /healthz` with a valid bearer **1.687 ms**; `GET /dashboard/login` without bearer auth **1.355 ms**. So the entire warm authentication step is **≤332 µs**, and the set is ≤0.5% of it — about **0.10%** of the request. For scale, the cold path is `scrypt(N=16384, r=8, p=1)` (`tokens.ts:46`) at **22.89 ms** per verify, roughly **13,000×** the marginal cost.

These are **two instruments** and must never be presented as one series. No performance gate is added; if anyone later claims a cost here, they owe both numbers, named.

### D12 — All new SQL goes into a repository, and `schema-drift` going red first is the proof the table landed

`data-access/spec.md:23` and `:37` already fix the pattern: one repository per aggregate, scoped reads take the `Scope` parameter, unscoped reads carry the `admin*` prefix and are callable only from `src/dashboard/`. The membership writes belong to the tokens aggregate; the dashboard's "which slugs does this token reach" read is unscoped and takes the `admin*` prefix. Grep-enforced by `test/invariants.test.ts`. **No new pattern, so no `data-access` delta.**

`test/schema-drift.test.ts:377` is `expect(tables).toEqual([...EXPECTED_TABLES].sort())` — an exact set. The new table **reds it**, which is loud rather than silent, and its going red before `EXPECTED_TABLES` is edited is the evidence the migration actually created the table. Both edits land in the same commit.

### D13 — `all_projects` is related but **not** unblocked by this change

With a set, `all_projects` stops being a privilege test and becomes a **set enumeration** — "the union of projects this token reaches" — which `mcp/project-tools.ts:200` already computes exactly: `.filter((p) => isAuthorized(ctx.scope, 'read', { scope: 'project', projectId: p.id }))`. So it would reuse a live code path instead of inventing an admin check. That is a genuine improvement in its shape.

**It is still blocked, and the blocker is the corpus/harness, not authorization.** Recorded honestly: the explorer could **not** find the frequently-cited "+0.031 MRR@8" figure anywhere in the repo and treated it as **unverified**. What _is_ recorded is `openspec/changes/archive/2026-08-03-weight-relevance-levels-by-idf/design.md:256`:

> `ceilings["8"].precisionAtK` is 0.15625 and the measured `P@8` is 0.15625 — **precision at 8 is pinned at its ceiling and cannot improve**. `recallAtK` at `k = 8` is 1.000, also its ceiling.

A harness whose gated metrics are already maxed cannot penalise widening — so it cannot be the evidence that widening is safe either.

**Counter-argument, also recorded:** set tokens make legitimate cross-project reads _common_, so the unresolved cross-project ranking question — against the just-landed IDF weighting — starts being exercised by ordinary callers rather than by one operator. That arguably makes `all_projects` **harder** to land after this change, not easier, because the blast radius of getting the ranking wrong grows.

## Risks / Trade-offs

- **[Risk] The union's two arms can be individually broken while tests stay green.** A test that only exercises `*` passes with the membership arm deleted; a test that only exercises a set token passes with the legacy arm deleted. This repo hit exactly this failure mode three times in one session. → **Mitigation:** `scripts/mutate.mjs`, one arm at a time (`tasks.md` phase 6): drop the legacy arm, drop the membership arm, make membership unconditional. Each mutation must red the test naming it. A test green on both sides is the default outcome, not the exception.
- **[Risk] A set naming every project silently becomes admin.** → **Mitigation:** D8 keeps all three gates as literal `!== '*'` comparisons, plus the explicit control in `tasks.md` 5.3a — a set token over every project denied `POST /dashboard/login` and `/admin/*`. Without that control the escalation is invisible.
- **[Risk] The set arm inherits a permissive base.** Measured: base `read:*` + set `{A,C}` returned **true for B**. → **Mitigation:** the `projects` / `read:projects` literals, whose measured behaviour is false-for-everything by string alone (D6). Spec'd as a requirement, not left to the implementation.
- **[Risk] A rolled-back server strips set tokens of all reach.** The older binary never reads `token_projects`, so a `projects`-scope row authorizes **nothing** — `pinnedProjectId('projects') === null`, `isAuthorized('projects', …)` false everywhere. → **Mitigation:** this is **fail-closed**, which is the right direction, but it is a silent total loss of reach for those tokens and MUST be stated in the release note (`tasks.md` 7.3). Operators rolling back re-mint or re-`*` deliberately, rather than discovering it from failing agents.
- **[Risk] Migration filename collision with `retire-the-global-scope`.** Measured: two `0030_*` files both apply, ordered alphabetically by suffix, no duplicate detection (D1). → **Mitigation:** the number is assigned at apply time, after the predecessor's file exists on the branch base.
- **[Risk] A set token with zero members is indistinguishable from a legacy inert row by reach alone** — both authorize nothing. → **Mitigation:** they are distinguished by _shape_, not heuristically: `scope = 'projects'` with `project_id IS NULL` versus `scope = 'project:<non-id>'`. The dashboard renders them as different states, because `inert` carries the "never repair" contract of `auth/spec.md:268` while an empty set is repairable by the operator. Spec'd in the `dashboard` delta.
- **[Trade-off] read-shared/write-own is not expressible in v1.** → **Accepted because** the ALTER path is measured and rebuild-free (D5), so the capability is deferred rather than designed out, and the alternative (per-project verbs now) replaces `dashboard/spec.md:189`'s composition rule instead of extending it.
- **[Trade-off] `auth/spec.md:41`'s closed enumeration must be amended.** → **Accepted because** the alternative (option 1b) avoids the amendment at the price of a project column that under-reports reach — the defect class `2026-08-03-mint-the-token-the-operator-asked-for` existed to remove (D3).
- **[Trade-off] `pinnedProjectId`'s name outlives its docstring's truth.** "The single project a token is pinned to" stays accurate for the two single-project arms and returns the correct `null` for the set arm. → **Accepted because** renaming it churns every call site to say the same thing; the docstring is corrected instead.
- **[Trade-off] A new CSS selector is needed for checkboxes in the form scope.** `input[type='checkbox']` is styled only under `.filters .group` (`styles/core/patterns.css:253-269`); `<select multiple>` would inherit `.main select`'s `appearance: none` + arrow art (`styles/core/content.css:260-272`), cosmetically wrong for a listbox. → **Accepted because** the new selector reuses existing tokens (`--lime`, `--fg-faint`) and adds none, so `dashboard/spec.md:565-572`'s locked `:root` set is untouched and `:210`'s "introduces no new design tokens" stays true.

## Migration Plan

1. **Deploy** is a single additive migration: `CREATE TABLE token_projects (…) WITHOUT ROWID`. No `tokens` rebuild, so no `DROP TABLE` on an FK parent and no reliance on the runner's `foreign_keys = OFF` envelope (`persistence/spec.md:587`) beyond its standard operation. The runner needs no pragma from the author.
2. **First boot after upgrade:** the table is created empty. Every pre-existing token keeps its scope string, and with an empty membership set the union is measured byte-identical over all 40 cells (D6). Legacy inert rows are untouched — `auth/spec.md:279-283`'s "every column of that row SHALL be byte-for-byte unchanged" continues to hold, since nothing writes to `tokens`.
3. **Derived data:** none invalidated. `memory_fts`, `memory_vec` and the three entity tables are functions of `memory`, and no memory row is touched. No reindex, no backfill, no sweep.
4. **Backfill:** none. There is no set token until an operator mints one.
5. **Rollback:** the older binary ignores `token_projects` (SQLite tolerates the extra table; `schema-drift` is a test, not a boot gate). Pre-existing tokens are unaffected. **Tokens minted with the `projects` arm authorize nothing on the older binary** — fail-closed, and documented in the release note per D-risk above.
6. **Verification order:** `schema-drift.test.ts:377` reds first (proving the table exists), then `EXPECTED_TABLES` is updated in the same commit, then the before/after authorization matrix is diffed cell by cell against the committed baseline.

## Open Questions

**OQ1 — Option 1 vs option 1b (D3).** Recorded as option 1 (new `projects` literal, honest reporting, one enumeration amendment). Option 1b (keep `project:<primary>`, extras in the join table) needs no `auth/spec.md:41` amendment but leaves the dashboard `project` column and `pinnedProjectId` under-reporting reach. **This is the decision an owner is most likely to overturn**, and overturning it is bounded: the join table, union rule, repository and test plan are identical either way.

**OQ2 — Does `auth/spec.md:69` cover "which projects"? (D7).** The sentence enumerates only `revoked_at` / `expires_at`. Recorded reading: the project set **is** authorization state and must be re-read per request. An owner reading `:69` as an exhaustive list could permit caching the set — which would make "narrow this token" weaker than "revoke this token". If the owner takes that reading, `:69` should be amended to say so explicitly rather than left ambiguous.

**OQ3 — One verb now, or per-project verbs now? (D5).** Recorded as one verb, with the rebuild-free `ADD COLUMN access` path measured. The deferred capability (read-shared/write-own) is real and not otherwise expressible given one token slot per install.

**OQ4 — May a set token autocreate a project? (D9).** Recorded as **no**, which is what the current gate already does. An owner might prefer "yes, and the new project joins the set", which would be a new write on the authorization surface from an MCP tool — a materially larger decision than it looks.

**OQ5 — Multi-project OAuth (D10).** Recorded as a non-goal on the grounds that RFC 8707 `resource` is one URL. If it is ever wanted, the question is whether `resource` may repeat, not whether the grant table can hold a set.

**OQ6 — The pre-existing `dashboard/spec.md:710` vacuity.** That scenario describes "a dashboard session with `scope = 'project:<id>'`", which cannot exist because login requires `*` (`dashboard-router.ts:156`; measured: 401). It is vacuous **today**, independently of this change. Deliberately not folded in: it is an unrelated reconciliation and mixing it into an authorization change would make the diff harder to review. Flagged for a separate change.
