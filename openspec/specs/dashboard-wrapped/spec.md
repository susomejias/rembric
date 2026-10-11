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

The server-to-client recap payload and exported image SHALL contain only aggregate counts, year/timezone/scope labels, fixed memory categories and allow-listed agent names. They SHALL NOT contain private content, memory/session titles, descriptions, tags, source metadata, record identifiers, project/token names or raw custom agent identifiers. Unknown agents SHALL be aggregated as `Other`. No public sharing endpoint or application-initiated third-party request SHALL be added. Native sharing SHALL occur only after an explicit user action.

#### Scenario: Private custom agent

- **WHEN** a session agent contains a private or arbitrary name
- **THEN** its count SHALL contribute to `Other` without emitting the original name

### Requirement: Truthful aggregate definitions

Memories saved SHALL count retained rows by creation time regardless of lifecycle status. Sessions SHALL count starts excluding soft-deleted rows. Judgments SHALL count retained relations currently marked `judged`, by `judged_at` within the selected UTC year and not after now; pending, orphaned and undated rows SHALL NOT count. This is a retained-row count, not an immutable audit of repeated decisions. Judgments SHALL appear alongside memories and sessions on the introduction and totals screens and in both exported formats. A year containing only judgments SHALL remain selectable and SHALL NOT appear empty. Active projects SHALL count distinct non-null project identifiers with an included save or session. An active day SHALL contain at least one included save, session start or judgment; the longest streak SHALL count consecutive distinct UTC days. Memory categories SHALL use the fixed schema domain; monthly bars SHALL count memory saves. Ties SHALL resolve deterministically. The system SHALL NOT invent savings, productivity estimates or user comparisons.

#### Scenario: Boundaries and deletion

- **WHEN** records fall before/after the selected year or sessions are soft-deleted
- **THEN** they SHALL NOT affect that year's statistics, while archived/superseded memories within it SHALL still count

#### Scenario: Consecutive activity

- **WHEN** saves and session starts overlap on the same UTC date
- **THEN** the date SHALL count once toward active days and streaks

### Requirement: Accessible user-paced story

The recap SHALL render eight screens: introduction, totals, agent mix, memory categories, judgments, rhythm, monthly saves and sharing. The introduction SHALL show memories, sessions, judgments, active projects, active days and longest streak. The judgments screen SHALL show the retained decision total and counts by the fixed relation domain (supersedes, conflicts, compatible, related, scoped and not-conflict), never rationale, evidence or memory identities. It SHALL use left/right taps and timed story progress without visible previous/next controls consuming content height. Stories SHALL advance automatically every seven seconds, with a header pause/play control, press-and-hold pause, Space pause/play and keyboard arrows/Home/End. Keyboard navigation SHALL pause playback, background tabs SHALL pause, and the final sharing screen SHALL not advance automatically. Reduced motion SHALL default to paused playback. Controls SHALL be at least 44px; screen-reader navigation and keyboard-visible controls SHALL remain available, focus SHALL remain usable on navigation and closing SHALL return to overview. The year selector SHALL be a minimal integrated native select. The intro SHALL reuse the animated number ticker and add decorative motion without private content. The technical year/scope/timezone line SHALL not occupy visible header space; its semantics SHALL remain available to assistive technology. At the user's request, exported cards SHALL omit the year-to-date/all-projects/UTC caption while retaining the selected year. Neither the viewer nor exported image SHALL include promotional privacy footers such as "Only your numbers. Nothing private." or "Retained records. No private content."; retained-record semantics SHALL remain available to assistive technology. Large visible counts SHALL use compact notation with at most one fractional digit (for example 11.2k or 1.3M), shared between the viewer and exported image. The selected year SHALL remain unabridged. Accessible counter labels and chart details SHALL preserve the exact integer count. Reduced-motion preferences SHALL suppress animated movement. Empty and sparse years SHALL not fabricate highlights.

#### Scenario: Keyboard and reduced motion

- **WHEN** a visitor navigates with the keyboard and requests reduced motion
- **THEN** the selected screen SHALL change without motion while controls and focus remain usable

#### Scenario: No activity

- **WHEN** the selected year contains no saves, session starts or judgments
- **THEN** the recap SHALL display a clear insufficient-activity state with a route back and year selection

### Requirement: Exact native social sharing

The final screen SHALL primarily share through the device's native sharing sheet using a pre-generated PNG File, without awaiting image generation between the click and navigator.share. It SHALL provide Square 1080×1080 and Story 1080×1920 PNG cards with the existing logo, Geist fonts and palette. A static preview SHALL show the exact image shared, including real counts and the selected year, without technical or promotional privacy captions. Image generation SHALL happen locally without a public URL or private information. A download SHALL be offered only as a fallback when native file sharing is unavailable. Cancellation SHALL not report an error; failed sharing SHALL offer retry. Failed generation SHALL show a recoverable error and SHALL NOT share an incomplete image.

#### Scenario: Share each format

- **WHEN** an admin selects a format and opens native sharing
- **THEN** the attached PNG File SHALL match the preview bytes and specified dimensions

#### Scenario: Timed and manual navigation

- **WHEN** playback is active, paused, backgrounded or the user taps a side
- **THEN** progress SHALL advance only during active foreground playback, pause and resume without resetting, and manual taps SHALL reset timing for the new screen without intercepting export controls
