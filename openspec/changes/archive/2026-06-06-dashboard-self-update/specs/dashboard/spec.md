# dashboard Specification (delta)

## ADDED Requirements

### Requirement: The dashboard MUST surface update availability as a badge in the brand block

When the update check reports a newer version, the dashboard SHALL render an update badge adjacent to the running-version line in the brand block (sidebar, mobile bar) showing the latest available version. The badge SHALL persist across visits until the deployment runs the newer version and SHALL NOT be affected by modal dismissal. When no update is available, or the update check is disabled or failed, no badge SHALL render.

#### Scenario: Update available

- **WHEN** an authenticated operator loads any dashboard page while a newer version is known
- **THEN** the brand block SHALL show an update badge with the latest version next to the running version

#### Scenario: No update information

- **WHEN** the update check is disabled or has no result
- **THEN** the brand block SHALL render exactly as it does today (running version only)

### Requirement: The dashboard MUST present a per-version dismissable update modal with the release changelog

When a newer version is known and the operator has not dismissed that specific version, the dashboard SHALL present an update modal showing: current version → new version, the release publication time (via `formatTs`), the release changelog body rendered from the GitHub Release, and a link to the release on GitHub. A "Later" action SHALL dismiss the modal for that version only (client-side persistence); the next newer release SHALL re-trigger it. The modal's primary action SHALL depend on the self-update capability state:

- `available` — an update button that triggers the one-click flow
- `pinned` — no button; an explanation that the image tag is pinned and how to unpin
- `manual` — a copy-to-clipboard `docker compose pull && docker compose up -d` command and a link to `docs/updates.md` for enabling one-click

#### Scenario: First visit after a release

- **WHEN** an operator opens the dashboard and a newer, undismissed version exists
- **THEN** the update modal SHALL appear with the version diff, changelog, and the capability-appropriate action

#### Scenario: Dismissed version stays dismissed

- **WHEN** the operator chose "Later" for `0.22.0` and reloads the dashboard
- **THEN** the modal SHALL NOT reappear for `0.22.0`, while the brand badge remains

#### Scenario: Manual quadrant

- **WHEN** the modal renders with capability `manual`
- **THEN** it SHALL show the copy-paste update command and the docs link instead of an update button

### Requirement: The one-click update action MUST require a danger-tone confirmation

The one-click update trigger SHALL be a form protected by the dashboard's `data-confirm` modal with `data-confirm-tone="danger"`, and its confirmation copy SHALL state that the server will stop, replace its container, and restart, and that a database backup is taken first.

#### Scenario: Confirmation before update

- **WHEN** the operator clicks the update button
- **THEN** the danger-tone confirmation modal SHALL appear and no update SHALL start until confirmed

### Requirement: The dashboard MUST show update progress and reload itself on the new version

After a one-click update is confirmed, the dashboard SHALL show a progress view with discrete steps (backup, image pull with progress, service restart, version verification) updated by polling a status endpoint. While the server is restarting, connection failures SHALL be rendered as the restart step, not as errors. The page SHALL then poll a session-authenticated version endpoint and, once it answers with a version different from the one the page rendered with, SHALL reload automatically. If the update fails before the swap, the progress view SHALL show the failure reason; if it fails after the swap (rollback), the reloaded page SHALL surface that the previous version is still running.

#### Scenario: Successful update reloads on new version

- **WHEN** the upgrader completes and the replacement container becomes healthy
- **THEN** the operator's page SHALL detect the new version via polling and reload, showing the dashboard on the new version with the session still valid

#### Scenario: Failure before swap

- **WHEN** the backup or pull step fails
- **THEN** the progress view SHALL display the failure reason and the dashboard SHALL remain fully functional on the current version
