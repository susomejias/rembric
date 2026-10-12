## MODIFIED Requirements

### Requirement: Structural privacy

The server-to-client recap payload and exported image SHALL contain only aggregate counts, year/timezone/scope labels, fixed memory categories, allow-listed entity kinds, anonymous project rank labels and allow-listed agent names. They SHALL NOT contain private content, memory/session titles, descriptions, tags, source metadata, record identifiers, project/token names, entity values or raw custom agent identifiers. Unknown agents SHALL be aggregated as `Other`. No public sharing endpoint or application-initiated third-party request SHALL be added. Native sharing SHALL occur only after an explicit user action.

#### Scenario: Private custom agent

- **WHEN** a session agent contains a private or arbitrary name
- **THEN** its count SHALL contribute to `Other` without emitting the original name

### Requirement: Accessible user-paced story

The recap SHALL render ten screens: introduction, totals, agent mix, memory categories, judgments, entities, projects, rhythm, monthly saves and sharing. The introduction SHALL show memories, sessions, judgments, active projects, active days and longest streak. The judgments screen SHALL show the retained decision total and counts by the fixed relation domain (supersedes, conflicts, compatible, related, scoped and not-conflict), never rationale, evidence or memory identities. It SHALL use left/right taps and timed story progress without visible previous/next controls consuming content height. Stories SHALL advance automatically every seven seconds, with a header pause/play control, press-and-hold pause, Space pause/play and keyboard arrows/Home/End. Keyboard navigation SHALL pause playback, background tabs SHALL pause, and the final sharing screen SHALL not advance automatically. Reduced motion SHALL default to paused playback. Controls SHALL be at least 44px; screen-reader navigation and keyboard-visible controls SHALL remain available, focus SHALL remain usable on navigation and closing SHALL return to overview. The year selector SHALL be a minimal integrated native select. The intro SHALL reuse the animated number ticker and add decorative motion without private content. The technical year/scope/timezone line SHALL not occupy visible header space; its semantics SHALL remain available to assistive technology. At the user's request, exported cards SHALL omit the year-to-date/all-projects/UTC caption while retaining the selected year. Neither the viewer nor exported image SHALL include promotional privacy footers such as "Only your numbers. Nothing private." or "Retained records. No private content."; retained-record semantics SHALL remain available to assistive technology. Large visible counts SHALL use compact notation with at most one fractional digit (for example 11.2k or 1.3M), shared between the viewer and exported image. The selected year SHALL remain unabridged. Accessible counter labels and chart details SHALL preserve the exact integer count. Reduced-motion preferences SHALL suppress animated movement. Empty and sparse years SHALL not fabricate highlights.

#### Scenario: Keyboard and reduced motion

- **WHEN** a visitor navigates with the keyboard and requests reduced motion
- **THEN** the selected screen SHALL change without motion while controls and focus remain usable

#### Scenario: No activity

- **WHEN** the selected year contains no saves, session starts or judgments
- **THEN** the recap SHALL display a clear insufficient-activity state with a route back and year selection

### Requirement: Exact native social sharing

The final screen SHALL primarily share through the device's native sharing sheet using a pre-generated PNG File, without awaiting image generation between the click and navigator.share. It SHALL provide Square 1080×1080 and Story 1080×1920 PNG cards with the existing logo, Geist fonts and palette. A static preview SHALL show the exact image shared, including real counts and the selected year, without technical or promotional privacy captions. Both formats SHALL include the entity total, a compact top-four entity-kind distribution plus Other when needed, and a visible partial-indexing note when coverage is incomplete. Image generation SHALL happen locally without a public URL or private information. A download SHALL be offered only as a fallback when native file sharing is unavailable. Cancellation SHALL not report an error; failed sharing SHALL offer retry. Failed generation SHALL show a recoverable error and SHALL NOT share an incomplete image.

#### Scenario: Share each format

