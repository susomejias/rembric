# dashboard-wrapped Specification

## Purpose

Provide instance admins with a privacy-safe yearly usage recap, accessible story navigation and exact local PNG sharing, with seasonal dashboard promotion and a server-side visibility override.

## Requirements

### Requirement: Authenticated yearly recap

The dashboard SHALL expose `/dashboard/wrapped` year-round for authenticated instance admins, independently of promotional visibility. The overview entry SHALL appear from December 1 through January 31 inclusive, using UTC. The server environment variable `REMBRIC_WRAPPED_FORCE=true` SHALL also display the entry outside that window; any other value or an unset variable SHALL retain seasonal behavior. The flag SHALL NOT bypass authentication or affect data boundaries. The recap SHALL default to the previous UTC calendar year in January and to the current UTC year otherwise; an explicit valid `year` parameter SHALL override that default. Invalid or future years SHALL be replaced by the seasonal default year. The recap SHALL allow selection of years with retained activity and state that it covers all projects, UTC and retained records. Current-year recaps SHALL be labeled year-to-date.

#### Scenario: Access requires login

- **WHEN** an unauthenticated visitor requests the recap
- **THEN** they SHALL be redirected to dashboard login without receiving recap data

#### Scenario: Choose a previous year

- **WHEN** an admin selects a year
- **THEN** the recap SHALL use events in that UTC calendar year only, excluding future events

#### Scenario: Seasonal promotion and January rollover

- **WHEN** the UTC date crosses December 1, January 1 or February 1
- **THEN** the overview entry SHALL respectively appear, remain visible with the previous year as the recap default, or disappear; direct admin access SHALL remain available

#### Scenario: Force promotion outside the season

- **WHEN** the server runs with `REMBRIC_WRAPPED_FORCE=true` outside December and January
- **THEN** the overview entry SHALL appear and open the normal admin recap with real aggregate data; removing the flag SHALL restore seasonal behavior

### Requirement: Structural privacy

The authenticated server-to-client recap payload SHALL contain aggregate counts, year/timezone/scope labels, fixed memory categories, allow-listed entity kinds, allow-listed agent names and the ranked projects' display names with slug fallback. Project names SHALL be permitted only in the private viewer; exported images SHALL contain only aggregate project totals, never project names or project distribution labels. Neither surface SHALL contain private content, memory/session titles, descriptions, tags, source metadata, record identifiers, token names, entity values or raw custom agent identifiers. Unknown agents SHALL be aggregated as `Other`. No public sharing endpoint or application-initiated third-party request SHALL be added. Native sharing SHALL occur only after an explicit user action.

#### Scenario: Private custom agent

- **WHEN** a session agent contains a private or arbitrary name
- **THEN** its count SHALL contribute to `Other` without emitting the original name

#### Scenario: Names stay out of shared images

- **WHEN** the private viewer receives named project rankings and the admin exports Square or Story
- **THEN** the PNG SHALL show the active-project total without rendering any project name, slug or project ranking label

### Requirement: Truthful aggregate definitions

Memories saved SHALL count retained rows by creation time regardless of lifecycle status. Sessions SHALL count starts excluding soft-deleted rows. Judgments SHALL count retained relations currently marked `judged`, by `judged_at` within the selected UTC year and not after now; pending, orphaned and undated rows SHALL NOT count. This is a retained-row count, not an immutable audit of repeated decisions. Judgments SHALL appear alongside memories and sessions on the introduction and totals screens and in both exported formats. A year containing only judgments SHALL remain selectable and SHALL NOT appear empty. Active projects SHALL count distinct non-null project identifiers with an included save or session. An active day SHALL contain at least one included save, session start or judgment; the longest streak SHALL count consecutive distinct UTC days. Memory categories SHALL use the fixed schema domain; monthly bars SHALL count memory saves. Ties SHALL resolve deterministically. The system SHALL NOT invent savings, productivity estimates or user comparisons.

#### Scenario: Boundaries and deletion

- **WHEN** records fall before/after the selected year or sessions are soft-deleted
- **THEN** they SHALL NOT affect that year's statistics, while archived/superseded memories within it SHALL still count

#### Scenario: Consecutive activity

- **WHEN** saves and session starts overlap on the same UTC date
- **THEN** the date SHALL count once toward active days and streaks

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
