# self-update — delta for add-manual-update-check

## MODIFIED Requirements

### Requirement: The server MUST check for new releases at most once per 24 hours, default-on with an opt-out

The server SHALL determine the latest published release of Rembric by querying the GitHub Releases API for the distribution repository, automatically at most once per 24-hour window, lazily (triggered by dashboard activity, not a timer), using conditional requests (ETag) where possible. The result SHALL be cached in memory together with the release changelog body. Setting `REMBRIC_UPDATE_CHECK=off` SHALL disable the check entirely. Any failure of the automatic check (network unreachable, rate-limited, malformed response) SHALL be silent: no error logs above debug level, no dashboard warnings, and all other functionality unaffected. Prerelease versions SHALL be ignored.

The 24-hour cadence bounds the automatic path only; an operator-initiated manual check (see the manual-check requirement) MAY run at any time and SHALL reset the window.

#### Scenario: New version detected

- **WHEN** the running version is `0.21.1` and the GitHub Releases API reports latest release `server-v0.22.0`
- **THEN** the server SHALL expose update availability (current version, latest version, publication date, changelog body) to the dashboard layer

#### Scenario: Check disabled by operator

- **WHEN** `REMBRIC_UPDATE_CHECK=off` is set
- **THEN** the server SHALL NOT contact the GitHub API and the dashboard SHALL render with no update badge or modal

#### Scenario: Air-gapped host

- **WHEN** the GitHub API is unreachable
- **THEN** the server SHALL behave as if no update is available, without surfacing errors or warnings to the operator

## ADDED Requirements

### Requirement: An operator MUST be able to force an immediate release check that reports its outcome

The server SHALL expose an operator-initiated manual check that performs the release query immediately, bypassing the 24-hour window, while reusing the conditional-request (ETag) cache and deduplicating against any in-flight check. Unlike the automatic path, the manual check SHALL report its outcome to the caller as one of: a newer version was found, no newer version is known, or the check failed to reach the GitHub API. The manual check SHALL be unavailable when `REMBRIC_UPDATE_CHECK=off`. The server SHALL expose the timestamp of the most recent check (manual or automatic) within the current process lifetime.

#### Scenario: Manual check finds a new release

- **WHEN** an operator triggers a manual check and the GitHub Releases API reports a release newer than the running version
- **THEN** the check SHALL report the update outcome and the cached update availability SHALL reflect the new release immediately

#### Scenario: Manual check on an up-to-date deployment

- **WHEN** an operator triggers a manual check and no newer release exists
- **THEN** the check SHALL report that no newer version is known, without claiming more than the API returned

#### Scenario: Manual check cannot reach GitHub

- **WHEN** an operator triggers a manual check and the GitHub API is unreachable or returns an error
- **THEN** the check SHALL report the failure outcome to the operator (distinct from "no newer version") while the automatic path's silent-failure behavior remains unchanged

#### Scenario: Manual check while disabled

- **WHEN** `REMBRIC_UPDATE_CHECK=off` is set
- **THEN** the manual check SHALL NOT contact the GitHub API and SHALL NOT be offered in the dashboard
