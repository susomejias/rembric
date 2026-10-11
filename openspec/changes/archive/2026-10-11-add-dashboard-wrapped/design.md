## Context

The approved OpenPencil journey uses Rembric's zinc/lime identity, Geist fonts and original logo. Mockup statistics are fictional. Dashboard login admits only instance-admin tokens; dashboard-only `admin*` repository reads are the existing boundary.

## Goals / Non-Goals

**Goals:** truthful yearly aggregates, privacy by construction, eight useful story-style screens, accessible motion and exact PNG previews.

**Non-Goals:** memory narratives, titles, tags, project names, account names, custom agent identifiers, rankings, savings estimates, public URLs, new dependencies, migrations or changes to MCP scope.

## Decisions

1. Read-only dashboard repository returns only counts, UTC day numbers, fixed memory categories and allow-listed agent labels. Unknown agents collapse into `Other` in SQL; no raw private field crosses the RSC boundary. Alternative: hydrate sessions/memories and redact afterward; rejected because it makes privacy depend on every caller.
2. Calendar year, defaulting to the previous UTC year in January and the current UTC year otherwise; current-year data stops at now. Include memories of every lifecycle status, exclude soft-deleted sessions, count projects that have an included save/session, and define an active day as a save, session start or retained judgment date. Judgments count retained relations currently judged, by judged_at rather than candidate creation, bounded by the selected year and now. Pending/orphaned/undated rows are excluded. Fixed relation-kind counts support a dedicated judgments screen; no reason or evidence is emitted. Repeated decisions on one row do not become an invented audit count. Streaks use distinct consecutive UTC days. Alternative: rolling year/local timezone; rejected because calendar years are simpler to explain and consistent between screen and export. Available years derive from retained activity, bounded to 1970 through current year.
3. Extend the baseline with memory category and monthly activity screens. No claims of productivity or inferred working hours. Zero-data years get a useful empty state; sparse years show accurate small counts instead of fabricated highlights.
4. Overview entry links to the recap during December and January UTC, or when the server environment variable `REMBRIC_WRAPPED_FORCE` is exactly `true`. A shared server-side season calculation keeps the overview and January default year aligned. The direct admin URL stays available year-round and explicit valid years still win. No client flag, auth bypass, scheduled job or persistence; runtime configuration is documented in `docs/wrapped.md`. No new top-level navigation entry. The recap is a route with its own focused story shell and an explicit close link to overview. Left/right taps and seven-second timed progression navigate without footer buttons. Pause/play lives in the header; holding pauses, background tabs pause, keyboard navigation pauses, reduced motion starts paused, and sharing is a stable final screen. Native buttons remain available to assistive technology and become visible only on keyboard focus. The native year select is borderless and integrated; technical metadata is screen-reader-only in the viewer, while exported cards omit that caption at the user's explicit request. After rejecting both the technical report and the sparse editorial iteration, the user selected the overview card as the reference: overlapping zinc/lime covers, angled memory layers, agent passes, category files, a decision card, a raised calendar and a monthly poster. No orbit graphics, floating mascots or decorative logo animation. Lime marks the headline data; Geist and Geist Mono retain Rembric identity. The static summary is a graphic invitation with the data as artwork, not recursive miniature cards: a tilted lime hero with a large memory count and proportional fixed-category bars, three supporting counts below, a real daily-activity matrix with active days and streak, and a lower section with the top agent and monthly saves. Category labels are shared with the viewer. Story has its own vertical spacing rather than reusing the crowded square composition; charts and typography remain separate. No privacy slogans or technical captions appear on the image; retained-record semantics remain screen-reader-only in the viewer. Compact numbers (11.2k, 1.3M) preserve legibility, while viewer counter labels and tooltips retain exact values. Existing Motion and NumberTicker provide restrained transitions, with reduced-motion alternatives.
5. Client-side Canvas renders one static image; display that same PNG as the preview and share that same Blob as a pre-built PNG File through navigator.share, preserving transient user activation. Download is only a compatibility fallback. Embed the original logo and load local fonts before drawing. Alternative: DOM screenshot package/server image endpoint; rejected because both add another rendering/data surface unnecessarily. Export failures stay actionable and don't download a partial image.

## Risks / Trade-offs

- [Risk] Counts reflect retained records, not an immutable historical audit → Label the recap as retained instance activity; lifecycle statuses do not remove saves and deleted sessions are excluded.
- [Risk] Custom agent names may contain private information → Normalize to fixed labels before leaving SQL and test a malicious/private agent name.
- [Risk] Current-year summaries can look like full-year claims → Clearly label year-to-date and UTC in the viewer and export.
- [Risk] Export font/image loads can fail → Await fonts and logo, show an error and allow retry; verify actual PNG dimensions in-browser.
- [Trade-off] Instance-wide statistics, not per-user/project → Accepted because this is the existing admin dashboard and the recap explicitly says all projects; counts contain no project identity.

## Migration Plan

No migration. Deploy with normal server build; rollback by reverting the feature. No stored Wrapped data or scheduled computation.

## Open Questions

None for this version. Additional screens require another meaningful measured aggregate.
