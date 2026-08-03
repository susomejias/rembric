## MODIFIED Requirements

### Requirement: Scoped, unsafe, and admin method families

Repository read methods consumed by scoped service paths SHALL require scope context as explicit parameters and SHALL NOT default to unfiltered reads. Deliberately cross-scope repository methods consumed by services and operational code (consolidation engine, scope-check-then-use patterns) SHALL carry the `unsafe` prefix, mirroring the `MemoryService.unsafe*` convention. Unscoped reads SHALL carry the `admin` name prefix and SHALL be invoked only from an allow-listed call site. Services remain the sole resolvers of effective scope (`resolveEffectiveProject` / `scopeFromContext`); repositories enforce the filter they are given.

`admin` names what the read does to SCOPE — it does not filter — and not who consumes it. The definition is therefore "an unscoped repository read, invocable only from allow-listed call sites"; that the allow-list is predominantly the dashboard is an observation about who is on it, not what the prefix means. The distinction is load-bearing because the enforcing gate only ever checked confinement of a NAME to a set of call sites, never the tie between the name and the unscoped property, and describing the family by audience made an unscoped read on a non-dashboard path look like a different category needing a different prefix. It is not: one prefix, one meaning, and the argument for each call site is made per call site.

An `admin*` read SHALL be read-only with respect to the durable database. A write is admitted only when it is confined to a contentless table in the connection's temporary schema, so that neither the durable file nor its write-ahead log records it; the read stays read-only in the only sense the invariant is about.

There is no third, unprefixed category. An aggregate-count method is NOT exempt from the prefixes: the grep gate matches call sites by method-name prefix, so an unscoped read carrying neither prefix is invisible to it and can be served from an agent-facing path while the invariant test passes — which is exactly how an unscoped session count reached `memory.stats`. Every unscoped repository read SHALL therefore carry `admin`, whatever it returns.

Because that rule is a naming convention, and a naming convention cannot detect its own violations, the invariants suite SHALL additionally maintain a CLOSED inventory of the repository reads that are unscoped, un-keyed and unprefixed, asserted by SET EQUALITY against what the repository sources declare: adding such a read without listing it SHALL fail, and removing a listed one without unlisting it SHALL fail. This mirrors the two-sided allow-list the physical-purge `DELETE` statements already carry. The inventory SHALL cover the repositories owning tables with a `(scope, project_id)` content dimension, SHALL classify every repository file as either covered or control-plane so that a new repository cannot be added unclassified, and SHALL mark any entry that is also a violation of the `admin`-prefix rule above, so the inventory is not read as a blessing. The rule SHALL NOT instead be an absence-side pattern match over query text: `GROUP BY project_id` and `WHERE project_id = ?` are indistinguishable to a pattern, and the one measured attempt had a false negative on precisely the per-project count the inventory exists to record.

Four `admin*` call sites legitimately sit outside `src/dashboard/`, and each is named here rather than left to a general exemption. The gate SHALL admit them as `(file, method)` PAIRS, not as whole files: a file-level licence blesses every future `admin*` call in that file as well, which on the row-assembly path of retrieval is the most expensive place in the codebase to grant one.

- `src/server/dashboard-router.ts`, which renders the operator overview directly.
- The boot-time `memory.doctor` closure in `src/server/bootstrap.ts`. The doctor report is deliberately server-wide — `sessions.active`, the embedding and entity backlogs, the latest consolidation run and the review/pending queue depths are all unscoped by design, so that an operator debugging one project still sees the whole process's health. The closure is constructed once at boot and reads nothing per-request-scoped, so it does not leak cross-scope ROWS: every field it returns is a count or a timestamp. Reads reachable only from it SHALL still carry the `admin` prefix, so the gate sees them and the exemption is a listed call site rather than an unnamed naming gap. `vectors.adminBacklogCount()` and `consolidation.adminLatestRun()` were renamed under this rule, joining the sibling `entities.adminBacklogCount()` that already carried it.
- `src/services/agent-sessions.ts`, whose `adminCountByStatus()` is a service-layer pass-through to the repository read of the same name; its own callers are confined by the two entries above.
- `src/services/hybrid-search.ts`, which reads the relevance level's corpus-wide term statistics on every text query. This call site is AGENT-FACING, and it is admitted on the RETURN TYPES, never on the caller's audience. The `bootstrap.ts` argument above — constructed once at boot, reads nothing per-request-scoped — is FALSE here and SHALL NOT be reused: this is a per-request path. What holds instead is that the row-space of both reads is empty by construction. `adminDocumentCount()` returns one integer. `adminQueryTermFrequencies()` returns the caller's OWN query terms mapped to corpus-wide integers. Neither return type carries a memory id, content, or a `project_id`, so no change to a filter and no rename can turn either into a cross-scope row channel without changing the return type, which the compiler sees. The closest precedent is `MemoryRepository.unsafeAncestorIds` — unscoped, agent-facing, prefixed, and justified by an argument about the structure of the data rather than about who calls it. `adminQueryTermFrequencies()` is also the read-only carve-out above: it inserts the query text into a contentless FTS5 table in the `temp` schema in order to tokenise it through the index's own tokenizer.

#### Scenario: Invariant test pins admin call sites to the allow-list

- **WHEN** the invariants suite scans non-test source files outside the dashboard modules, the named call sites, and `apps/server/src/db/repositories/` for invocations of `admin`-prefixed repository methods
- **THEN** the suite SHALL fail, naming the offending file and the method, when any such call site is found

#### Scenario: An unscoped aggregate reachable from the doctor carries the prefix

