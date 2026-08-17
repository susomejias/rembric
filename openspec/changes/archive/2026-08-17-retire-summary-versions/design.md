## Context

`session_summary_versions` was added by `2026-08-13-session-summary-full-rewrite` as the recovery net for whole-document replacement. Its whole justification is one sentence, published at `openspec/changes/archive/2026-08-13-session-summary-full-rewrite/proposal.md:15`: _"This is what makes the replace recoverable: the text that was displaced is still a row, which is the only recovery mechanism this repo has."_

`refine-session-summary-writes` changes what a curated write does. Under its section-wise merge an omitted `##` section keeps its stored text, and a curated write carrying no `##` heading at all against a sectioned stored summary is refused. So the two shapes the version rows were bought to survive — the model forgetting a section, and the model collapsing six sections into one paragraph — stop being reachable. One shape remains: a section the write CARRIES, rewritten thinner than what it replaces. That one is not covered by either change, and it is the accepted risk of this one.

The rest of the work is not mechanical. The table is load-bearing in the RATIONALE of requirements in four other capabilities: three in `plugin-session-protocol` (one of which names it in the requirement TITLE, and one of which declares it the sufficient mitigation of a published accepted risk), one in `dashboard`, one in `data-access`, one in `sessions`. Deleting the mentions would leave obligations standing on nothing. Each has to be re-argued from preservation-by-omission, or narrowed to what is actually still true.

Three ordering facts constrain when this lands, and none of them is a code dependency:

- It archives AFTER `refine-session-summary-writes`. This change modifies a requirement that one ADDs, and re-modifies a scenario it already touches.
- ~~`measure-summary-clobbering` phase 1 reads versions 14 and 15 of session `01a00320-1fae-7360-862f-0ae866b38803` out of the operator's live deployment. The capture must happen before this change reaches that deployment.~~ **Resolved at archive time, and resolved the other way: the capture never happened.** `measure-summary-clobbering` was discarded by the owner with all 69 of its tasks unstarted (`tasks.md` 1.3 records the same finding at apply time), so there is no capture to sequence against and this is no longer an ordering constraint on anything. What actually protects those rows on the operator's deployment is the pre-upgrade `sqlite3 .backup` in `tasks.md` 1.5 — an OPERATOR action, still outstanding — and nothing else.
- `server-gated-session-nudges` states in its own `design.md:24` that it rests no argument on the table, and that is true of its behaviour — but its DELTA TEXT carries three references that this change would leave dangling: a **One site** cross-reference at `specs/session-nudges/spec.md:10`, a no-backfill rationale at `specs/sessions/spec.md:7`, and a scenario bullet asserting "no version row SHALL be appended" at `specs/sessions/spec.md:100`. Whichever of the two archives SECOND owns repointing them (the **One site** reference goes to "Terminal session rows MUST accept late summary and title writes…", per D3) and dropping the version-row bullet. The order is free; leaving the references unrepointed is not.

## Goals / Non-Goals

**Goals:**

- Remove the table, its migration-era schema, its five repository methods, its service wrapper, its MCP argument, its dashboard section, and its tests — leaving no dead read path and no orphaned constant.
- Re-argue every published requirement whose rationale rests on the version rows, from the sibling change's preservation-by-omission, and narrow the ones that argument does not fully reach rather than overclaim.
- State the residual risk (an in-section clobber) where a reader will meet it, not only in this change folder.
- Leave the migration chain honest on both a fresh install and an upgraded one.

**Non-Goals:**

- The write contract. `refine-session-summary-writes` owns the merge, the heading-less refusal, the second cap check and every model-facing text change.
- The nudge system and its byte budgets.
- Any new table or column. In particular, this change does NOT introduce a replacement for the version rows and does not depend on `measure-summary-clobbering`'s `summary_anchor_measurements`.
- Any shrink guard, similarity check, LLM or content analysis on the write path.
- Any operator export of the rows before the drop.

## Decisions

### D1. Keep `0033_session_summary_versions.sql` on disk; drop the table with a NEW migration

