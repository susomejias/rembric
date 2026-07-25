## ADDED Requirements

### Requirement: Every consolidation op type MUST be classified as undoable or terminal, exhaustively

Undo currently enumerates terminal op types by literal comparison in two independent places — the service that performs the undo and the dashboard that decides whether to offer the button. An op type absent from both lists falls through to being marked reverted while its effect persists, which makes the journal report a revert that did not happen. `prompt_purge` is exactly that case today: the rows stay physically deleted and the operator is told the undo succeeded.

The classification SHALL come from a single exported set consumed by both the undo service and the dashboard guard. Every member of the op-type union SHALL fall into exactly one category — reactivating, terminal, orphan-promotion, or inert — and that exhaustiveness SHALL be asserted by an invariant test, so a newly-added op type cannot land in neither category.

#### Scenario: Undoing a prompt purge is refused

- **GIVEN** a journaled `prompt_purge` op
- **WHEN** an operator attempts to undo it
- **THEN** the attempt SHALL be refused as terminal and the op SHALL NOT be marked reverted

#### Scenario: The dashboard does not offer undo for a terminal op

- **GIVEN** a journaled `prompt_purge` op
- **WHEN** the operator views the run detail
- **THEN** the op SHALL be presented as terminal and no undo control SHALL be rendered

#### Scenario: A new op type must be classified

- **WHEN** a new consolidation op type is added to the union without being placed in a classification set
- **THEN** an invariant test SHALL fail and the build SHALL be rejected
