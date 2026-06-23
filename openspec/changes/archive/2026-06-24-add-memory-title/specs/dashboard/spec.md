## MODIFIED Requirements

### Requirement: Memory detail MUST display the history chain

The `/dashboard/memories/:id` view SHALL display the memory's title, content, status, tags, scope, project, source, current confirmation count, and a visualization of the `replaces` chain showing all predecessors with their titles, content snapshots, and timestamps. The page heading SHALL be the memory's `title` (not its id); the id SHALL remain available as a secondary metadata chip. For an `active` head whose type has a review TTL, the view SHALL additionally display the derived `reviewState` and `reviewAfter` (the latter rendered via the shared timestamp helper); these fields SHALL be omitted when the head is not `active` or its type has no TTL.

#### Scenario: Viewing a merged memory

- **WHEN** the operator opens the detail view for a merged memory M
- **THEN** the page SHALL show M's title as its heading, M's content, M's predecessor ids with their titles and content snapshots ordered chronologically, and an "Archive" action

#### Scenario: Viewing a memory that needs review

- **GIVEN** an `active` memory whose derived `reviewState = 'needs_review'`
- **WHEN** the operator opens its detail view
- **THEN** the metadata block SHALL show `reviewState = needs_review` and the `reviewAfter` timestamp (via the shared timestamp helper)

#### Scenario: The detail heading is the title, not the id

- **WHEN** the operator opens any memory's detail view
- **THEN** the page heading SHALL render the memory's `title`, and the memory id SHALL appear only as a secondary metadata chip

## ADDED Requirements

### Requirement: Memory and judgment views MUST display the title

Wherever the dashboard lists or links to a memory, it SHALL show that memory's `title` as the primary label: the `/dashboard/memories` list rows, the predecessor entries on the detail view, and the source/target memory references on the judgment-queue (`/dashboard/judgments`) and judgment detail views. These labels SHALL use the stored `title` rather than a truncated `content` snippet.

#### Scenario: The memories list shows titles

- **WHEN** the operator opens `/dashboard/memories`
- **THEN** each row SHALL display the memory's `title` as its primary label rather than a `content` truncation

#### Scenario: The judgment queue shows titles

- **WHEN** the operator opens `/dashboard/judgments` and a relation references a source and target memory
- **THEN** each referenced memory SHALL be labelled by its `title` rather than a `content` truncation