The runner reads the migration directory and skips filenames already recorded in `_migrations` (`apps/server/src/db/migrate.ts:95-110`). Deleting `0033` therefore does not error on an upgraded install — it silently does nothing, because the row is already there — but it does change what a FRESH install produces: no create, no drop, and an `_migrations` table whose contents differ from every upgraded peer. Two databases claiming to be at the same schema version with different applied histories is exactly the drift `migrations.test.ts`'s pinned filename list exists to prevent.

The repo already answered this once: `0011_summary_length_check.sql` and `0012_drop_summary_length_check.sql` both remain on disk, and `openspec/specs/sessions/spec.md` refers to the drop by pointing at the pair. Same shape here.

Rejected: deleting `0033` and its test (divergent fresh installs, as above); editing `0033` in place to be a no-op (a migration recorded as applied is history — rewriting it makes the recorded row describe something that never ran).

### D2. The drop is one `DROP TABLE`, with no rebuild dance and no pragma of its own

`session_summary_versions` references `sessions(id)`; nothing references `session_summary_versions`. It is a child, never a parent, so the `FOREIGN KEY constraint failed`-on-`DROP TABLE` hazard that forces the rebuild dance for a parent table does not apply. The runner's standing sequence — `PRAGMA foreign_keys = OFF` → `BEGIN IMMEDIATE` → body → `PRAGMA foreign_key_check` → `COMMIT` → `PRAGMA foreign_keys = ON` (`apps/server/src/db/migrate.ts:117-170`) — covers it, and `apps/server/src/test/invariants.test.ts::"migration runner FK-safety invariant"` already forbids a migration author from adding pragmas.

The migration's header comment records ONE non-obvious fact and no more, per the repo's comment policy: that the rows are destroyed irreversibly and why that was accepted, pointing at the spec rather than restating it.

### D3. `updateAndVersion` collapses into `updateById`; the transaction goes with it

Without the append, `updateAndVersion` (`apps/server/src/services/agent-sessions.ts:298-321`) is `this.tx.transaction(() => this.repos.agentSessions.updateById(id, set, opts))` — a transaction around one statement, which is what SQLite already gives every statement. Its three call sites (`:276`, `:371`, `:422`) become direct `updateById` calls.

This does NOT touch the property that `precedenceSet` is the single site folding per-field `final` precedence into an update `set`. That property is published independently of the version rows, at `openspec/specs/sessions/spec.md:1029`: _"Per-field precedence SHALL be folded into an update `set` in exactly ONE place, shared by all three write paths (the terminal write, `writeSummary`'s active path, `end`'s active path), so the three cannot drift."_ It is also where the sibling change puts the merge and the second cap check, so the two changes touch adjacent code without competing for the same seam. The **One site** cross-reference the sibling's merge requirement makes to the removed requirement repoints here.

`TransactionRunner` stays in the constructor: `purgeEmpty` (`:727`) still needs it.

### D4. The Pi accepted-risk clause gets a NARROWER mitigation, stated as narrower

`plugin-session-protocol` currently says, of a client with no compaction event (`:795`): _"`session_summary_versions` IS the mitigation, and it SHALL be treated as sufficient for this case: the displaced text is a version row, so the loss is recoverable rather than destructive."_ Removing the table removes the mitigation of a published accepted risk, so something has to take its place — and honesty requires noticing that the replacement does not cover the same ground.

The failure that clause describes is a post-compaction model writing "a THIN post-compaction rewrite — a full-looking summary of the window the model can still see". A _full-looking_ summary carries all six headings. Under section-wise merge, a write carrying all six headings replaces all six sections. **Preservation by omission does not save this case.**

What DOES change, and what the rewritten clause says:

1. The worst shape is now refused outright. A post-compaction rewrite that degenerates to one flat paragraph — no `##` heading at all — is rejected with `invalid_input` against a sectioned stored summary, so the six-sections-become-one-paragraph outcome cannot land.
2. Any section the thin rewrite does not carry survives byte-identically. A model that writes only the two sections it can still speak to costs nothing at all, which is precisely what the sibling change's model-facing text now asks for.
3. What remains uncovered is a thin rewrite that carries a heading and puts less under it. That is the accepted risk, and the clause SAYS so instead of claiming recoverability it no longer has.

