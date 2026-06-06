# Show server version in dashboard brand

## Why

Operators have no way to see which Rembric version their self-hosted instance is running without shelling into the container or inspecting the image tag. Surfacing the version in the dashboard brand block makes upgrade checks and bug reports a glance away.

## What Changes

- The brand block on all dashboard surfaces — desktop sidebar, mobile bar, and login page — renders the server version (e.g. `V0.21.1`) directly under `REMBRIC`, sourced from the existing `REMBRIC_VERSION` constant (`apps/server/src/version.ts`, read from `package.json` at boot).
- The `SELF-HOSTED` line is removed from all three brand surfaces; the version takes its row. (Operator decision 2026-06-06: version on login is acceptable disclosure for a self-hosted, VPN-fronted deployment; the leaner brand wins.)
- Zero new CSS: sidebar/mob-bar reuse `.label-stack small` styles (the mobile `·` separator comes from the existing `::before` rule); login reuses the existing `t-mono-up fg-dim` line styling.
- Collapsed sidebar hides the version along with the rest of `.label-stack` (existing behavior, unchanged).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `dashboard`: new requirement — the sidebar and mobile-bar brand MUST display the running server version and MUST NOT render `SELF-HOSTED`; modified requirement — the login brand mark's second mono line changes from `SELF-HOSTED` to the version.

## Impact

- `apps/server/src/dashboard/components.ts` — `renderSidebar` and `renderMobileBar`: `SELF-HOSTED` small replaced by `v${REMBRIC_VERSION}`.
- `apps/server/src/server/dashboard-router.ts` — `renderLogin`: `SELF-HOSTED` line replaced by the version line.
- `apps/server/src/dashboard/components.test.ts` and `apps/server/src/test/dashboard-e2e.test.ts` — assertions updated (version present, `SELF-HOSTED` absent).
- No DB, HTTP API, MCP, or plugin changes. No new dependencies. No load-bearing invariant touched.
