## RENAMED Requirements

- FROM: `### Requirement: Anonymous project distribution`
- TO: `### Requirement: Project memory distribution`

## MODIFIED Requirements

### Requirement: Structural privacy

The authenticated server-to-client recap payload SHALL contain aggregate counts, year/timezone/scope labels, fixed memory categories, allow-listed entity kinds, allow-listed agent names and the ranked projects' display names with slug fallback. Project names SHALL be permitted only in the private viewer; exported images SHALL contain only aggregate project totals, never project names or project distribution labels. Neither surface SHALL contain private content, memory/session titles, descriptions, tags, source metadata, record identifiers, token names, entity values or raw custom agent identifiers. Unknown agents SHALL be aggregated as `Other`. No public sharing endpoint or application-initiated third-party request SHALL be added. Native sharing SHALL occur only after an explicit user action.

#### Scenario: Private custom agent

- **WHEN** a session agent contains a private or arbitrary name
- **THEN** its count SHALL contribute to `Other` without emitting the original name

#### Scenario: Names stay out of shared images

- **WHEN** the private viewer receives named project rankings and the admin exports Square or Story
- **THEN** the PNG SHALL show the active-project total without rendering any project name, slug or project ranking label

### Requirement: Project memory distribution

The project scene SHALL preserve the existing active-project count and separately show memory saves grouped by non-null project ID, descending by count, with deterministic ties. The authenticated viewer SHALL receive the four ranked counts with their project display names, falling back to slugs when display names are null, plus a remainder count labeled Other. Projects with identical display names SHALL remain separate; ties SHALL remain ordered by project ID. A ranked stack of file cards SHALL show the distribution, reusing the visual treatment of the memory-category scene. Each card SHALL show its real project name or Other label and an accessible exact memory count; the leading card SHALL use the lime accent. The leading share SHALL use only project-linked memories as its denominator, explicitly labeled. Global memories SHALL NOT be labeled as a project. Session-only projects SHALL contribute to active projects but not the memory cards. An empty distribution SHALL show no percentage or fabricated leader.

#### Scenario: Named ranking and remainder

- **WHEN** six projects have included memory saves, alongside global memories
- **THEN** the payload SHALL expose the four largest counts and sum of the other two, with the four project display names or fallback slugs but no internal project identifiers, and percentages SHALL exclude global memories

#### Scenario: Session-only activity

- **WHEN** projects have included sessions but no included memory saves
- **THEN** they SHALL count as active projects and the scene SHALL show an empty memory distribution

#### Scenario: Long and duplicate names

- **WHEN** projects have long or identical display names, or a project is named Other
- **THEN** each ranked card SHALL remain distinct, display its name as text, and keep the name and count readable without horizontal overflow
