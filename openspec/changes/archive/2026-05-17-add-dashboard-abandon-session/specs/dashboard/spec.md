## ADDED Requirements

### Requirement: The dashboard MUST surface an Abandon action for active sessions

The list view at `/dashboard/sessions` SHALL render an inline `<form action="/dashboard/sessions/<id>/abandon" method="post">` per row whose `status === 'active'` AND `deleted_at IS NULL`, alongside the existing `Delete` form. The form SHALL include a CSRF input minted with the action token `'session.abandon'`, a `data-confirm` attribute reading `Mark this session as abandoned? Its <N> memories stay queryable and the row stays visible in the list. This transition is not reversible from the dashboard.` (where `<N>` is the per-row memory count already computed for the row), a `data-confirm-label` of `ABANDON SESSION`, and a `data-confirm-tone` of `warn`.

The submit button SHALL be styled `class="warn"` (matching the existing `class="warn"` convention for soft-destructive actions) and SHALL read `Abandon`. Rows whose `status` is `'ended'` or `'abandoned'`, or whose `deleted_at` is set, SHALL NOT render the Abandon form — the action is meaningful only on currently-active rows.

The handler at `POST /dashboard/sessions/:id/abandon` SHALL verify CSRF with action token `'session.abandon'`, call `agentSessions.markAbandoned(id, { adminBypass: true })`, and on success redirect to `/dashboard/sessions?abandoned=<id>` (URL-encoded). On `DomainError`, the handler SHALL re-render the sessions list page with a `flash error` body and the appropriate status code: `404` for `session_not_found`, `400` for every other `DomainError` code surfaced by the service (e.g. `session_already_ended`). The handler SHALL not surface raw exceptions to the operator.

The list view SHALL recognise the `?abandoned=<id>` query parameter and render it as a `flash success` banner reading `Session <code><id></code> marked as abandoned. <a href="/dashboard/sessions/<id>">View</a>.` The banner SHALL appear in the same position and styling as the existing `?deleted=` / `?restored=` banners.

The detail view at `/dashboard/sessions/:id` SHALL render the Abandon form in the action area when the row's `status === 'active'` AND `deleted_at IS NULL`. The form attributes SHALL match those used in the list view, with `<N>` computed from the count of memories already loaded for the detail page.

#### Scenario: Operator abandons an active session from the list view

- **GIVEN** an authenticated admin session and an `active` Rembric session row with id `<S>` and 12 memories
- **WHEN** the operator submits the row's Abandon form (after confirming the modal)
- **THEN** the response SHALL be a 302 redirect to `/dashboard/sessions?abandoned=<S>`
- **AND** the row's `status` SHALL be `'abandoned'`
- **AND** the row's `ended_at` SHALL be non-NULL
- **AND** a subsequent GET of `/dashboard/sessions` SHALL render the flash banner referencing `<S>`

#### Scenario: Abandon button is hidden for non-active rows

- **WHEN** the list view renders a row whose `status` is `'ended'` or `'abandoned'`
- **THEN** the row's actions cell SHALL NOT contain an Abandon form

#### Scenario: Abandon button is hidden for soft-deleted rows

- **WHEN** the list view renders a soft-deleted row (`deleted_at IS NOT NULL`)
- **THEN** the row's actions cell SHALL contain only the Undelete form — no Abandon form

#### Scenario: Abandon confirmation modal names the memory count

- **GIVEN** an active session row with 12 memories
- **WHEN** the operator triggers the Abandon form's submit
- **THEN** the global `#rbr-confirm` dialog SHALL open with copy containing the substring `Its 12 memories stay queryable`
- **AND** the confirm button SHALL read `ABANDON SESSION`
- **AND** the dialog SHALL use the `warn` tone styling

#### Scenario: Abandon without CSRF is rejected

- **GIVEN** an authenticated admin session
- **WHEN** a POST to `/dashboard/sessions/<S>/abandon` arrives without the `csrf` field
- **THEN** the response SHALL be `403` with the standard `csrf_invalid` body

#### Scenario: Abandoning an already-ended session surfaces an error

- **GIVEN** a session row with `status = 'ended'`
- **WHEN** a POST to `/dashboard/sessions/<S>/abandon` is made (e.g. via a stale form replayed after the row transitioned)
- **THEN** the response SHALL be `400` with a `flash error` body describing the `session_already_ended` condition
- **AND** the row's `status` SHALL remain `'ended'`