The requirement's TITLE names the retired mechanism ("…where no such event exists the version history MUST be the accepted mitigation"), so it is RENAMED as well as modified — the OpenSpec `RENAMED` + `MODIFIED` pair, as in `2026-08-14-guard-stop-nudge-reentry`.

Rejected: deleting the accepted-risk clause and treating Pi as covered (false — the in-section case is real and specific to a client that cannot inject at compaction). Rejected: requiring Pi to invent a compaction event (the requirement explicitly forbids that, and no host capability exists).

### D5. The resumed-read line stops being "quality only" and is said to buy safety too

`:671` currently says the once-per-process resumed-read line _"buys QUALITY, not safety. Safety is the server's: a curated write is recorded as a version row before it can displace anything … so its absence SHALL cost correctness nothing."_

After the sibling change the server's safety is real but partial: it covers the section the model omits, not the section the model rewrites. Directing the model to read the stored summary first is what makes an in-section rewrite a condensation rather than a substitution — the model can only preserve what it can see. So the line moves from a pure quality aid to the mitigation of the one gap the server does not close, and the final clause ("its absence SHALL cost correctness nothing") is no longer true and is replaced.

The OBLIGATION is unchanged — emit the line once, from the shared fixture contract, from the first ensure's verdict, with no new request. Only the rationale and that one clause move. Rejected: strengthening the obligation (e.g. making the line unconditional, or repeating it) — nothing measured says the current cadence is insufficient, and the nudge change owns cadence.

### D6. The end-of-turn reminder's "no suppression" rule keeps its primary argument and loses its secondary one — SUPERSEDED, the requirement is gone

`:866` gives two reasons not to suppress the reminder on an already-summarised session. The first is unaffected: suppressing it freezes whatever the first write said, because nothing afterwards asks the model to improve it. The second — _"a later curated write is recorded as a version row before it can displace anything, so a redundant reminder can no longer cost stored text"_ — goes.

Its replacement is an asymmetry rather than a guarantee: the cost of a redundant reminder is now bounded by the merge (every section the prompted write omits survives, and a heading-less write is refused), while the cost of suppression is unbounded (a premature first summary becomes permanent). The rule survives on the asymmetry; it no longer claims the reminder cannot cost stored text, because after this change it can — a prompted write that rewrites a section thinner is exactly the residual risk.

**Superseded at archive time, and the edit was dropped rather than carried over.** `server-gated-session-nudges` archived first and retired this requirement whole, replacing it with "Every client's end-of-turn handler MUST report the turn exactly once and MUST NOT emit on the host's end-of-turn channel". Under that contract the client emits nothing model-facing at end of turn and the reminder is server-composed, so the suppression rule this decision re-argued no longer has a home in `plugin-session-protocol` and the replacement carries no version-row clause to repoint. Verified rather than assumed: the delta's edit to this requirement was a one-paragraph substitution and nothing else, and the published replacement contains no version-row claim, so dropping the block loses nothing this change was owed. The version-row citation that DID survive that retirement is in `session-nudges`, and it is repointed by the delta added for that capability.

### D7. The dashboard section is REMOVED, not replaced

`dashboard/spec.md:1583` justifies the section conditionally: _"Without a reader the table is storage nobody consumes; with one, a summary displaced by a later curated write is recoverable by an operator reading it and handing it back."_ With no table there is nothing to read and no operator recovery to offer, so the requirement is removed whole rather than rewritten into a weaker one.

The operator does lose a real capability: reading displaced text and handing it back. That loss is the accepted risk of this change and belongs in the risk register, not in a hollowed-out dashboard requirement that renders an empty section forever.

Rejected: keeping the section as a read of some other source (there is none). Rejected: adding an operator-facing export of the rows before the drop (a new surface, a new format, and a promise to read it back that nothing would honour — and it would have to ship in the same release as the drop to be reachable at all).

### D8. `memory.session_get` loses `limit`, and the refusal is documented rather than softened

