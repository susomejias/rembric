## MODIFIED Requirements

### Requirement: Entities MUST be scoped, and entity lookup MUST respect scope isolation

Each entity SHALL be scoped exactly as memories are — belonging to exactly one project. The identity of an entity is `(scope, project_id, kind, value)`, enforced by a unique index, so the same literal string in two projects is two distinct entities and no join between them exists to be exploited. Retrieval by entity SHALL return only memories the caller's scope permits, and SHALL never return a memory from a project the caller's token is not authorized to read. An entity string appearing in two projects SHALL NOT join their memories **implicitly**: no default, filter or configuration SHALL cause an entity lookup to span projects.

**One widening exists, and it is the one the caller asks for.** The previous allowance for a project-scoped read to also admit global entities is retired with the global scope itself. In its place, `memory.search`'s explicit opt-in cross-project argument SHALL apply to the entity branch on the same terms as to the ranked branch: the set of projects read is exactly the set the token is authorized to read, computed by the same predicate and at the same single construction site, and every other branch of entity retrieval remains closed to the caller's own project. Absent that argument, an entity lookup returns the caller's project and nothing else.

The entity branch is where widening is cheapest and safest: it performs no fusion, no ranking, no rank window and no relevance gate, so admitting a second project's rows cannot reorder anything. What it does change is completeness, and that is bounded below.

**The completeness bound SHALL remain a bound on the RESPONSE, not per project.** An omitted `limit` means "every linked memory across the projects read, up to the same stated cap a narrow lookup is subject to" — never that cap multiplied by the number of projects. Widening SHALL NOT be able to increase the worst-case response size, because the worst-case annotation payload is pinned by a named ceiling asserted in CI (see `mcp-api`). A widened lookup that hits the cap SHALL surface the same truncation signal a narrow one does; the branch SHALL NOT claim a completeness it cannot deliver when widened.

**Ordering across the widened set SHALL be the branch's existing total chronological order applied to the union.** No project-of-origin term SHALL enter it, so a row is not promoted or demoted for being the caller's own.

**The entity tables SHALL be repointed in place by the migration that retires the global scope**, and the repointing SHALL collapse duplicate source rows first. Because `memory_entity_links` holds foreign-key references into `memory_entities`, and because the identity index is UNIQUE over `(scope, project_id, kind, value)`, a repointing collides in general — on both sides of the move, and the two sides are guarded differently:

- **Destination side**: impossible by construction, because the destination project is newly created by the same migration (see the `projects` capability), so its only entity rows are the repointed ones. Repointing in place SHALL NOT be taken if the destination is ever an existing project.
- **Source side**: NOT impossible, and the identity index is what makes it invisible. The index is UNIQUE over PLAIN columns, and every previously-global row has `project_id IS NULL`, which SQLite treats as distinct — so the pre-migration database does not enforce uniqueness among previously-global entities at all, and the move turns any two rows sharing `(kind, value)` into a live collision. The migration SHALL therefore collapse such rows onto one survivor and remap their links before repointing. Entities are derived state, so collapsing them loses nothing; the alternative is a failure that aborts the boot, writes no ledger row, and therefore recurs on every boot from then on. This mirrors `memory_topic_key_active_uidx`, which keys on `COALESCE(project_id, '')` for exactly this reason.

**Rebuild — deleting the entity-state recipe marker so the server wipes and re-derives the entity tables — SHALL NOT be used for this migration**, for two measured reasons. Its trigger is deleting a file OUTSIDE the database, which a `.sql` migration cannot do, so taking it would put a data-file deletion keyed to a migration name on the boot path. And it is not the cheaper option: at 10 000 previously-global rows the wipe is 375 ms of synchronous boot over 343 245 rows and the drain then re-extracts EVERY memory, including those that were never global, in 10.1 s — against 311.8 ms to repoint in place — while leaving every project's entity lookups empty until the drain finishes. The cost argument for rebuild counted the removed `UPDATE` but neither the wipe nor the re-extraction it buys.

Either way the derived state SHALL drain to zero after the migration: the operator-visible entity backlog SHALL reach `0` and the scan cursor SHALL cover every `memory` row. A repoint or rebuild that stalls part-way leaves entities keyed to a project that no longer addresses them, with no error and no counter that moves.

#### Scenario: The same path in two projects does not join them

- **GIVEN** memories in project A and project B both referencing `src/index.ts`
- **WHEN** entity retrieval is performed on a connection scoped to project A, without the cross-project argument
- **THEN** only project A's memories SHALL be returned

#### Scenario: Global entities are available to a project-scoped read when requested

- **GIVEN** a memory in the default project referencing `src/shared.ts` and a memory in project A referencing the same path
- **WHEN** entity retrieval is performed on a connection scoped to project A, with any argument other than the cross-project one
- **THEN** only project A's memory SHALL be returned, and no such argument SHALL admit the default project's
- **AND** the scenario title predates this change: the widening it names is retired, and this scenario now pins that it stays retired

#### Scenario: Widening to globals does not widen to other projects

The title predates this change: the global widening it names is retired, and what it pinned — that no argument admits a second project's rows — now holds for every argument except the explicit, authorized one, which reaches only projects the token may read.

- **GIVEN** projects A, B and C each holding a memory referencing the same path, and a token authorized to read A and B only
- **WHEN** entity retrieval is performed on a connection scoped to A with the cross-project argument
- **THEN** A's and B's memories SHALL be returned and C's SHALL NOT
- **AND** without that argument, only A's SHALL be returned
- **AND** both assertions SHALL be made over a corpus with a non-zero count in each project, so neither is satisfied by an empty set

#### Scenario: A widened entity lookup is bounded by the response, not by the project count

- **GIVEN** an entity linked to more memories across the widened set than the branch's completeness cap
- **WHEN** the widened lookup runs with `limit` omitted
- **THEN** the number of rows returned SHALL NOT exceed the cap a narrow lookup is subject to
- **AND** the truncation signal SHALL be the same one a narrow truncated lookup emits

#### Scenario: A widened entity lookup stays chronological

- **GIVEN** memories in two projects linked to the same entity, interleaved in creation time
- **WHEN** the widened lookup runs
- **THEN** the rows SHALL be in the branch's total chronological order across both projects, with no row promoted for belonging to the caller's own project

#### Scenario: The entity tables drain to zero after the migration

- **GIVEN** a populated database whose entity rows were repointed or rebuilt by the retiring migration
- **WHEN** the derived-state drain completes after boot
- **THEN** the operator-visible entity backlog SHALL be `0`, the scan cursor SHALL cover every `memory` row, and an entity lookup in the default project SHALL return its repointed memories

#### Scenario: Two previously-global entity rows sharing an identity are collapsed, not collided

- **GIVEN** two previously-global entity rows carrying the same `kind` and `value`, which the identity index admits because `project_id IS NULL`
- **WHEN** the retiring migration repoints them onto the default project
- **THEN** one row SHALL survive, every link to the other SHALL address the survivor, and the boot SHALL succeed
- **AND** every memory that either row addressed SHALL still be returned by an entity lookup in the default project
