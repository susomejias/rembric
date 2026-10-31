## ADDED Requirements

### Requirement: Hermes background requests retain their initialized profile binding

Hermes session workers SHALL be created with `agent.memory_provider.spawn_context_thread` and explicitly started. Before dispatch, the provider SHALL capture the initialized server, bearer token, resolved slug and session id; summary and turn requests SHALL use that captured binding even after the caller's secret scope exits or the instance switches sessions. Workers SHALL NOT resolve credentials or fall back to process environment. Failure to create/start the context-preserving worker SHALL emit a safe visible diagnostic and skip the work without raising into the host. Existing summary/turn bodies, lock discipline, session routing and lifecycle suppression SHALL remain unchanged.

#### Scenario: Worker runs after caller scope exits

- **WHEN** a profile queues a sync worker and its secret scope exits before that worker runs
- **THEN** both summary and turn POSTs SHALL retain the queued profile's server, token, slug and session id
- **AND** the worker SHALL execute under the context copied by Hermes' thread factory

#### Scenario: Context thread API fails

- **WHEN** the required thread factory is missing or creation/start raises
- **THEN** no bare-thread or environment fallback SHALL run
- **AND** a diagnostic without raw exception text or credentials SHALL be visible without interrupting the host
