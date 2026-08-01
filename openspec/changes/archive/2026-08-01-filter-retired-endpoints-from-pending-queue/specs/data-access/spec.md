## ADDED Requirements

### Requirement: The scoped pending-judgment reads MUST share one endpoint-lifecycle predicate

`listPendingInScope` and `countPendingInScope` are a page and its depth. They already share `endpointsInScope`, the single definition of "both endpoints lie in the resolved scope", because two copies of a scope rule drift silently. The endpoint-lifecycle rule the `memory` capability requires ("A pending judgment MUST be withheld from the agent queue once either endpoint is retired") SHALL be defined exactly once in the relations repository, beside `endpointsInScope`, and applied by both reads. A second copy is prohibited: a list and a total that disagree present as a working feature whose queue can never be drained.

The predicate SHALL be expressed as equality predicates on the already-joined source and target memory aliases, which both reads join to satisfy `endpointsInScope`. It SHALL NOT be implemented as an additional join, a correlated subquery, or a post-read filter in a caller.

A caller-side filter is specifically prohibited on two independent grounds: the row limit is applied in SQL, so dropping rows afterwards returns a short page that is indistinguishable from the end of the queue; and a lifecycle predicate in a service, MCP handler or dashboard handler violates the SQL-confinement requirement of this capability.

The lifecycle predicate SHALL NOT be folded into `endpointsInScope`. That helper serves reads which must keep seeing retired rows — the sweep's own candidate selection and the unscoped `admin*` reads — and conflating "in scope" with "still active" would make the next such read wrong by default rather than by choice.

`countPendingInScope` SHALL NOT be rewritten as an arithmetic difference of table-level counts, the form this capability prefers elsewhere for relation counts. That rewrite rests on both endpoints being NOT NULL foreign keys onto a primary key, which says nothing about the endpoints' `status`; a difference computed over `memory_relations` alone cannot see the column this predicate reads.

#### Scenario: A second copy of the predicate is introduced

- **WHEN** a change adds the endpoint-lifecycle condition inline to one of the two reads instead of reusing the shared definition
- **THEN** the change SHALL be rejected
- **AND** the reason SHALL be that the page and the total must be provably identical in what they exclude, not coincidentally identical

#### Scenario: The filter is moved to the caller

- **WHEN** a change removes the predicate from the repository and filters the returned rows in `apps/server/src/mcp/memory-tools.ts` instead
- **THEN** the change SHALL be rejected
- **AND** the reasons SHALL be both the truncated page (the limit is applied before the filter) and the data-access confinement rule

#### Scenario: The scope helper absorbs the lifecycle predicate

- **WHEN** a change adds the `status = 'active'` conditions to `endpointsInScope` so every caller inherits them
- **THEN** the change SHALL be rejected, because the sweep's aged-pending selection and the `admin*` reads share that helper and MUST keep returning retired-endpoint rows

#### Scenario: The pending count is rewritten as an arithmetic difference

- **WHEN** a change replaces `countPendingInScope`'s join-and-count with a difference of table-level counts
- **THEN** the change SHALL be rejected
- **AND** the reason SHALL be that the predicate reads `status` on the joined memory rows, which no count over `memory_relations` alone can observe — the schema fact behind the other relation-count rewrites does not extend to it
