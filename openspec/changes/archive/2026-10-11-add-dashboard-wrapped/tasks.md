## 1. Privacy-safe statistics

- [x] 1.1 Add repository integration tests for UTC/year boundaries, retained memory statuses, deleted sessions, project counts, allow-listed agents and no private payload fields; observe RED then GREEN.
- [x] 1.2 Implement bounded read-only aggregates and distinct-day/streak/month calculations; mutation-check the exclusion guards.

## 2. Recap and export

- [x] 2.1 Add the authenticated yearly route and overview entry, verifying year selection and empty activity.
- [x] 2.2 Implement the eight-screen visual direction with lateral taps, seven-second autoplay, pause/hold/background handling, accessible keyboard controls and reduced motion. Remove visible navigation row and integrate the year selector.
- [x] 2.3 Implement compact visual Story/Square PNG summaries and native file sharing using existing fonts/logo; verify dimensions, activation, cancellation/retry and preview/shared byte identity. Download only when native file sharing is unsupported.

- [x] 2.4 Add judged-at-bounded decision totals and fixed kind breakdowns; include judgment-only years, six introduction metrics and judgment counts in both exports. Verify privacy, boundary exclusions and the absence of the removed PNG caption.

- [x] 2.5 Show the overview card only during December/January UTC or with `REMBRIC_WRAPPED_FORCE=true`; default January to the previous year, preserve year-round direct admin access, document runtime configuration and test date/flag/auth boundaries.

## 3. Verification

- [x] 3.1 Run focused tests, invariants, full tests, typecheck, lint and a production build without interrupting the user's development server (isolated build output or an explicitly approved restart). Final global lint, typecheck (7 tasks), full tests (4 tasks plus 97 Python tests) and isolated Turbopack production build pass; built-server probes verify forced/unforced card visibility and authenticated direct access.
- [x] 3.2 Verify desktop/mobile navigation, keyboard/focus, year selection, reduced motion, privacy and exports through the local browser and Next.js MCP. Reproducible story/share API checks: `AGENT_BROWSER_SESSION=<authenticated-local-session> node scripts/check-wrapped-browser.mjs`; native OS share-sheet handoff still requires manual device verification.
