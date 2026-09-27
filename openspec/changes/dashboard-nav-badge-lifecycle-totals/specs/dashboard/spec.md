## MODIFIED Requirements

### Requirement: The Memories nav entry MUST surface a lifecycle-total count badge

The dashboard's `MEMORIES` navigation entry SHALL display a count badge reporting the number of `active` memory rows in the corpus — the total excluding rows retired from the memory lifecycle (`superseded`, `archived`). This is the dashboard-wide badge convention: every nav badge is a lifecycle total (rows not retired), not a backlog counter, so the badge reconciles with the total the memories list view reports and can page through server-side. The badge SHALL be omitted (not rendered as `0`) when the count is zero. This SHALL NOT introduce a new stat card on the `/dashboard` overview page — the overview's six-card stat strip and its deliberate exclusion of backlog-style counters (see "The dashboard home page MUST include a sessions counter") are unchanged.

This requirement deliberately supersedes the earlier needs-review badge semantics: the owner decided on 2026-09-27 that nav badges report lifecycle totals rather than the needs-review backlog the previous text mandated. The needs-review figure remains visible where it belongs — in the memories list header ("N total · M active · K need review") — and is reachable as the `review` filter of the list view.

#### Scenario: Nav badge reflects the active-memory total

- **GIVEN** 3 `active` memories, 5 `superseded` and 2 `archived` memory rows in the corpus
- **WHEN** any authenticated operator loads any dashboard page
- **THEN** the `MEMORIES` nav entry SHALL display a badge reading `3`

#### Scenario: Nav badge is omitted when there are no active memories

- **GIVEN** zero `active` memories in the corpus, with `superseded` and `archived` rows present
- **WHEN** any authenticated operator loads any dashboard page
- **THEN** the `MEMORIES` nav entry SHALL render with no badge

#### Scenario: Nav badge excludes retired rows even when they dominate the corpus

- **GIVEN** 10 `active` memories and 1,690 rows whose `status` is `superseded` or `archived`
- **WHEN** any authenticated operator loads any dashboard page
- **THEN** the `MEMORIES` nav entry SHALL display a badge reading `10`, not `1,700`