- **WHEN** an unscoped repository read is reachable from the `memory.doctor` report
- **THEN** it SHALL carry the `admin` prefix, so it is inside the confinement gate rather than invisible to it

#### Scenario: Cross-scope semantics are preserved

- **WHEN** a service requests a memory through a repository with a scope that does not match the row's `(scope, project_id)`
- **THEN** the repository SHALL return no row and the service SHALL surface `not_found`, identical to pre-refactor behavior

#### Scenario: An agent-facing unscoped read is admitted on its return type

- **GIVEN** an unscoped repository read consumed from a per-request agent-facing path, whose return type is an aggregate carrying no row identity
- **WHEN** it is admitted to the allow-list
- **THEN** the admitting argument SHALL be that the return type has no row-space, and SHALL NOT be that the caller is operator-facing or constructed once at boot

#### Scenario: A listed file does not license a second admin method

- **GIVEN** a file already named in the `admin*` allow-list for one method
- **WHEN** a call to a DIFFERENT `admin*` method is added to that same file
- **THEN** the invariants suite SHALL fail naming the new method, because the licence is granted per `(file, method)` pair rather than per file

#### Scenario: A tokenising write to the temp schema keeps a read read-only

- **GIVEN** an `admin*` read that writes the query text to a contentless table in the connection's temporary schema in order to tokenise it
- **WHEN** the durable database file and its write-ahead log are inspected across many such reads
- **THEN** neither SHALL have grown, and the read SHALL still satisfy the read-only requirement

#### Scenario: An unscoped unprefixed read must be in the closed inventory

- **GIVEN** a repository owning a table with a `(scope, project_id)` content dimension
- **WHEN** a read method is added to it that takes no scope, no row key, and carries neither prefix
- **THEN** the invariants suite SHALL fail until the method is named in the inventory

#### Scenario: An inventory entry that no longer exists fails the suite

- **WHEN** an inventory entry is renamed, prefixed, or deleted in the repository source without being removed from the inventory
- **THEN** the invariants suite SHALL fail, so the inventory and the implementation move together

#### Scenario: A new repository cannot be added unclassified

- **WHEN** a repository file is added under `apps/server/src/db/repositories/` and is named in neither the covered nor the control-plane classification
- **THEN** the invariants suite SHALL fail, so a new aggregate cannot escape the inventory by not being scanned

### Requirement: Scoped repository reads MUST require a Scope parameter, not merely a naming convention

Data-access confinement is enforced by a grep gate that matches call sites by method-name prefix: `admin*` reads are callable only from allow-listed call sites, `unsafe*` marks a deliberate cross-scope read. A repository read that is unscoped but carries **neither** prefix is invisible to that gate, so an unscoped aggregate can be served from the MCP layer while the invariant test passes — which was the case for the session status count consumed by `memory.stats` until `countByStatus` was made to require a `Scope`.

Every repository read reachable from the MCP layer SHALL take the `Scope` as a required parameter, so omitting it is a type error rather than a naming oversight. An unscoped variant SHALL exist only under the `admin` prefix, bringing it inside the confinement gate.

An MCP-reachable read MAY legitimately take no `Scope` — but only when the scoped alternative does not exist or is shown by MEASUREMENT to be unaffordable, and only under the `admin` prefix with the call site named as a `(file, method)` pair. "Would be slower" is not the standard; the numbers and the instrument that produced them are, and they SHALL be recorded with the change that admits the read so that the next proposal to scope it meets a figure rather than an assertion. Two such records stand behind the relevance level's term statistics:

- **Structural.** `memory_fts_vocab` exposes `(term, doc, cnt)` and has no scope column, so `fts5vocab` cannot be scope-filtered at all. There is no filtered vocabulary read to substitute; a scoped document frequency has to be recomputed per scope by counting matching documents per term.
- **Measured.** That recomputation costs **29.6–115.6 ms per search** as ISOLATED STATEMENT TIME (50 000 rows over six scopes, p50 of 40, one warm process), against **1.2–3.8 ms** for the index-global read on the same instrument. The correctness control passed on 228 of 228 `(scope, term)` pairs — scoped `df` never exceeded global `df`. Separately, and on a DIFFERENT instrument, the whole search measures an end-to-end p50 of **15.2–15.9 ms** at 50 000 rows. The two SHALL be quoted as separate rows and SHALL NOT be combined into one table: the second is what a caller waits on, the first is one statement inside it, and reporting a statement figure as an end-to-end one has already produced a 39× claim for a 2.5× effect in this repository.

The consequence for the level is bounded in "The relevance level's term statistics MUST come from the search index": a term statistic carries no row identity, so the unscoped read is a cost decision and not a scope hole.

#### Scenario: An unscoped aggregate is renamed into the gate

- **WHEN** an unscoped session-count read exists
- **THEN** it SHALL carry the `admin` prefix and SHALL be callable only from the `(file, method)` pairs the allow-list names — which for this read are the dashboard router, the `memory.doctor` closure and the service pass-through between them, NOT the dashboard layer alone

#### Scenario: The MCP layer cannot omit scope

- **WHEN** an MCP handler calls a scoped repository read
- **THEN** the read SHALL require the `Scope` argument, so a scope-less call fails to compile

#### Scenario: An MCP-reachable unscoped read is admitted with a measurement

- **GIVEN** a repository read reachable from the MCP layer for which no scoped alternative exists in the schema
- **WHEN** it is admitted without a `Scope` parameter
- **THEN** the change admitting it SHALL record the cost of the scoped alternative, the instrument that produced the figure, and a correctness control, and SHALL name the read's call site as a `(file, method)` pair under the `admin` prefix
