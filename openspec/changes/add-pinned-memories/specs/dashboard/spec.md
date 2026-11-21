## ADDED Requirements

### Requirement: The memory views MUST show, filter and change pin state

The `/dashboard/memories` list SHALL mark every row that derives as pinned (see the `memory` capability) with a `pinned` badge rendered by the dashboard's shared badge component, and SHALL offer a `pinned` filter control with values `(any)` (default) and `pinned`. With `pinned` selected the list SHALL show only memories that derive as pinned, filtered server-side so pagination and the `TOTAL` chip stay exact, respecting the current project filter and preserving every active filter across pagination. Each row SHALL offer a pin or unpin action for an `active` memory.

The `/dashboard/memories/:id` view SHALL show the derived pin state of the memory, SHALL offer a pin action for an unpinned `active` memory and an unpin action for a pinned one, and SHALL render a pin history listing every `memory_pin_events` row of the memory in order, each with its action, cause, actor when present, and timestamp rendered via the shared timestamp helper. A memory with no pin events SHALL render no pin history section.

Pin and unpin SHALL be Server Actions that call `MemoryService.setPinned` with the operator as actor, scoped to the memory's own project. They are reversible and not destructive, so they SHALL NOT be gated by the confirmation modal. A refusal by `PIN_MAX_PER_PROJECT` SHALL be shown to the operator naming the current pins, and SHALL change nothing.

#### Scenario: A pinned memory carries the badge and matches the filter

- **GIVEN** a pinned memory `M` and an unpinned memory `N` in the same project
- **WHEN** the operator opens `/dashboard/memories?pinned=1`
- **THEN** `M` SHALL be listed with the `pinned` badge and `N` SHALL NOT be listed
- **AND** the `TOTAL` chip SHALL count only pinned memories under the active filters

#### Scenario: The operator pins and unpins from the detail view

- **GIVEN** an unpinned `active` memory `M`
- **WHEN** the operator submits the pin action on `/dashboard/memories/M`, then the unpin action
- **THEN** `M` SHALL derive as pinned after the first and as unpinned after the second
- **AND** the pin history SHALL list a `pin` and then an `unpin` row, both with an operator cause

#### Scenario: An automatic release is visible in the history

- **GIVEN** a pinned memory `M` that was archived
- **WHEN** the operator opens `/dashboard/memories/M`
- **THEN** the pin history SHALL list the `unpin` row with cause `archive`

#### Scenario: The count bound applies to the operator

- **GIVEN** a project holding `PIN_MAX_PER_PROJECT` pinned memories
- **WHEN** the operator submits the pin action for another memory of that project
- **THEN** the page SHALL report the refusal naming the current pins, and nothing SHALL be pinned