Tool input schemas here are strict: `mcp-api`, "Every MCP tool input schema MUST refuse an unknown property rather than ignore it" (`openspec/specs/mcp-api/spec.md:2682`). A model whose context still carries the old description and sends `limit` gets the transport's invalid-parameters error naming the tool and the property. That is the designed behaviour of the strictness requirement — _"A refusal that names the property tells the operator to upgrade; a silent drop tells them nothing"_ — so no exception is carved for this argument.

The blast radius is bounded and worth stating: `limit` is model-facing only. No shipped client sends it, and none can — session lifecycle is HTTP, and `memory.session_get` appears in `apps/plugin/` only inside nudge TEXT directed at the model (`scripts/post-compact.sh:36`, `scripts/prompt-nudge.sh:21`, `test/nudge-fixtures.json` `postCompact`/`postCompactCore`, `.hermes-plugin/__init__.py:142,151`), never as a call. Every one of those strings names the tool without arguments, so none of them has to change. The tool's own published description already tells the model the argument is exceptional and not for routine use.

Rejected: keeping `limit` as an accepted-and-ignored no-op (forbidden by the strictness requirement, which has no per-tool exception list, and it would publish an argument that does nothing). Rejected: a deprecation release that keeps `limit` returning an empty array first (MCP has no version negotiation; the two-release dance buys a model one release of a field that is always empty, which teaches it something false).

### D9. Two `sessions` requirements are REMOVED, not merged into a survivor

"Every curated session-summary write MUST append a version row in the same transaction" and "`session_summary_versions` rows MUST be append-only, and removable only with their session" are entirely about the table. Each carries one clause worth preserving elsewhere, and each is preserved by pointing at where it already lives independently:

- The **One site** clause is re-published at `sessions:1029` already (D3), so the sibling's merge requirement repoints there and nothing is lost.
- The `ON DELETE CASCADE` clause and the "a session with a version row is not purge-eligible" reasoning both fall away with the table. The purge predicate itself is untouched: clause 1 (any summary text at all, curated or raw, makes a session ineligible) is what actually keeps a summarised session out of the purge, and it is published in "Sessions MAY be physically purged when empty" independently. The corresponding test at `agent-sessions.test.ts:694` must therefore be REWRITTEN to assert against the summary column rather than deleted — deleting it would drop coverage of a predicate that still exists.

### D10. Where the residual risk is recorded

Three places, deliberately, and no more:

1. This change's `proposal.md` and risk register — the decision and its owner.
2. `sessions`, in the last-final-wins scenario of "A session summary MUST follow the documented structure" — the exact locus, where a reader asking "what happens to the displaced text" meets it.
3. `plugin-session-protocol`, in the renamed compaction requirement — where a client-shaped reader meets it.

Not recorded in a code comment. The repo's comment policy admits one line documenting a concrete non-obvious fact, not a rationale block, and the rationale belongs in the spec.

## Risks / Trade-offs

