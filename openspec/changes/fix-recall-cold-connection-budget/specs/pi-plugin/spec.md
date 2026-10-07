## ADDED Requirements

### Requirement: Pi turn-start recall inherits the shared transport deadline

Pi SHALL call the shared `recallHints` function at turn start without overriding its default transport deadline. Returned hints SHALL still be merged into the model-facing turn context, and timeout SHALL still allow the turn to continue. Pi SHALL NOT add a local retry or keepalive mechanism for this path.

#### Scenario: A cold-connection hint reaches the turn context

- **GIVEN** a registered primary session and a healthy recall response which fits the shared default deadline including connection setup
- **WHEN** Pi handles turn start
- **THEN** the returned hints SHALL reach the model-facing context through the existing merge path
- **AND** the extension SHALL rely on the shared default, not a local 200 ms override

#### Scenario: Abandonment remains best-effort

- **GIVEN** the shared recall call returns an empty array after timeout
- **WHEN** Pi handles turn start
- **THEN** it SHALL continue without hint lines and SHALL NOT retry the recall POST
