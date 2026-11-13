## ADDED Requirements

### Requirement: Archiving a project MUST close its pending judgments in the same transaction

Archiving project `P` SHALL, in the same transaction as the `archived_at` write, transition every `memory_relations` row whose endpoints belong to `P` from `pending` to `orphaned` with `marked_by_kind = 'consolidator'`, journaled as an archive orphaning (see the `consolidation` capability). If any step fails, the project SHALL remain unarchived and every judgment SHALL keep its status. Judgments that are `judged` or already `orphaned` SHALL NOT be touched. No memory row SHALL be written. The refusals for the default project and for an already-archived project are unchanged and SHALL leave every judgment untouched.

#### Scenario: Archiving closes the open judgments

- **GIVEN** project `P` with two pending judgments and one judged judgment
- **WHEN** the operator archives `P`
- **THEN** `P` SHALL be archived
- **AND** the two pending judgments SHALL be `orphaned` and the judged one SHALL be unchanged

#### Scenario: A failed archive changes nothing

- **GIVEN** project `P` with pending judgments
- **WHEN** archiving `P` fails after the `archived_at` write but before the journal is complete
- **THEN** `P` SHALL remain unarchived and its judgments SHALL remain `pending`

#### Scenario: Other projects are untouched

- **GIVEN** projects `P` and `Q`, each with pending judgments
- **WHEN** the operator archives `P`
- **THEN** `Q`'s judgments SHALL remain `pending`

### Requirement: Unarchiving a project MUST restore the judgments its archiving closed

Unarchiving project `P` SHALL, in the same transaction as clearing `archived_at`, revert every non-reverted archive orphaning of `P`, whether written at archive time or by the boot reconciliation, under the existing `orphan_promote` undo rules:

- a relation that received a verdict after the orphaning SHALL keep it;
- a relation with an endpoint that is no longer `active` SHALL stay `orphaned`;
- every other relation SHALL return to `pending`, and its op SHALL be marked reverted.

Unarchiving a project with no such orphaning SHALL restore nothing and SHALL still succeed.

#### Scenario: Archive then unarchive leaves the queue as it was

- **GIVEN** project `P` with pending judgments `J1` and `J2`
- **WHEN** the operator archives `P` and then unarchives it
- **THEN** `J1` and `J2` SHALL be `pending`
- **AND** the archive orphan ops SHALL be marked reverted

#### Scenario: Judgments closed by the boot reconciliation are restored too

- **GIVEN** an archived project `Z` whose pending judgments were closed by the process-start reconciliation
- **WHEN** the operator unarchives `Z`
- **THEN** those judgments SHALL be `pending`

#### Scenario: An endpoint retired while archived keeps its judgment closed

- **GIVEN** archived project `P`, a judgment orphaned by its archiving, and one endpoint of that judgment archived from the dashboard since
- **WHEN** the operator unarchives `P`
- **THEN** that judgment SHALL remain `orphaned` and its op SHALL remain non-reverted
- **AND** every other archive orphaning of `P` SHALL be restored

#### Scenario: A second archive cycle only touches what is open

- **GIVEN** project `P` archived, unarchived, and then given a verdict on one restored judgment
- **WHEN** the operator archives `P` again
- **THEN** only the judgments that are `pending` at that moment SHALL be orphaned, in a new `maintenance` run
