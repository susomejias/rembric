# Design — retire the global scope

## Context

`proposal.md` carries the motivation and the measurements. This document records the decisions by number (D1–D24, plus D2a, cited from `tasks.md`), the arithmetic that has to come out right, and the questions deliberately left for the owner.

**The migration's cost at production scale is measured in `measurements/scale.md`** — four magnitudes (1k / 10k / 50k / 200k previously-global rows) against a corpus ~91% global, which is what an operator who only ever used path-less `/mcp` has. Three instruments, named per table, with the reproduction commands and the raw JSON of all 68 runs. D4, D15, D23 and D24 below carry its figures; nothing here is extrapolated except the three interpolated thresholds D23 labels as such.

The shape of the change is easy to state and easy to get wrong. `global` stops existing as a scope; former global rows move to a **default project** — an ordinary `projects` row with a collision-proof slug plus one boolean marking it the system default. Every scope becomes closed. The only special thing about the default project is that a path-less `/mcp` connection resolves to it.

**Three constraints bound every decision below.**

1. **The dense index cannot be re-partitioned in place.** sqlite-vec rejects `UPDATE memory_vec SET partition_key = …` with _"UPDATE on partition key columns are not supported yet."_ Control: an `UPDATE` of a different column on the same row succeeds. Everything about the migration's shape follows from this.
2. **An old binary must survive a rollback onto the migrated database.** `docs/updates.md:70` states the DB is deliberately not restored on rollback, so the previous image WILL boot against a forward-migrated file. That is why `memory.scope` stays in release N (D5).
3. **The MCP surface is already governed by two requirements this change could easily violate.** `openspec/specs/mcp-api/spec.md:2654` requires the description, the declared `outputSchema` and the payload to agree, with a duty to state which of three remedies a change applies (`:2664`). `:2619` forbids an error message naming a remedy its addressee cannot perform. Roughly twenty statements on the shipped surface become false in this change; each has to be enumerated and fixed, not left to be found later (D9).

## Goals / Non-Goals

**Goals**

