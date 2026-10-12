## 1. Aggregates

- [x] 1.1 Add repository tests for cross-project deduplication, recurrence, year boundaries, scan coverage, anonymous ranking and privacy; observe RED then GREEN.
- [x] 1.2 Verify new filtering guards by weakening each condition independently.

## 2. Presentation

- [x] 2.1 Add entity and project scenes with truthful empty/partial states, exact accessible counts and no identifiers.
- [x] 2.2 Add compact entity data to both PNG formats and verify exported text and dimensions.

## 3. Validation

- [x] 3.1 Run focused tests, typecheck, lint and relevant full suites; validate OpenSpec.
- [x] 3.2 Verify desktop/mobile scene fit, navigation and PNG sharing in a local browser, then request operator visual feedback.

## Evidence

- Repository RED: four added tests failed on absent fields, four controls passed. GREEN: eight tests passed. The memory-per-kind correction separately failed two assertions before implementation and passed afterward.
- Fifteen SQL mutations caught: eleven initial guards plus distinct-memory counting, both time boundaries and the kind allow-list. Initial lower-bound mutations exposed missing old project-linked fixtures; corrected fixtures caught both. Source restored after each series.
- `pnpm test`, typecheck, lint and strict OpenSpec validation passed. Independent read-only verification passed eight repository tests and 24 web tests. A final independent pass verified the Story footer and page-boundary tests.
- Entity counters measure distinct memories per kind, not entity identities; multiple identifiers of one kind in a memory count once. Every populated kind remains visible. Unique/recurring entity totals and PNG identity counts remain separate.
- Operator feedback selected project file cards matching What you kept and an entity pass/bar list matching sessions. Subsequent spacing and counter-alignment corrections were measured in both scenes at 1470×812, 1280×720, 390×844 and 320×640: at least 20px card clearance and zero vertical counter-center offset. Desktop fits without scrolling; the smallest mobile viewport permits inner scrolling only.
- Full `scripts/check-wrapped-browser.mjs` passed with an explicitly authenticated restore key: autoplay, pause/hold, taps, keyboard, reduced motion, all ten scenes, and native-sharing API payload bytes, user activation, cancellation and retry. The operating system's native share sheet itself is not automated.
- The script now preserves the explicit restore key and disables saving borrowed state on every command. A boundary probe demonstrated that bare `--restore` selected an empty session and redirected to login; the explicit key retained authentication.
- Real PNG previews decoded as 1080×1080 and 1080×1920 and were visually inspected. Story footer clearance failed at 22px before correction; the final rendered text baselines leave 86px below Story and 50px below Square. Square coordinates are unchanged.
- Initial cached-dev payload failures were resolved by an operator-authorized server restart, without an application fallback. Initial native review was unavailable because of outdated managed assets; no harness sync was performed during implementation.
- Local demo fixtures were explicitly authorized and backed up separately. No fixture records, local databases, credentials or exported images are part of the source change.
