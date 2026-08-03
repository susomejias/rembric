## ADDED Requirements

### Requirement: `project.list`'s per-project memory count MUST be a scoped repository read

The per-project memory count served to the `project.list` MCP tool SHALL be produced by a repository read that takes the scope as a required parameter, so that omitting it is a type error. It SHALL NOT be produced by an unparameterised read whose only predicate is `project_id IS NOT NULL`.

This closes the instance the requirement "Scoped, unsafe, and admin method families" already anticipated. `MemoryRepository.countByProject()` took no scope, counted every `status` across every project, and was reachable from an agent-facing MCP handler; because it carried neither the `admin` nor the `unsafe` prefix, the confinement gate — which matches call sites by method-name prefix — could not see it, and the only thing recording it was the closed inventory, which records rather than gates. It is the same failure mode as the unscoped session count that reached `memory.stats`, one tool over.

The replacement read SHALL carry NEITHER the `admin` nor the `unsafe` prefix, because it is in neither family: it filters to exactly one scope, so it is not unscoped, and it is not a deliberate cross-scope read. Prefixing it `admin` would additionally require adding the `project.list` handler to the `admin*` `(file, method)` allow-list — placing an agent-facing MCP path on the unscoped-read allow-list — and none of the four arguments that admit the existing non-dashboard entries applies: the read is on a per-request path (so the boot-time-closure argument fails), its return values are keyed by `project_id` (so the argument from return types carrying no scope identity fails), and the `memory` table has both a `scope` and a `project_id` column (so the structural argument that no scoped filter exists fails).

The measurement escape hatch in "Scoped repository reads MUST require a Scope parameter, not merely a naming convention" SHALL NOT be invoked for this read without recorded figures. A scoped alternative demonstrably exists — the shared `(scope, project_id)` builder fragment, and a sibling count method on the same repository that already takes both parameters — and no measurement of it was ever recorded. If a future change adopts a key-bounded aggregate over the authorized project ids instead of a per-scope read, it SHALL record the instrument and the numbers with that change, per that requirement.

The closed inventory of unscoped, un-keyed, unprefixed repository reads SHALL NOT list this read after this change. Because that inventory is asserted by SET EQUALITY, the source change and the inventory change SHALL land together: leaving the entry after the read is gone SHALL fail the suite, and removing the entry while the unscoped read remains SHALL also fail it.

#### Scenario: The count method requires the scope

- **WHEN** the repository read backing `project.list`'s per-project count is called without scope arguments
- **THEN** the call SHALL fail to compile, because the scope is a required parameter of the method signature

#### Scenario: The count method carries no `admin` or `unsafe` prefix

- **WHEN** the repositories are scanned for the read backing `project.list`'s per-project count
- **THEN** its name SHALL NOT begin with `admin` and SHALL NOT begin with `unsafe`
- **AND** the `admin*` `(file, method)` allow-list SHALL NOT gain an entry for the `project.list` handler

#### Scenario: The unscoped-read inventory no longer lists the count

- **WHEN** the invariants suite asserts set equality between the inventory and the unscoped, un-keyed, unprefixed reads the repository sources declare
- **THEN** neither side SHALL contain the per-project memory count read
- **AND** the suite SHALL fail if the inventory entry is kept while the read is scoped, and SHALL fail if the read is left unscoped while the inventory entry is removed

#### Scenario: The scope reaching the read comes from an already-authorized project row

- **GIVEN** a token whose scope authorizes reading project `p` but not project `q`
- **WHEN** `project.list` computes its per-project counts
- **THEN** the read SHALL be invoked for `p`'s scope and SHALL NOT be invoked for `q`'s scope
- **AND** the authorization filter over project rows SHALL run before any count is taken