- **[Risk] An in-section clobber becomes unrecoverable.** A curated write sending `## Accomplished` with one line, against a stored `## Accomplished` of ~640 characters, replaces that section and leaves no copy. → **Accepted knowingly by the owner.** The mitigations that remain are indirect and are named rather than oversold: the sibling change's "condense, never delete" and "send only the sections that changed" text, the heading-less refusal, and the compaction/resume directives that make the model read the stored text before rewriting it. No guard is added — a shrink guard was rejected on the record in `2026-08-13-session-summary-full-rewrite` and again in `refine-session-summary-writes`, because a correct summary legitimately shrinks. **No instrument sizes this residual, and none is planned.** `measure-summary-clobbering` was drafted as that instrument and was discarded unstarted, so the risk is carried on the indirect mitigations above and on nothing else — stated here rather than left pointing at a change that will not land.
- **[Risk] Existing version rows are destroyed by the migration, irreversibly.** There is no journal of payloads in this repo. → **The mitigation is the operator's own `sqlite3 .backup` (`docs/backup.md`) and nothing else.** This risk was originally written as mitigated by sequencing — `measure-summary-clobbering` phase 1 capturing the one pair of versions anyone had identified a use for, before this change reached the operator's deployment. That change was discarded unstarted and the capture never happened, so the sequencing mitigation does not exist and the file-level backup is the whole of it, as it is for every destructive migration.
- **[Risk] Rollback to a pre-drop image breaks the curated write path.** The older code inserts into a table that no longer exists, failing the whole write transaction; the dashboard detail page 500s on its history read. → Mitigation: roll forward, or recreate the empty table by hand from the `0033` DDL, which is still on disk. Stated as a `persistence` scenario so it is discoverable from the spec rather than from an incident.
- **[Risk] The delta specs are authored against `refine-session-summary-writes`'s post-archive state and drift if that change is revised in review.** → Mitigation: an explicit first task to re-read the sibling's `specs/sessions/spec.md` and rebase this change's `sessions` delta before implementing anything, plus `pnpm run check:spec-provenance` as the gate. The coupling is exactly two places: the **One site** cross-reference and the last-final-wins scenario.
- **[Risk] A model still carrying the old `memory.session_get` description sends `limit` and gets a hard error.** → Accepted as the designed behaviour of the strict-schema requirement (D8). The error names the tool and the property; the tool without `limit` still returns the full untruncated summary, which is what the caller actually wanted in every case except recovery.
- **[Trade-off] The operator loses the only surface that showed what a curated write displaced.** → Accepted because after the sibling change the common displacement no longer happens, and the remaining one (in-section) is the risk the owner accepted. Keeping a whole table, section, CSS block and test file to serve a case the owner has decided not to protect is the definition of a net under nothing.
- **[Risk] Removing four invariant grep rules weakens the append-only pin family.** → No: the rules removed are exactly the four naming `session_summary_versions`. The `memory`, `sessions`, `prompts` and `memory_relations` pins in the same array are untouched, and a task verifies the array's remaining membership explicitly rather than trusting the diff.
- **[Risk] Removing the `SOURCE_TABLES` entry silently breaks a census that derives from it.** → `migrations-0031.test.ts:61` builds `CENSUS_TABLES` from `SOURCE_TABLES` but filters to the tables actually present at that checkpoint (`:80-90`), so the entry's removal is a no-op there. Verified by reading, and confirmed by running that test as a named task rather than relying on a full-suite pass to notice.

## Migration Plan

One additive-in-form, destructive-in-effect migration: `DROP TABLE session_summary_versions`, no rebuild, no pragma, no backfill, nothing written to any other table. `0033` stays on disk (D1), so a fresh install creates the table and immediately drops it — correct, cheap, and identical in outcome to an upgraded install.

First boot after upgrade: the table is gone; every other table is byte-identical; `PRAGMA foreign_key_check` is clean before `COMMIT`; no derived data is invalidated (`memory_fts`, `memory_fts_vocab`, `prompts_fts`, `memory_replaces`, `memory_vec` and the three entity tables all derive from `memory` / `prompts`); the startup shrink guard's operator-visible set does not include the dropped table.

Rollback breaks (see the risk register). This is the first migration in this capability's history where it does, which is why it is a published scenario rather than a note.

Migration number is assigned at apply time. Resolved: `0034` went to `server-gated-session-nudges` (`0034_session_nudge_gate.sql`), so this change took `0035_drop_session_summary_versions.sql` and updated the two filename fixtures in `migrations.test.ts`.

## Open Questions

- **Should the drop migration log the number of rows it destroys?** Default taken: no. Migrations here are SQL and cannot log; the runner already emits `applying <file>`, and adding a TypeScript pre-step to count rows would put procedural code in a path that has none. An operator who wants the number takes the backup the destructive-migration guidance already tells them to take.
- **Should `memory.session_get` gain any replacement affordance for recovery?** Default taken: no. There is nothing left to recover from, and adding a surface that returns nothing is worse than not having one. If a future change reintroduces history in some other form, it argues for its own read surface with its own evidence.
- **Does the residual in-section risk warrant an instrument before this lands?** Left open at proposal time, and **closed at archive time by the owner's decision rather than by an answer**: `measure-summary-clobbering`, the change drafted to be that instrument, was discarded unstarted. The risk therefore lands accepted and unmeasured. Anything that reopens the question is a new change with its own evidence bar.
