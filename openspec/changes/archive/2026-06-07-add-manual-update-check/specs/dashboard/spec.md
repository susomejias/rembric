# dashboard — delta for add-manual-update-check

## MODIFIED Requirements

### Requirement: The dashboard MUST surface update availability as a badge in the brand block

When the update check reports a newer version, the dashboard SHALL render an update badge adjacent to the running-version line in the brand block (sidebar, mobile bar) showing the latest available version. The badge SHALL persist across visits until the deployment runs the newer version and SHALL NOT be affected by modal dismissal.

When no newer version is known and the update check is enabled, the same brand-block slot SHALL render a quiet link (muted styling, no lime accent) to `/dashboard/update`, so the update page is always reachable from the shell. When the update check is disabled (`REMBRIC_UPDATE_CHECK=off`), the slot SHALL render nothing.

#### Scenario: Update available

- **WHEN** an authenticated operator loads any dashboard page while a newer version is known
- **THEN** the brand block SHALL show an update badge with the latest version next to the running version

#### Scenario: No update known, check enabled

- **WHEN** an authenticated operator loads any dashboard page while no newer version is known and the update check is enabled
- **THEN** the brand-block slot SHALL render a quiet link to `/dashboard/update` in place of the badge

#### Scenario: Check disabled

- **WHEN** `REMBRIC_UPDATE_CHECK=off` is set
- **THEN** the brand-block slot SHALL render neither a badge nor a quiet link

## ADDED Requirements

### Requirement: The update page MUST offer a manual check with an honest outcome

The up-to-date state of `/dashboard/update` SHALL render a CSRF-protected form that triggers the manual release check and, when a check has run in the current process lifetime, a last-checked timestamp rendered via `formatTs`. After the manual check: if a newer version was found, the page SHALL render the existing update-available view; if no newer version is known, the page SHALL show a flash stating the deployment is still up to date; if the check could not reach the GitHub API, the page SHALL show an error flash that names the failure (distinct from "up to date") and notes this is expected on air-gapped hosts. The manual-check form SHALL NOT render when the update check is disabled; a disabled note naming `REMBRIC_UPDATE_CHECK=off` SHALL render instead, and the page SHALL NOT claim the deployment is up to date (the server never checks, so it cannot know). The manual check action SHALL NOT require a `data-confirm` modal (read-only, reversible).

#### Scenario: Manual check finds an update

- **WHEN** the operator triggers the manual check and a newer release exists
- **THEN** `/dashboard/update` SHALL render the update-available view (version diff, changelog, capability-appropriate action) and the brand-block badge SHALL appear on subsequent page loads

#### Scenario: Manual check, still up to date

- **WHEN** the operator triggers the manual check and no newer release exists
- **THEN** `/dashboard/update` SHALL show a flash stating no newer version is known and remain on the up-to-date state

#### Scenario: Manual check fails

- **WHEN** the operator triggers the manual check and the GitHub API is unreachable
- **THEN** `/dashboard/update` SHALL show an error flash that distinguishes the failure from being up to date

#### Scenario: Check disabled hides the action

- **WHEN** `REMBRIC_UPDATE_CHECK=off` is set and the operator opens `/dashboard/update`
- **THEN** the page SHALL NOT render the manual-check form
