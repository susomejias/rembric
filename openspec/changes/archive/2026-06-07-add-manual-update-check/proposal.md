# Proposal: add-manual-update-check

## Why

The release check runs lazily at most once per 24 hours, so an operator who learns a new version shipped (release announcement, GitHub notification) can wait up to a day before the dashboard reflects it — and there is no way to force a check. Worse, when no update is known there is no visible path to `/dashboard/update` at all: the brand-block badge only renders once a newer version is already cached, so the page where a manual check would live is reachable only by typing the URL.

## What Changes

- New `POST /dashboard/update/check` dashboard route (session + CSRF) that forces an immediate release check, bypassing the 24-hour interval, then redirects back to `/dashboard/update`. If the check finds a newer version, the existing "Update Available" view renders; otherwise a flash reports the outcome ("still up to date" vs. "check failed to reach GitHub").
- `UpdateCheckService` gains an operator-initiated force-check path that reports its outcome (`update` / `none` / `error`) instead of swallowing failures — the silent-failure contract stays intact for the automatic background path only. It also exposes the last-checked timestamp.
- "CHECK NOW" button on the up-to-date state of `/dashboard/update`, alongside a "Last checked" line (`formatTs`). Hidden when `REMBRIC_UPDATE_CHECK=off`.
- The brand-block update slot (sidebar + mobile bar) becomes persistent: when a newer version is known it renders the existing lime `UPDATE v<latest>` badge (unchanged); when none is known it renders a quiet `UP TO DATE ›` link to `/dashboard/update`. When the check is disabled, the slot renders nothing (as today).

No schema changes, no MCP changes, no new dependencies, no change to the one-click execution path or capability detection.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `self-update`: the update-check requirement gains an operator-initiated manual check that bypasses the 24-hour window (still ETag-aware, still ≤1 concurrent request); the silent-failure contract is scoped to the automatic path, with the manual path reporting its outcome to the operator.
- `dashboard`: the brand-block update slot becomes persistent (quiet `UP TO DATE` link when no update is known, existing badge when one is, nothing when the check is disabled); `/dashboard/update`'s up-to-date state gains the CHECK NOW action and a last-checked timestamp.

## Impact

- `apps/server/src/services/update-check.ts` — force-check method with outcome reporting; `lastCheckedAt` exposure.
- `apps/server/src/dashboard/update.ts` — `POST /check` route; CHECK NOW form, last-checked line, and outcome flash on the up-to-date state.
- `apps/server/src/dashboard/update-modal.ts` — `updateShellExtras` / new quiet-slot renderer for the no-update state.
- `apps/server/src/server/dashboard-router.ts` — thread the persistent slot through the page shell (today `badge` is `null` when no update).
- `apps/server/src/dashboard/components.ts` — none expected (slot is injected via the existing `update` option); CSS for the quiet slot state in `apps/server/src/dashboard/styles/` (no inline styles, locked design tokens).
- Tests co-located with each of the above.