- **WHEN** an admin selects a format and opens native sharing
- **THEN** the attached PNG File SHALL match the preview bytes and specified dimensions

#### Scenario: Timed and manual navigation

- **WHEN** playback is active, paused, backgrounded or the user taps a side
- **THEN** progress SHALL advance only during active foreground playback, pause and resume without resetting, and manual taps SHALL reset timing for the new screen without intercepting export controls

## ADDED Requirements

### Requirement: Annual entity aggregates

Entities SHALL count distinct (kind, value) pairs linked to retained memories created in the selected UTC year up to now, deduplicating across projects. Only schema-allow-listed kinds SHALL contribute. A recurring entity SHALL have links to at least two distinct included memories. Entity creation and scan dates SHALL NOT select the recap year. The payload SHALL contain only total, recurring count, distinct entity counts by kind, distinct memory counts by kind, and numbers of scanned and eligible project-linked memories in the year; no values or identifiers. For each kind, the memory count SHALL count each included memory once even when it mentions several entities of that kind. A memory mentioning multiple kinds SHALL contribute once to each kind. The scene SHALL reuse the sessions scene's lime pass for the kind with the most memories and its memory count, with EVERY remaining populated kind and its memory count in the shared bar list, without grouping types under Other. Dense lists SHALL remain accessible through existing content scrolling rather than be truncated. Total and recurring entity counts SHALL remain visible below with entity labels. Zero entities SHALL NOT fabricate a leading kind. The viewer SHALL sort by memory count descending then kind; the PNG distribution SHALL retain distinct-entity counts sorted descending then kind. Scan completion SHALL NOT be described as proof of successful extraction. Global memories SHALL NOT count toward scan eligibility. Unscanned eligible memories SHALL produce a visible scan-coverage note in both viewer and PNG. Fully scanned memories without links SHALL count toward coverage. Zero entities SHALL have a truthful empty state.

#### Scenario: Backfill and cross-project duplicates

- **WHEN** the same kind and value is linked to two included memories in different projects and indexing happened in a later year
- **THEN** it SHALL count as one entity and one recurring entity in the memories' year

#### Scenario: Memory counts are not entity counts

- **WHEN** three included memories mention Paths, one mentions two distinct Paths, and one also mentions a URL
- **THEN** Paths SHALL show three memories and URLs SHALL show one memory, without double-counting multiple Paths in one memory

#### Scenario: Partial indexing

- **WHEN** only two of three eligible project-linked memories have scan records
- **THEN** viewer and PNG SHALL disclose coverage of two out of three memories rather than present a complete total

#### Scenario: Excluded links and unknown kinds

- **WHEN** an entity is linked only to memories outside the year or in the future, or its kind is outside the fixed schema domain
- **THEN** it SHALL NOT contribute or expose its kind or value

### Requirement: Anonymous project distribution

The project scene SHALL preserve the existing active-project count and separately show memory saves grouped by non-null project ID, descending by count, with deterministic ties. Only four ranked counts and a remainder count SHALL leave the server. The viewer SHALL label them Project 1 through Project 4 and Other; these SHALL NOT be stable project aliases. A ranked stack of file cards SHALL show the distribution, reusing the visual treatment of the memory-category scene. Each card SHALL show its anonymous label and an accessible exact memory count; the leading card SHALL use the lime accent. The leading share SHALL use only project-linked memories as its denominator, explicitly labeled. Global memories SHALL NOT be labeled as a project. Session-only projects SHALL contribute to active projects but not the memory cards. An empty distribution SHALL show no percentage or fabricated leader.

#### Scenario: Anonymous ranking and remainder

- **WHEN** six projects have included memory saves, alongside global memories
- **THEN** the payload SHALL expose the four largest counts and sum of the other two, with no project identifiers or names, and percentages SHALL exclude global memories

#### Scenario: Session-only activity

- **WHEN** projects have included sessions but no included memory saves
- **THEN** they SHALL count as active projects and the scene SHALL show an empty memory distribution