- One kind of scope, closed. No argument, code path or spec sentence widens a read past the scope it resolved.
- Former global rows remain reachable — by a slug an operator can open — with the dense branch still returning them.
- The `includeGlobal` construction invariant (#304) is **retired**, because the value it guards no longer exists.
- Every false promise about global on the MCP surface, in the docs and on the dashboard is corrected in this release, and a `tools/list` test makes the class non-recurrable.
- Two silent regressions the change itself causes — the lazy sweep and `purgeEmpty` — are fixed here, not filed.
- The committed retrieval floor is met without being lowered.

**Non-Goals**

- `all_projects` — the eval cannot detect over-widening (see Risks, and `tasks.md` 16.6).
- Multi-project tokens — sibling change `grant-tokens-multiple-projects`.
- Dropping `memory.scope`, the five scope-bearing indexes, `scopeWhere`'s branch or `GLOBAL_PARTITION_KEY` — release N+1 (D5, D20).
- Repairing `projects/spec.md:70`'s pre-existing falsehood (D18).
- Making `is_default` transferable to another project (open question 4).

## Decisions

### D1 — The default project is an ordinary project plus one boolean column

`projects` gains `is_default INTEGER NOT NULL DEFAULT 0`. The ONLY behaviour attached to it is: a path-less `/mcp` connection whose scope would otherwise be unresolved resolves to the row where `is_default = 1`. Nothing else in the system special-cases it — it is listed by `project.list`, activated by `project.use`, swept by consolidation, filtered by the dashboard, and authorized against exactly like any other project.

**Alternative considered: a `settings` table row holding the default project's id.** Rejected. `resolveEffectiveScope` already reads `projects`, so a column answers in the same read; a settings row adds a second table, a second read on the hottest scope-resolution path, and a referential-integrity question (a settings row can name a deleted project; a column cannot).

**Alternative considered: infer the default from a reserved slug** (`default`, or a `__default__` sentinel). Rejected on measurement: the reserved value can already be taken. In a fixture with `default`/`demo`/`global`/`user` occupied the migration picked `default-2`; with `default`, `global`, `personal`, `default-2`, `default-3`, `demo`, `user` occupied it picked `default-4`. A reserved slug would either collide on a real installation or force a rename of an operator's existing project — and the slug is the cross-machine identity of a project (`db/schema/projects.ts:4-7`), so renaming it is not available.

**Alternative considered: `project_id IS NULL` means "the default project"** — i.e. keep the null axis and reinterpret it. Rejected: it keeps every `IS NULL` branch alive under a new name, so `scopeWhere`, `partitionKeyFor` and the `COALESCE(project_id, '')` UNIQUE index all survive, and the change delivers a rename rather than a retirement.

### D2 — The migration ALWAYS creates a new project row for the default, and MUST NEVER adopt, reuse or re-designate an existing one — not even a project whose slug is already `default`

This is the load-bearing choice in the whole migration, and it is a **data-integrity** requirement rather than a naming preference. It also settles the explorer's open question "is the default project newly created, or an existing project designated?" — always newly created.

**Why adopting an existing project is not an option.** If the migration found `default` taken and marked that row `is_default`, it would repoint every ex-global row **into a project the user created and populated**. Two distinct populations merge, and — because append-only means the rows stay while their `project_id` no longer records which population they came from — **the merge is irreversible in practice**. There is no column left that separates "this was a user-wide memory" from "this was always a `default` project memory", so no later change can unpick it. That alone disqualifies adoption; the collision argument below is the second reason, not the first.

**Adoption would also re-admit two collision classes that are impossible ONLY when the destination is brand new.** Both were measured impossible-by-construction on that condition, and the condition is exactly what adoption removes:

- `memory_topic_key_active_uidx` = `UNIQUE (scope, COALESCE(project_id, ''), topic_key) WHERE status = 'active' AND topic_key IS NOT NULL` (`apps/server/src/test/schema-drift.test.ts:172-173`). Repointing changes a row's key from `('global', '', K)` to `('project', <defaultId>, K)`. A brand-new project holds no rows, so no key can already be occupied — and the index already prevented two active global rows sharing a `topic_key`, so uniqueness within the migrated set is preserved too. Adopt a populated project and any `topic_key` it shares with a global row is a live UNIQUE violation, on real data, at boot.
- `memory_entities_identity_idx` = `UNIQUE (scope, project_id, kind, value)` (`:111-112`). Same argument. It is also the entire reason in-place entity migration is even discussable (D15) — under adoption it would not be.

**The slug is therefore chosen by `SELECT`-then-choose at migration time, never guessed, and a collision is not cosmetic.** `projects.slug` carries a UNIQUE index — `apps/server/src/db/schema/projects.ts:26`:

> `slugUnique: uniqueIndex('projects_slug_unique').on(table.slug),`

so a guessed slug that is already taken makes the `INSERT` fail, which aborts the migration inside `BEGIN IMMEDIATE`, which means **the server does not boot**. The picker probes `projects.slug` and takes the first free value in `default`, `default-2`, `default-3`, … Measured: with `default`/`demo`/`global`/`user` occupied it chose **`default-2`**; with `default`, `global`, `personal`, `default-2`, `default-3`, `demo`, `user` occupied it chose **`default-4`**. In both runs: no UNIQUE failure, exactly one `is_default`, no duplicate slugs, and no existing project renamed or re-designated.

**Alternative considered: adopt a project whose slug is already `default`, on the reasoning that the operator evidently meant it as their catch-all.** Rejected **on integrity grounds, not on cost** — it is cheaper than creating a row, and it is still wrong. The operator's `default` project is a population with its own history; merging the ex-global corpus into it destroys the distinction irrecoverably and turns two proved-impossible collisions into live ones.

**Consequence recorded so it is not mistaken for an oversight:** on an installation with zero global rows the migration still creates the project. That is correct. It is what a path-less `/mcp` resolves to on a brand-new install, and the alternative (create lazily on first path-less connection) would put a write on a read path and reintroduce an unresolved-scope state to specify.

### D2a — The operator distinguishes the system default from a same-named project by the `default` pill, and the boolean is the identity

D2 means an operator who already owns a project called `default` ends up with **two** rows on `/dashboard/projects` — theirs (`default`) and the system's (`default-2`). Guessing which one path-less `/mcp` resolves to is exactly the kind of ambiguity this change exists to remove, so the distinction has to be carried on a surface, named here:

- **`/dashboard/projects` renders a `default` pill on the row holding `is_default = 1`, and on no other row.** This is the authoritative signal, because **the boolean is the identity — the slug is not**. The slug cannot even move: `ProjectsService.rename` writes only `display_name` and there is no `updateSlug` anywhere in the tree (D3), so a slug that reads `default` is no evidence about which project is the default.
- **`display_name` says so too**, set at creation to a legible value naming its role. Advisory rather than authoritative, because an operator may rename it.
- **`project.current` names the resolved slug on the agent surface** (`mcp-api` delta), which is the same question asked from the other side.

The pill is asserted by test, not merely rendered, so a future template change cannot quietly drop the one signal that disambiguates two similarly-named projects.

### D3 — The slug is picked by a `SELECT` loop; `display_name` is set, `slug` is never changed afterwards

Body picks the first free slug in the sequence `default`, `default-2`, `default-3`, … by probing `projects.slug`. Measured outcomes are in D2.

The slug is then **immutable**, and this is a measured property of the code rather than a policy: `ProjectsService.rename` writes only `display_name`, there is no `updateSlug` anywhere in the tree, and after a rename the row keeps `slug = 'alpha'` while `/mcp/renamed-alpha` returns `project_not_found`. **So the identity to protect against operator action is the `is_default` boolean, not the slug** — which is what D18 guards.

`display_name` is set to something legible (`Default`) so the dashboard and `project.list` do not show a bare `default-4`.

### D4 — `memory_vec` is repointed by DELETE + re-INSERT, never `UPDATE`, and it gets its own test and its own mutation check

Forced by constraint 1. The blob is carried across unchanged, verified byte-identical two ways: `Buffer.compare(before, after) === 0`, and `vec_distance_cosine(after, before) = 0`.

**This is the highest-consequence detail in the change, because forgetting it fails silently and permanently.** The failure chain, each link measured:

1. `findMissingEmbeddings` (`db/repositories/vectors-repository.ts:154-165`) is `LEFT JOIN memory_vec v ON v.memory_id = m.id WHERE v.memory_id IS NULL`. It detects **absence** of a row, not a **wrong partition**. A stale-partition row is present, so it is never queued.
2. `memory.doctor` therefore reports an embeddings backlog of **zero** — the operator's only health signal says the index is complete.
3. `knnByQueryVector` filters `AND partition_key = ?`, so the row is invisible to the dense branch **forever**.
4. FTS still returns it, so `memory.search` returns _something_ for most queries. There is no error, no empty result, and no counter that moves.

A defect with no observable symptom and no self-healing path is the one kind that must be pinned by a test that fails without the fix. Task 2.2 asserts the **variant-agnostic** property — **no vector may sit at a partition key that is not a live project id** — rather than a `partition_key = '__global__'` count of zero. The count is only equivalent to the property under the shape this design happens to ship: it is false under variant E (rejected below), where the ex-global vectors legitimately stay at `__global__`, so an assertion written that way pins the shape instead of the invariant. Beside it, `count(*) FROM memory_vec > 0` is the non-vacuity control — a comparison over an empty table proves nothing (`CLAUDE.md`) — plus a dense kNN in the default partition returning > 0. Task 12.1 deletes the vec loop and requires both to go red.

**The blob survives at scale, measured rather than argued:** 4 032 sampled ex-global vectors across 68 runs at four magnitudes came back **4 032 byte-identical, 4 032 at `vec_distance_cosine = 0`, and 4 032 in the new partition**, with zero assertion failures in any shape (`measurements/scale.md` §9). Samples are taken by stride across the whole `memory_id` order, not the first 64.

**Alternative considered: delete the ex-global vec rows and let the backfill re-embed them.** Rejected, though it is simpler. It burns model inference on every migrated row at first boot (the exact moment an operator is watching an upgrade), and it makes the migration's correctness depend on a background worker completing — so a crash between the DELETE and the backfill leaves the rows lexical-only with no marker. Carrying the blob is deterministic and needs nothing after `COMMIT`.

**Four shapes were measured, not two assumed, and the two this design leaves open differ on DISK rather than on speed.** I1 BODY-ISOLATED, median of 3–4 reps (`measurements/scale.md` §3, §5, §6):

| shape                                     | body at 200k |     ÷ set | WAL high-water |   file growth |
| ----------------------------------------- | -----------: | --------: | -------------: | ------------: |
| **A** — per-row `DELETE` then `INSERT`    |      232.4 s |      1.19 |        1473 MB |  +155 MB (7%) |
| **B** — stash, one `DELETE`, one `INSERT` |      195.6 s |      1.00 |        2267 MB | +943 MB (40%) |
| D — full vtable rebuild                   |      196.7 s |      1.01 |        2413 MB |      +1022 MB |
| E — default project id is `__global__`    |       33.7 s | **0.172** |         789 MB |        +85 MB |

**The obvious batched rewrite is refuted as an optimisation.** B beats A by only **1.19× at 200k**, by **0.97× at 50k**, and is **slower than the per-row loop at 1k and 10k** — while costing +788 MB more file growth and +794 MB more WAL. So **the choice between A and B is a disk decision, not a speed decision**, and it is left to the owner (open question 6). D lands within 1% of B and buys nothing.

Two facts about the shapes are invisible from the migration text and decide implementability rather than cost:

- **A cannot be written as a migration file at all.** The runner reads `.sql` and splits on the statement-breakpoint marker, so a per-row loop needs a change to `db/migrate.ts`. Its naive form also materialises every ex-global row in JS first — measured **36.5 s and ~600 MB of Buffers** at 200k — and a `.iterate()` cursor is unavailable because the loop writes to the table it is reading.
- **Re-`INSERT` at the new partition BEFORE the `DELETE`, with no stash table, does not work.** Measured, not reasoned: `SqliteError: UNIQUE constraint failed on memory_vec primary key`. `memory_id` is unique across partitions, so the row cannot exist at two partition keys even transiently. **The stash table is therefore unavoidable in any DELETE-based shape** — this is the one detail whose omission turns a correct design into a migration that aborts at boot.

**Alternative measured and REJECTED on security, not on cost: variant E — give the default project the literal id `__global__`.** `partitionKeyFor` already writes that string for every ex-global vector, so `memory_vec` would need **no statement at all**: **33.7 s instead of 195.6 s, 5.8× faster**, with a 789 MB WAL instead of 2 267 MB. It is the only lever that materially changes the number, and it is rejected anyway.

Rejected because it **breaks the property D5 states as measured**, and that was verified rather than argued (`scale-rollback.mjs`, replaying the old binary's own query shapes from `vectors-repository.ts:113-131` and `:80-92` against both migrated databases):

| old binary's read, after migration                           |     shipped shape (B) |                            variant E |
| ------------------------------------------------------------ | --------------------: | -----------------------------------: |
| sparse global read (`WHERE scope = 'global'`)                |                     0 |                                    0 |
| dense global read (`partition_key = '__global__'`)           | **0** — reproduces D5 |                          **10 rows** |
| those rows hydrated through `knnCandidates`' scope-less join |                     — | **10 rows, all `scope = 'project'`** |
| control: dense read in the default project's partition       |                    10 |                                   10 |

So under variant E a rolled-back image's dense global branch returns the ex-global vectors and hydrates them through a join carrying no scope predicate — **a cross-scope leak on the rollback path, in exactly the code D5 measured to be silent**. Both controls in that table passed, so the 0 is a real 0 and the 10 is a real 10. Variant E also makes `GLOBAL_PARTITION_KEY` _data_ rather than _code_, which is precisely what release N+1 wants to delete (D5, D20). Recorded with its number attached so the 5.8× is not rediscovered later and taken as free.

### D5 — Expand/contract: release N keeps `memory.scope`, present and written as `'project'`

Measured against the migrated database with the old binary's query shapes: the old global read returns **0** where it returned 12; the default-project read returns **12**; the old dense read on `__global__` returns **0**; `SELECT memory.scope` still resolves; Drizzle's explicit column lists make `is_default` invisible to the old binary. No rows lost, no crash.

That last point is why the column stays: **an old binary that finds `memory.scope` missing fails on every query, not just the global ones**, because `scope` appears in five index definitions and in every scoped read's WHERE clause. Dropping it in the same release turns a survivable rollback into a dead server.

Dropping it is also not free, which is the other half of the reason to split: `ALTER TABLE memory DROP COLUMN scope` with the indexes present is **REJECTED** — _"error in index memory_topic_key_active_idx after drop column: no such column: scope"_. Drop the five scope-bearing indexes first, then `DROP COLUMN` → **ACCEPTED**, rowids preserved, `memory_fts` 38 → 38, `memory_fts_vocab` 281 → 281, `integrity_check` ok.

**Prefer that over a table rebuild in N+1**, on a measured hazard: a rebuild without an explicit rowid moved rowids 4..51 to 1..48 and FTS hits went **12 → 10**. And note the instrument that lies about it: `memory_fts.content <> memory.content` returns 0 in BOTH arms, because `memory_fts` is external-content and reads `content` back out of `memory` by rowid. The honest instrument is the **hit count**.

Release N is fully functional with a vestigial column. See D20 for whether N+1 is scheduled.

### D6 — `include_global` is deleted outright, not deprecated-then-removed

With one kind of scope there is nothing to widen into, so an inert argument would be a published input property whose only reachable behaviour is "no effect" — precisely the unreachable-state claim `mcp-api/spec.md:2660` forbids. The MCP surface also has no deprecation mechanism (no version negotiation, no capability flag), so "deprecated" is a note the model may never read while the false promise ships another release. Same reasoning `archive/2026-08-04-stop-promising-a-clamp-that-never-happens` D10 applied to `clamped`.

**What goes with it**, so the deletion is complete rather than cosmetic: the input property and its `describe()` (`memory-tools.ts:163-168`), its mention inside the `entity` describe (`:150`), `SearchMemoriesInput`, `HybridSearchOpts`, three repository option bags, `resolveIncludeGlobal`, the `scopeWhere` widening arm (in N+1 — the branch survives as dead code until the `Scope` union collapses), and **the entire #304 construction invariant** (D7).

### D7 — This change RETIRES a guard rather than adding one, and that is stated plainly

`apps/server/src/test/invariants.test.ts:493-568` — three assertions added on 2026-08-02 to close #304 — exists solely to keep `includeGlobal` constructible in exactly one production file. Its own preamble (`:495-498`) names the reason it was needed: the boolean "travels BESIDE `Scope`… so no layer that carries it can tell whether anyone was authorized to set it."

Deleting the value deletes the need. Recorded explicitly because "a change that removes a CI invariant" looks like a regression at review time and needs its justification in writing, not in a commit message.

**Two of its assertions are self-guarding** (`expect(inDecider.length).toBeGreaterThan(0)`), so they fail loudly once the decider is gone rather than passing vacuously over an empty set. That is what forces the removal instead of leaving a green-but-meaningless test behind — and it is worth contrasting with `runtime-invariants.test.ts:108`, which is already near-vacuous for want of the same protection (D14, task 12.4).

### D8 — `memory.save`'s `scope` argument is deleted, and the mitigation is named

Measured: `scope` is an input property on exactly ONE tool, `enum ['global','project']`, `.default('project')`.

Owner's reasoning, recorded as given: with one kind of scope the argument carries no information, so leaving it leaves something dangling.

**The mitigation that makes this safe rather than merely tidy**, and the sentence to keep when someone asks whether removing an argument loses control: without the argument, **the destination is determined by the connection URL the operator configured**, so an agent cannot misdirect a write by omitting an argument. Today it can — and does: on `/mcp` with no `.rembric`, `memory.save` with `scope` omitted fails with `project_required` (measured), and the message's own remedy (c) invites the agent to file the memory somewhere nothing will look for it.

After the change that call **succeeds**, into the default project. Task 10 pins it red-before / green-after, because it is the one user-visible improvement the change delivers on the happy path.

### D9 — Every false statement is enumerated and fixed in this release, under the requirement that demands it

`mcp-api/spec.md:2654` requires description / `outputSchema` / payload agreement; `:2664` requires a change to state which of three remedies it applies; `:2619` forbids naming a remedy the addressee cannot perform. This change would otherwise violate them about twenty times. The remedy applied throughout is **remove the field or claim**, except where noted.

**MCP surface** (`apps/server/src/mcp/`):

| Site                             | Verbatim, and what breaks                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instructions.ts:33`             | `"This connection is path-scoped to '<slug>': scope='global' is rejected and include_global is inert. User-wide memory is not reachable here."` — all three clauses become false.                                                                                                                                   |
| `memory-tools.ts:163-168`        | the `include_global` property and its `describe()` — deleted (D6).                                                                                                                                                                                                                                                  |
| `memory-tools.ts:150`            | `"Narrows further with status, type, tag, topic_key and include_global (which is gated — see its own description)"` inside the `entity` describe — names a deleted property.                                                                                                                                        |
| `memory-tools.ts:794-801`        | the whole `scope_locked` branch, including `"ask your operator to add a path-less '/mcp' entry for user-wide memory"`. `mcp-api/spec.md:2625` normatively governs this exact message; `:2619` forbids naming an unreachable remedy. Retired with the argument that triggers it.                                     |
| `memory-tools.ts:829-835`        | `project_required`'s remedy `"or (c) set scope='global' to save as a user-wide memory instead"`. On a path-less connection the error becomes unreachable; the message survives for the unresolvable-slug path and must name no scope.                                                                               |
| `suggestionPendingMessage()`     | retired with the gate (D12).                                                                                                                                                                                                                                                                                        |
| `server.ts:127`                  | `memory.save`'s tail: `"Path-scoped connections (/mcp/<slug>) reject scope=global with code \"scope_locked\"; on /mcp the agent picks scope (project-scope requires either path-scoping or a prior project.use call)."` — the **tail** is the first text a truncating client loses (`mcp-api/spec.md:479`, `:505`). |
| `server.ts:130`                  | `memory.search`: `"Path-scoped connections see only that project; unscoped see globals only."` — **1874/1900, 26 characters of headroom**. See D10.                                                                                                                                                                 |
| `server.ts:378`                  | `memory.doctor`: `"SERVER-WIDE (all projects + global)"`.                                                                                                                                                                                                                                                           |
| `server.ts:400`                  | `memory.stats`: `"all scoped to the active project (or global)"`.                                                                                                                                                                                                                                                   |
| `_shared.ts:113`                 | `projectPinRemedy`'s guard — **retargeted, not deleted** (D11).                                                                                                                                                                                                                                                     |
| `project-tools.ts:232`           | `project.current` authorizes against `SCOPE_GLOBAL` when nothing is active — retargeted (D17).                                                                                                                                                                                                                      |
| `project-suggestion-gate.ts:6-8` | `"protects against the silent fallback to scope='global'"` — **wrong today** (D13).                                                                                                                                                                                                                                 |

**Docs:** `docs/agents.md:18` (`/mcp` → global scope), `:19` (`scope=global` rejection), `:29`, `:30` (the token table's "or to global" columns), `:57` ("omit for global"), `:128` ("operates in global scope"), `:372` (**wrong today** — D13), `:385` ("**Stay global**: re-issue passing `scope: 'global'` explicitly"). `docs/troubleshooting.md:118` ("`/mcp` connections see only global"), `:124` (the whole `scope_locked` section). `README.md:269` ("or global scope for a path-less `/mcp` grant"), `:412` ("every memory is `global` or attached to one `project_id`").

**Dashboard:** `components.ts:581` and `sessions.ts:191` (the `__global__` / `global only` filter option), `templates.ts:518-520` (`scopePill`) and its three call sites (`sessions.ts:115`, `memories.ts:207`, `:531` — measured: `git grep -n scopePill` returns exactly the definition plus those three), `sessions.ts:390` (`'— (global)'`), `entities.ts:105` (the `'global'` row label), `server/dashboard-router.ts:477-479` (the consolidation last-run scope label — see D16).

**Not corrected, deliberately:** `docs/troubleshooting.md:128`'s `project_not_found` section, which says the path-scoped-to-a-missing-slug case is "**not** silently treated as a user-wide connection". That statement stays TRUE and stays useful — the unresolvable-slug path is unchanged by this design.

### D10 — `memory.search`'s description has 26 characters of headroom, so the reclaimed clause is named here

`mcp-api/spec.md:479` requires that where a content obligation does not fit, "text SHALL be reclaimed from clauses no requirement mandates, and the reclaimed clause SHALL be named in the change that removes it — not appended past the cap, and not paid for by raising the cap."

Measured from the constant at `apps/server/src/mcp/server.ts:130`: **length 1874, headroom 26** against `DESCRIPTION_MAX_LENGTH = 1900`.

The false sentence is `" Path-scoped connections see only that project; unscoped see globals only."` — **74** characters including the leading space, confirmed present in the shipped string. The true replacement is shorter, so this is a net **reclaim**, not a spend: `" Every connection sees exactly one project's memories."` — **54**. Net **−20**, landing at **1854/1900 with 46 of headroom**.

That is the reclaimed clause `mcp-api/spec.md:479` requires a change to name, and it is the only reclaim needed: `memory.save` (`server.ts:127`) deletes its 213-character tail and adds nothing mandated, and `memory.doctor` (`:378`) and `memory.stats` (`:400`) each shorten by a parenthetical.

**Every figure above is measured from the description CONSTANT and MUST be re-measured from a real `tools/list` response** before the change lands — the boundary `mcp-api/spec.md:505` mandates and `mcp-integration.test.ts` asserts over. A mismatch means the wording drifted; fix the wording, not the expectation.

### D11 — `projectPinRemedy` is retargeted at the default project, not deleted

`_shared.ts:113`'s first guard is `if (scope.kind !== 'global' || ctx.requestedSlug !== null) return ''`. Once `/mcp` resolves to a project, `scope.kind` is never `'global'`, so **the remedy silently stops being emitted** and the pinned-token `forbidden` error degrades to a bare ULID with no next step.

That is a regression against a requirement added two days ago — `mcp-api/spec.md:2626` ("The `forbidden` message returned when a token pinned to exactly one project is denied a global-scope action on a path-less connection SHALL name the way out") and its scenario at `:2641-2646`, from `archive/2026-08-02-tell-the-truth-about-unresolvable-scopes`. Deleting the helper would ship the exact defect that change closed.

Retargeted: the condition becomes "the resolved scope is a project this token is not pinned to, on a path-less connection". The message body is unchanged — it already names `project.use({slug})` and `/mcp/<slug>`, both of which stay reachable.

### D12 — The suggestion gate is retired because its precondition cannot hold, not because the policy changed

Measured: four call sites (`memory-tools.ts:818`, `session-tools.ts:137`, `prompt-tools.ts:108`, `observability-tools.ts:195`), all reducing to "no project is active", and `project-suggestion-gate.ts:33` (`if (entry?.projectId) return null;`) returns `null` as soon as a project is pinned. With `/mcp` always resolving to the default project, no path reaches a non-null return.

**Leaving it would be a fresh instance of the class `archive/2026-08-04-stop-promising-a-clamp-that-never-happens` closed** — a published error code, message and `suggestedSlugs[]` payload for a state the server can no longer produce. Per `mcp-api/spec.md:2664` the remedy applied is **remove the field or claim**, and this change states so.

**What is lost, stated rather than glossed.** The gate IS load-bearing today for the three non-`save` tools, which without it write global-scope rows silently. After the change:

- The **leak dimension disappears** — the destination is a closed project, not a shared user-wide partition. Nothing another project can read.
- Only **misfiling** remains, and it is observable and cheaply recoverable: `project.current` names the default project, and the corpus is append-only with `topic_key` supersede, so a misfiled memory is re-saved under the right project rather than edited or lost.

That trade is the whole argument for the change, so it belongs in the design rather than in a risk footnote.

### D13 — Two statements that are wrong TODAY are corrected, not carried forward

Both would otherwise be silently inherited into the new world with their falsehood intact.

- **`project-suggestion-gate.ts:6-8`**: _"Save-path / session-start gate that protects against the silent fallback to `scope='global'`"_. Measured false: `memory.save` has **never** silently fallen back, because `scope` defaults to `'project'` — with no roots capability it returns `project_required`, loudly. The gate's real function is the other three tools.
- **`docs/agents.md:372`**: _"write tools refuse to silently fall through to global"_. Same defect, in operator-facing documentation.

Correcting them is not optional politeness: the change's own justification is truthfulness about scope, and carrying a false docstring into the new design would make the retirement in D12 look like a policy reversal rather than the removal of an unreachable path.

### D14 — Both consolidation anchors move in this change, because the change breaks them

- **`consolidation/runner.ts:87-90`** sweeps `{scope:'global', projectId:null}` unconditionally, with the reason in the comment: _"global hygiene would otherwise starve — the HTTP session path is always project-scoped."_ Once the default project is an ordinary project it starves **exactly as global would have**, and the rows losing their lazy sweep are precisely the ones this migration moved. Re-anchored on the default project.
- **`runner.ts:103-104`** gates `purgeEmpty` on `runs.some((r) => r.scope.scope === 'global')`, which becomes **permanently false**. Empty-session purge would never run again, and **nothing would error** — no counter moves, no warning fires. Re-anchored on the same run as the sweep.

Neither is a follow-up. A change that leaves a purge silently dead is worse than one that never touched it.

**`runtime-invariants.test.ts:108` is already near-vacuous and gets fixed here too**, because this change is what makes it matter: its fixture creates consolidation ops in one scope only, so `keys.size <= 1` holds by construction. It wants a two-project fixture plus a non-empty-count assertion (task 12.4), on the standing rule that a test green on both sides of a mutation proves nothing.

### D15 — `memory_entities` is REBUILT, with in-place migration named as the option that is safe only under D2

`memory_entities` carries its own `scope` + `project_id` with `UNIQUE (scope, project_id, kind, value)`, and `memory_entity_links` holds FK references into it. Collapsing scope can collide in general.

**Recommendation: rebuild**, via the path already documented and supported — `docs/backup.md:42-44` has operators delete `entity-state.json` so the server wipes and re-derives the entity tables. That path exists, is tested, and needs no new SQL.

**The recommendation is now also the cheapest option by a measured margin, which it was not known to be when it was made.** `UPDATE memory_entities` is the **second-largest line item in the whole migration**: **17.5 s of the 195.6 s body at 200 000 global rows** (`measurements/scale.md` §3, I1 BODY-ISOLATED per-statement breakdown — the table has 2 051 891 entity rows at that magnitude). Taking the rebuild path removes that statement from the migration **entirely**, so 17.5 s of an operator's first boot goes with it and drains in the background instead, where a backlog is visible in `memory.doctor` rather than being time an operator stares at a silent process. Nothing else in the body except `memory_vec` (73%) is worth this much: `memory`, `sessions`, `prompts` and `consolidation_runs` together are **1.9 s** at 200k.

**In-place migration is nonetheless SAFE here**, and the reason is worth recording so a future reader does not think the recommendation was made out of caution: under D2 the default project is newly created, so its only entity rows are the ex-global ones, and collision is impossible **by construction**. Either is correct; rebuild is preferred because it needs no migration code and its failure mode (a temporary backlog) is visible in `memory.doctor`.

Task 13 requires the rebuild to **drain to zero** after the migration — `memory.doctor`'s `embeddings.backlog` and `entities.backlog` both 0, and `memory_entity_scan` count equal to `memory` count — because a rebuild that stalls is the same silent-absence failure as D4 in a different table.

### D16 — `global` stays visible on the operator surface, on purpose

`consolidation_runs.scope` is append-only text. Historical `'global'` rows survive the migration and keep rendering through `dashboard/consolidation.ts:42-46` and `server/dashboard-router.ts:477-479`. `openspec/specs/dashboard/spec.md:160` already permits this: _"Scope cells in the runs listing and the run detail SHALL render the project slug when the scope refers to an existing project, falling back to the raw scope string otherwise."_

So the journal will show `global` for pre-migration runs forever, and that is the correct outcome — the journal records what happened, and what happened was a global sweep. Stated here so a later reader does not file it as incomplete cleanup, and so the `dashboard` delta keeps `:160` rather than tightening it.

`dashboard-router.ts:477-479` still needs an edit: its `lastRun.scope === 'global' ? 'global' : …` branch will never be taken for a NEW run and should fall through to the same slug-or-raw label the listing uses, so one code path renders history rather than two.

### D17 — `project.current` authorizes against the default project, and a project-pinned token will get `forbidden` for a project it was never granted

`project-tools.ts:232` currently authorizes against `SCOPE_GLOBAL` when nothing is active: `assertAuthorized('read', activeProjectId ? projectScope(activeProjectId) : SCOPE_GLOBAL, deps)`. Post-change the fallback target is the default project.

**Consequence, recorded as deliberate:** a token scoped `project:<X>` connecting path-lessly will get `forbidden` from `project.current`, naming the **default project** — a project it was never granted. That reads oddly, and it is the right outcome: the connection genuinely resolved to a scope the token cannot read, which is the same answer it gets today (`forbidden` against global), with a more informative target. D11's retargeted remedy is what makes it actionable — the message names `project.use({slug})` and the token's own pinned slug.

**Alternative considered: exempt `project.current` from authorization** so a pinned token can always ask where it is. Rejected: it would make one tool answer questions about a scope the token cannot read, and `project.current` returns the active slug — which is information about that scope.

### D18 — Archiving the default project is forbidden at the service layer AND the form is suppressed

Measured: archiving produces **three different outcomes** depending on where the default is bound, and after this change there is no fallback target, so `resolveEffectiveScope` has no defined answer for a path-less connection whose default project is archived.

The guard belongs at the **service layer**, because `POST /dashboard/projects/<id>/archive` is reachable with a crafted request carrying a valid CSRF token — suppressing the button alone is not a guard. The form is suppressed **as well**, so the operator is not offered an action that will be refused.

**Rename needs no guard** (D3): the slug is provably immutable and `rename` writes only `display_name`. Renaming the default project's display name is a legitimate operator action and stays available.

**A pre-existing leak this makes load-bearing, named rather than fixed:** `session-tools.ts:148-163` checks `archivedAt` only inside `if (args.project !== undefined)`, so a session row lands in an archived project when the project arrives via the router instead of the argument (measured). It matters more after this change because the router is now the path every path-less connection takes. Recorded in task 15.3 for a separate reconciliation; it is a distinct defect with a distinct fix, and folding it in would mean this change also owns session-registration semantics.

### D19 — The `project_id IS NULL` axis in `sessions` and `prompts` is migrated in release N; NOT NULL is deferred

Measured: **0** such rows in the dev corpus, so the statement is a no-op there — but not on a real installation, where every path-less session ever registered has `project_id IS NULL` (`sessions/spec.md:189`: "When the session is registered through `/mcp` with no active project, `project_id` SHALL be null and the session is global-scope").

**Decision: they migrate, in the same body, to the default project.** The alternative — leaving them — means "global" survives in two tables after the change claims to have deleted it, and `dashboard/sessions.ts:115` keeps rendering a `GLOBAL` pill for a scope that no longer exists. That is the incoherence this change exists to remove.

**`NOT NULL` is deferred to N+1**, with the other table rebuilds, because flipping nullability on SQLite requires the rebuild dance (`CLAUDE.md`, "Table-rebuild migrations") and the rollback argument in D5 applies to it identically.

**`tokens.project_id IS NULL` STAYS**, and the distinction is substantive rather than an exception: a `*` token is **unbound**, not global-scoped (`auth/spec.md:259-262`), and the `CHECK` at `db/schema/tokens.ts:40` (`project_id IS NULL OR scope = 'project:' || project_id OR …`) depends on the null. Nothing about that axis is a scope.

### D20 — Release N+1 is SCHEDULED as the immediate follow-up, not optional

Release N is fully functional with a vestigial `memory.scope` column that every runtime path writes as `'project'`. If N+1 never ships, the change's own goal ("the wiring is gone") is only partly met, and three specific costs persist:

1. Five indexes and a UNIQUE index stay keyed on a dead column, pinned by `schema-drift.test.ts`, so every future index change carries it.
2. `Scope` stays a two-arm union whose second arm nothing constructs, so `scopeWhere`'s widening branch and `GLOBAL_PARTITION_KEY` stay as dead code that reads like live capability.
3. A column present and constant is exactly the kind of claim `mcp-api/spec.md:2660` calls out at the tool layer — a value that can hold one value forever carries no information.

**Decision: scheduled, as the next change after this one archives.** The timing is left open (open question 1) because it depends on one thing this change can measure but not decide: how long the rollback window needs to be, i.e. how many releases an operator may skip. What is NOT open is whether it ships.

### D21 — The two `cross-scope` eval queries are rewritten; the floor is not lowered

**The change fails CI without this**, and the arithmetic is thin enough to be worth writing down.

The mechanism first, because the tolerance is easy to misread. A committed floor is written as `measured − tolerance` (`floor-ratchet.ts:6,48`) with `FLOOR_TOLERANCE = 0.05` (`run-eval.ts:35`); the **gate then compares a new measured value against the committed floor itself**, not against the floor minus another tolerance. So the committed `recallAtK: 0.95` at k=8 (`apps/server/src/test/retrieval/baselines/hybrid.json`, `floors["8"]`) encodes a measured 1.0, and 0.95 is the hard pass line.

16 gold-bearing queries. `q-cross-scope-test-colocation` and `q-cross-scope-commit-convention` (`apps/server/src/test/retrieval/queries.ts:92-105`) each carry two gold ids — one global (`global-test-colocation`, `global-conventional-commits`) and one project-local — and each loses the global half. −1.0/16 = **−0.0625** → R@8 = **0.9375**, which is **0.0125 below the 0.95 pass line**: a deficit smaller than one query's own 0.0625 contribution, so the gate fails on less than a single query's worth of gold. The same value **passes at k=5**, whose committed floor is **0.91875** (0.9375 > 0.91875) — which is why this is specifically a k=8 failure and why running the eval only at k=5 would hide it.

`ratchetFloors` will not silently absorb it: lowering requires `--lower-floors` and prints the lowering (`floor-ratchet.ts:52-61`), and without the flag the floor is held with a printed note. So the failure is loud, which is the good case.

**Rewrite, not lower.** Both queries test something real (a convention stated once and instantiated per project), and after the change that shape still exists — both memories live in the same project, or the convention lives in the default project and the instance in another. The queries are re-pointed at gold that exists post-migration, and the `cross-scope` query **type** loses its meaning and is renamed. Task 8 requires `git status` clean under `test/retrieval/` afterwards and the pass line R@8 ≥ 0.95.

**Alternative considered: lower the floor to 0.9375 with `--lower-floors`.** Rejected. It records a real retrieval regression as the new normal, when the regression is an artefact of two fixtures describing a world that no longer exists.

### D22 — The delta covers the requirements whose CONTRACT changes; fifteen further requirements carry an incidental false clause and are enumerated for the apply phase rather than transcribed here

Twelve capabilities receive delta files, covering every requirement whose normative contract this change alters — path-scoping, scope resolution, the two deleted arguments, the retired gate, the generalised GHSA requirement, the default project, the migration, the two consolidation anchors, the entity scope, the session scope, the eval fixtures, the HTTP response enum, the OAuth binding, and the operator filters.

A further **fifteen** published requirements contain a false `global` clause inside an otherwise-unaffected requirement. They were found by extracting every `### Requirement:` block in `openspec/specs/` and reporting those that mention `global` and are not already covered, then reading each hit to separate genuine falsehoods from uses of the word in another sense. The enumeration is in `tasks.md` §9.3 with the line of each false clause.

**They are enumerated rather than transcribed, deliberately, and the reason is a measured failure mode of this repo's own tooling.** `openspec archive` merges a MODIFIED block by REPLACING the whole requirement, and `scripts/check-delta-freshness.mjs` reports a changed body line as an **advisory, not a failure** (`:112`) — so a hand-transcription slip inside a 100-line block silently reverts whatever another change published. That script's own header records this happening "three times in one day". Producing fifteen more hand-copied blocks in one sitting, to change one clause in each, maximises exactly that risk while adding no decision content: every one of the fifteen is the same mechanical edit under a rule already stated in the delta.

**The gate is therefore a completeness check rather than an author's diligence.** `tasks.md` §9.4 requires `grep` over `openspec/specs/` to return only an enumerated residue of genuine non-scope uses of the word, `pnpm run check:delta-freshness` to pass, and `openspec validate --strict` to pass — and it names the residue in advance so a missed requirement is visible as a count mismatch rather than as prose nobody re-read.

**The false positives are named here so they are not "fixed" into nonsense.** Measured, these use the word in an unrelated sense and stay verbatim: `openspec/specs/dashboard/spec.md:322,858` (the shared `#rbr-confirm` **dialog** is "global" in the DOM sense), `data-access/spec.md:160` ("index-global read", a measurement), `development-environment/spec.md:573` ("no pnpm globally installed"), `consolidation/spec.md:117` ("the prior single global threshold", a config value), `memory/spec.md:257` ("globally complete", about a rank window), `memory-entities/spec.md:510` ("global-sensemaking query class"), `persistence/spec.md:248` ("Global uniqueness across all tokens"). `dashboard/spec.md:242`'s scenario TITLE ("No project selection mints a global token") becomes misleading while its body stays true — the token is unbound, not global-scoped — and it is kept verbatim because a published scenario title cannot be renamed under `check-delta-freshness` (the D9 constraint recorded in `archive/2026-08-04-stop-promising-a-clamp-that-never-happens`).

### D23 — The migration emits progress output BEFORE and DURING the body; the boot banner is the wrong instrument and threading `migrate()`'s result into it does not discharge this

**The figure that decides this is 203 seconds.** Instrument I3 FULL-BOOT — the real `createDb()`, which is what an operator actually waits on — median of 3 reps, against a corpus ~91% global (`measurements/scale.md` §7):

| global rows | first boot after upgrade |     db size | what it looks like from outside       |
| ----------: | -----------------------: | ----------: | ------------------------------------- |
|       1 000 |                   0.35 s |       22 MB | indistinguishable from a normal boot  |
|      10 000 |                    1.6 s |      128 MB | a slightly slow boot                  |
|      50 000 |                   12.7 s |      597 MB | a container that has not answered yet |
|     200 000 |   **203 s (3 min 23 s)** | **2336 MB** | **indistinguishable from a hang**     |

**The migration body IS the boot**, confirmed from both sides: the three instruments agree to within a few percent from 10k up, and the control — the same fixtures booted with the migration removed — takes **12 / 16 / 71 / 4003 ms** (`scale-boot-control.mjs`; the 4 s at 200k is `createDb`'s `ANALYZE` over a 2.3 GB file, which an operator already pays today). Everything else `createDb` does is rounding error next to the body.

**Interpolated, and labelled as interpolation rather than measurement** — the exponent is 1.28 between 10k and 50k and 2.0 between 50k and 200k, so these carry real error bars: **5 s at ~24 000** global rows, **30 s at ~77 000**, **2 min at ~154 000**.

Where the 200k body goes, which is what says where the lines belong (I1 BODY-ISOLATED, set-based):

| statement group     |     at 200k |   share |
| ------------------- | ----------: | ------: |
| `memory_vec` group  | **142.7 s** | **73%** |
| `memory_entities`   |      17.5 s |    8.9% |
| `foreign_key_check` |      18.7 s |    9.6% |
| `COMMIT`            |      12.5 s |    6.4% |
| everything else     |       1.9 s |    1.0% |

**Two statements own 63% of the body**, so a single line before the `memory_vec` step is worth more than any breakdown printed afterwards. Two further facts bound how this can be read: both vec shapes are **roughly quadratic at the top of the measured range** (fitted exponent 1.99 → 2.10 set-based, 1.69 → 2.29 for the loop), so **extrapolating past 200 000 understates the cost** and no threshold above the largest measured magnitude is claimed here. And `foreign_key_check` **does** scale — 7.2 µs/row at 1k to **94 µs/row at 200k** — because it is the runner's pre-commit gate over the whole FK graph (`db/migrate.ts:97-107`), not over the diff. That 18.7 s is paid by **every future migration this repo ships** on a corpus this size, however trivial the migration; it is also why splitting this body across several files to "make each step smaller" would be a pessimisation, multiplying the gate by the number of files.

**There is no migration logging at all today**: `migrate()` returns `{applied, skipped}` and `db/client.ts:72` discards it, and `printBootstrapBanner` runs _after_ `createDb`. So on a 200k-global installation the process prints nothing for 3 minutes 23 seconds and then boots normally. **Three failure modes are reachable with nothing actually wrong**, in increasing order of severity:

1. **An operator cannot distinguish it from a hang** — which is the exact scenario `Ctrl-C` exists for.
2. **A container orchestrator may not wait.** A `docker compose` health check or a Kubernetes `startupProbe` with a default failure budget kills the container mid-body long before 203 s.
3. **A restart loop never completes, because the rollback is total.** The ledger row is written inside the transaction (`migrate.ts:108`), so a kill rolls the entire body back and boot 2 starts from scratch — measured (`measurements/scale.md` §8: SIGKILL mid-body leaves every counted total unchanged, no ledger row, `integrity_check` ok, and the retry completes). An operator who restarts every 60 s on a 200k corpus therefore **never finishes**, sees no message, and has no way to tell that each attempt is making no progress. Atomicity is what makes interruption safe; it is also what makes impatience unrecoverable.

**Why the banner alone is the wrong instrument, stated plainly because task 1.12 originally specified exactly that.** Threading `migrate()`'s `{applied, skipped}` into `printBootstrapBanner` is **after-the-fact reporting**: the banner prints when the wait is already over, so it addresses none of the three modes above — it cannot reassure the operator in mode 1, cannot reach an orchestrator that has already killed the process in mode 2, and in mode 3 is never printed at all, because the process dies before it. A summary of work that completed is the one thing that is guaranteed to be absent in every failure the silence causes. What the 203 s figure argues for is **output before and during**: a line naming the migration when it starts, and at minimum a line before the `memory_vec` step. Task 1.12 is rewritten accordingly, and 3.8 asserts the lines rather than the summary.

### D24 — The upgrade's disk requirement is part of the release note, because nothing currently tells the operator and the failure lands in D23's silent loop

`BEGIN IMMEDIATE` holds the write lock for the whole body, so nothing can be checkpointed until `COMMIT` and the WAL only grows. Measured for the set-based form (`measurements/scale.md` §5; WAL figures are the high-water mark stat-ed after `COMMIT` and before `close()`, exact because no checkpoint can run inside an open write transaction):

| global rows | db before | WAL high-water | db after body |         growth | freelist | after `VACUUM` | `VACUUM` |
| ----------: | --------: | -------------: | ------------: | -------------: | -------: | -------------: | -------: |
|       1 000 |     22 MB |          12 MB |         27 MB |   +5 MB (+23%) |     4 MB |          22 MB |    0.1 s |
|      10 000 |    128 MB |         119 MB |        177 MB |  +49 MB (+38%) |    40 MB |         131 MB |    0.3 s |
|      50 000 |    597 MB |         578 MB |        837 MB | +240 MB (+40%) |   198 MB |         606 MB |    2.3 s |
|     200 000 |   2336 MB |        2267 MB |       3278 MB | +943 MB (+40%) |   791 MB |        2360 MB |   20.3 s |

Two figures an operator needs and cannot get anywhere today:

- **Free space: roughly 1.4× the database size, transiently.** At 200k the body wants 2 267 MB of WAL plus 943 MB of growth on top of a 2 336 MB file — **≈5.5 GB of peak demand to migrate a 2.3 GB database**. Below about 1.4× the database free, the set-based form **fails mid-body**. That failure is safe (D23's §8 measurement: atomic, no half-moved rows, no ledger row) but it fails **into D23's silent boot loop**, so an operator near a full volume gets a server that never starts and says nothing about why. **A nearly-full disk is a worst case in its own right**, not a footnote to the row-count worst case.
- **The file stays ~40% larger until someone runs `VACUUM`.** The growth is fragmentation, not data: a 791 MB freelist at 200k, which `VACUUM` returns to 2 360 MB — 24 MB above the pre-migration size, which is the real cost of the new rows. `VACUUM` takes 20 s at that scale and itself needs the database's size again in free space. `/dashboard/maintenance` already exposes it, **so the remedy exists and nothing tells the operator they now want it** — which is the same defect shape as D23, one surface further out.

The two shapes left open in D4 differ sharply here, and this is the substance of open question 6: the per-row loop grows the file **+155 MB (+7%)** with a 1 473 MB WAL, against B's +943 MB and 2 267 MB, because it frees and reuses vec0 chunk pages as it goes instead of freeing 200k rows' worth and then allocating fresh ones. If the binding constraint is disk rather than time, the slower shape is the better one — the opposite of the usual conclusion.

Both figures go in the release note (task 15.1), in the operator's units: the upgrade needs free space roughly equal to the database size, and the file will be about 40% larger until a `VACUUM` from `/dashboard/maintenance`.

## Risks / Trade-offs

- [Risk] **The `memory_vec` repointing is forgotten or half-done, and nothing reports it** → Mitigation: D4's failure chain is measured link by link; task 2.2 asserts the variant-agnostic property (**no vector at a partition key that is not a live project id**) with a non-vacuity control beside it (`count(*) FROM memory_vec > 0`, because a comparison over an empty table proves nothing); task 2.4 exercises recall **end-to-end through `searchWithAbstention`**, not `knnByQueryVector` directly, with a control row native to the project that must also return; task 12.1 mutation-deletes the vec loop and requires red. Measured across 68 runs at four magnitudes: 4 032/4 032 blobs byte-identical and in the new partition.
- [Risk] **A second default project is created by a re-run** → Mitigation: idempotency is not free and the body must guard (`SELECT … WHERE is_default = 1`, `INSERT` only if absent). Task 3 runs the body twice and asserts exactly one `is_default` row and zero rows repointed on the second pass.
- [Risk] **A crash mid-migration leaves a half-repointed corpus** → Mitigation: measured — the DB is byte-identical in every counted dimension and the `_migrations` row is unwritten, because `migrate.ts:108` writes the ledger row inside the same transaction, so boot 2 retries. Task 4 injects the throw and asserts the census unchanged and the ledger row absent.
- [Risk] **A rollback leaves the operator with an apparently empty corpus** → Mitigation: measured to be survivable, not transparent (D5). Rows are visible under the default slug; the global partition reads empty. `docs/updates.md:70` already documents that the DB is not restored on rollback, so the release note must say this in one sentence rather than leaving an operator to discover it.
- [Risk] **The first boot is silent for 3 min 23 s at 200k global rows, and the operator or the orchestrator kills it** → Mitigation: D23 — progress output before and during the body (task 1.12, asserted by 3.8). Interruption itself is measured safe (atomic, no ledger row, retry completes), but the rollback is **total**, so a restart loop makes no progress and says nothing; the killed boot is the one case the boot banner can never report.
- [Risk] **The volume has too little free space and the migration fails mid-body** → Mitigation: D24 — the release note states the requirement (≈1.4× the database size free, ≈5.5 GB peak for a 2.3 GB file) and the ~40% residual growth with `VACUUM` from `/dashboard/maintenance` as the remedy. The failure is safe but lands in the silent boot loop above, so **an operator with a nearly-full disk is a worst case in its own right**, not a variant of the row-count one.
- [Risk] **The default project is archived and path-less connections have nowhere to resolve** → Mitigation: D18's service-layer guard plus form suppression, each mutation-checked separately (task 11).
- [Risk] **The entity rebuild stalls and nobody notices** → Mitigation: task 13 requires both `memory.doctor` backlogs to drain to **zero** and `memory_entity_scan` count to equal `memory` count. The same silent-absence shape as D4, in a table where `doctor` DOES report it.
- [Risk] **Removing `include_global` and `memory.save({scope})` breaks a consumer** → Mitigation: measured consumer set outside this repo is zero. `include_global` appears in 3 production files / 6 occurrences under `apps/server/src`; the plugin tree has **no** client that branches on scope (four prose references, one a false positive). Removal is announced in the descriptions' own text, the only channel an agent reads.
- [Trade-off] **The suggestion gate's misfiling protection is lost** → Accepted, with the dimensions separated (D12): the leak dimension disappears entirely; the misfiling dimension survives but is observable (`project.current`) and cheaply recoverable (append-only + `topic_key` supersede). A closed default project is a strictly better failure than a shared user-wide partition.
- [Trade-off] **A project-pinned token now gets `forbidden` naming a project it was never granted** → Accepted (D17): the denial is unchanged, the target is more informative, and D11's retargeted remedy makes it actionable.
- [Trade-off] **Twelve capabilities get deltas at once** → Accepted, because the alternative is twelve changes that each re-argue the same retirement while the surface stays half-migrated. The blast radius is bounded by what does NOT move in release N: no rowid, no index, no `memory.scope` column, no ranking constant, no design token.
- [Trade-off] **253 test occurrences of `SCOPE_GLOBAL` across 27 files must be reworked** → Accepted and expected to be the bulk of the diff. It is mechanical: the production decision surface is two return statements (`_shared.ts:71`, `:81`).
- [Trade-off] **`global` never fully leaves the operator surface** (D16) → Accepted and specified. The consolidation journal is append-only and records what happened.

## Migration Plan

**One migration file**, inside the runner's standard envelope — authors add no pragmas (`CLAUDE.md`, "Table-rebuild migrations"): `PRAGMA foreign_keys = OFF` → `BEGIN IMMEDIATE` → body → `PRAGMA foreign_key_check` → `COMMIT` → `PRAGMA foreign_keys = ON`.

Body, in order:

1. `ALTER TABLE projects ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`.
2. `SELECT id FROM projects WHERE is_default = 1` — **the idempotency guard**. If present, stop; the migration has already run.
3. Pick the first free slug from `default`, `default-2`, … by probing `projects.slug`.
4. `INSERT INTO projects (id, slug, display_name, is_default, created_at) VALUES (…, 1, …)`.
5. `UPDATE memory SET project_id = <new>, scope = 'project' WHERE scope = 'global'` — both columns in ONE statement (there is no DB-level `CHECK` tying them, confirmed: `memory.scope` is a Drizzle enum only, `db/schema/memory.ts:48`, so no intermediate state is rejected — but one statement is still correct, not merely tolerated).
6. `UPDATE memory_entities SET project_id = <new>, scope = 'project' WHERE scope = 'global'` — **or** skip, if the rebuild path is taken (D15).
7. `UPDATE sessions SET project_id = <new> WHERE project_id IS NULL` and the same for `prompts` (D19).
8. `UPDATE consolidation_runs SET scope = …` for pending/live rows only; historical rows keep `'global'` (D16).
9. **`memory_vec`: DELETE the ex-global rows and re-INSERT them carrying the same blob** with `partition_key = <new project id>` (D4). Never `UPDATE`. **Which of the two shapes is not decided here** — "DELETE + re-INSERT" describes both the per-row loop (A) and the stashed set-based pair (B), and they are not interchangeable: **only B is expressible as a `.sql` migration file** (the runner reads `.sql` and splits on the statement-breakpoint marker, so A needs a change to `db/migrate.ts`, and A's naive form materialises ~600 MB of Buffers in JS at 200k), while A grows the file +155 MB against B's +943 MB. Whichever is taken, **a stash table is mandatory**: re-`INSERT`ing at the new partition before the `DELETE` is measured to fail with `UNIQUE constraint failed on memory_vec primary key`, because `memory_id` is unique across partitions. See D4 and open question 6.

**Measured result: `measurements/scale.md`**, at four magnitudes against a corpus ~91% global — 1k / 10k / 50k / **200 000** previously-global rows, on databases of 22 MB / 128 MB / 597 MB / **2 336 MB**. Headline, instrument I3 FULL-BOOT (the real `createDb()`, which is the number an operator waits on): first boot after upgrade is **0.35 s / 1.6 s / 12.7 s / 203 s (3 min 23 s)**, and the control with the migration removed is 12 / 16 / 71 / 4003 ms — **the migration body IS the boot** (D23). Correctness is clean at every magnitude: **zero assertion failures across 68 runs** in four `memory_vec` shapes, 4 032 sampled blobs byte-identical and at `vec_distance_cosine = 0`, `foreign_key_check` / `integrity_check` / FTS `'integrity-check'` all clean, every per-table total conserved and non-zero, dense kNN non-empty in the new partition **and** in a pre-existing project's control partition, and SIGKILL mid-body atomic with a retry that completes. No table rebuild. Peak disk demand is ≈5.5 GB to migrate a 2.3 GB database (D24).

**This supersedes the previously-cited figure** — 51 → 51 memory rows at 16 enriched global rows, which is two orders of magnitude below what is now measured and was the gap `measurements/scale.md` was written to close.

**First boot after upgrade.** Migration runs inside `migrate()` at `db/client.ts:72`. **There is no migration logging at all today** — `migrate()` returns `{applied, skipped}` and `client.ts:72` discards the result — so this change creates that surface. Given the change's justification is truthfulness about where memories live, moving rows silently is not acceptable: **log the chosen slug and the repointed count**.

**That logging must be emitted before and during the body, not only after it (D23), and `printBootstrapBanner` is therefore NOT sufficient as the only home** — it runs after `createDb` returns, i.e. after a wait measured at **203 s** at 200k global rows, and is never reached at all in the failure mode that matters most (a killed boot, which rolls the whole body back and restarts it from scratch). A summary of completed work is precisely what is missing whenever the silence causes a problem. The entity rebuild then drains in the background (D15).

**The data-loss guard does not fire, measured not assumed.** `assertDataLossGuard` (`server/data-loss-guard.ts:86`, called at `bootstrap.ts:377`) compares five **table totals** with no scope dimension and trips only below 50%; the migration conserves every total. The control — deleting 60% of `memory` — correctly refuses the boot.

**Derived data.** `memory_fts` needs no action: external-content, keyed by rowid, and no rowid moves in release N. `memory_fts_vocab` likewise. `memory_vec` is repointed (step 9). The three entity tables are rebuilt or repointed (D15). All are regenerable from `memory`, which is what makes the recommendation available.

**Rollback** is an image downgrade with no data step, and it is **survivable, not transparent** (D5). The release note must say: a rolled-back server shows an empty global partition, and the rows live under the default slug.

**Verification against pre-existing data is a standing requirement** for anything touching migrations, MCP or HTTP. `dev:docker:up` reseeds with `seed-dev --reset` on every boot and is therefore **not** a valid instrument for "pre-existing data" — task 16 uses a volume that already holds rows, upgrades on the same volume without reset, and rolls back on the same volume.

## Open Questions

1. **When does release N+1 ship — how many releases may an operator skip and still roll back?** D20 decides N+1 is **scheduled, not optional**, and states the three costs of never shipping it. What is genuinely undecided is the window: `docs/updates.md` describes a one-step rollback to the immediately previous image, which would permit N+1 in the very next release, but nothing measures how far behind real installations actually run. **Default meanwhile: N+1 lands no earlier than one release after N**, so at least one release exists in which both the column and the default project are present. Left open because the answer is an operational judgement about the installed base, not a technical one this change can measure.
2. **Does the default project's slug or display name want to be operator-configurable at first boot?** Default: **no.** The slug is picked automatically (D3) and is immutable anyway; `display_name` is renameable through the existing dashboard action immediately after upgrade, which covers the real need without adding a first-boot prompt to a headless server. Named because "why is my project called `default-4`" is a predictable operator question and the answer (four slugs were taken) should be findable.
3. **Should `entity-state.json` deletion be performed automatically by the migration, or left to the operator?** D15 recommends rebuild but does not decide who triggers it. Default: **the migration does it**, because an operator who skips the step gets entity rows keyed to a scope that no longer exists and no signal that anything is wrong — the D4 shape again. Left open because it means a migration deleting a file outside the database, which is a first for this repo and may deserve its own review.
4. **Should `is_default` be transferable — an operator action "make this project the default"?** Default: **no, out of scope for release N.** The column is set once by the migration. Recorded because it is the obvious next request (an operator whose real work lives in one project will want path-less `/mcp` to land there), and because deciding it later is cheap while guessing now would add a mutation verb, an authorization question and a "what happens to the old default's rows" question to a change that already touches thirteen capabilities.
5. **`projects/spec.md:70` is measured FALSE and is not fixed here.** It says an archived project's `memory.search`/`memory.get` "SHALL continue to return its existing memories"; measured, `auth.ts:76-82` throws `project_archived` inside `authenticate`, **before any authorization**, so an archived project refuses even `initialize` with a 403 — for the admin `*` token too. It is **not** load-bearing for this change, because D18 forbids archiving the default project, so no path-less connection can reach an archived default. Listed for a separate reconciliation on the precedent of `4f7adff` ("fix(openspec): reconcile three claims the pending-queue change left stale"). Left as a question only in the sense of who picks it up — the finding itself is settled.

6. **Which `memory_vec` shape does the migration ship — the per-row loop (A) or the stashed set-based pair (B)?** **Left open with no default, because it is a disk-versus-time trade with no dominant answer, and the trade is the owner's to make.** Measured at 200 000 global rows (`measurements/scale.md` §3, §5, §6): **A = 232.4 s of body and +155 MB of file growth with a 1 473 MB WAL; B = 195.6 s and +943 MB with a 2 267 MB WAL.** B is 1.19× faster at 200k, **0.97× at 50k, and slower than A at 1k and 10k**, so **speed does not separate them** — the obvious batched rewrite is not the optimisation it looks like, and picking on wall-clock alone would be picking on noise at every magnitude below 200k. Two asymmetries weigh against the numbers rather than with them: **only B is expressible as a `.sql` migration file** (A needs a change to `db/migrate.ts`, and its naive form materialises ~600 MB of Buffers in JS at 200k), and **only A keeps an operator near a full volume inside D24's disk budget**. A stash table is mandatory either way. A full vtable rebuild (D) lands within 1% of B and is not a third option worth taking. Variant E is 5.8× faster and is **rejected, not open** (D4) — it leaks across scopes on the rollback path. Whichever is chosen, D4's assertion is written against the variant-agnostic property, so the tests do not have to be rewritten with the decision.
