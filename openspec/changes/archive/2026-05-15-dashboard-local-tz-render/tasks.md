## 1. Update the timestamp helper

- [x] 1.1 Change `formatTs` in `src/dashboard/templates.ts` to return `SafeHtml` instead of `string`, emitting `<time datetime="${iso}" data-rembric-ts>${utc-fallback}</time>` for valid inputs and `raw('—')` for null/invalid inputs.
- [x] 1.2 Add a unit test in `src/dashboard/templates.test.ts` (create the file if it does not exist) covering: valid `Date` input emits `<time datetime data-rembric-ts>`, string/number inputs work, null and `NaN` Date return `—` with no `<time>` element, ISO is UTC, fallback text matches `YYYY-MM-DD HH:MM:SS UTC`.
- [x] 1.3 Run `pnpm run typecheck` and fix any breakage in dashboard modules caused by the return-type change (no string concatenation with the result; templates already accept `SafeHtml`).

## 2. Inject the client-side upgrader

- [x] 2.1 Add an inline `<script>` to the `<head>` of `shell()` in `src/dashboard/templates.ts` that queries `time[data-rembric-ts][datetime]` on `DOMContentLoaded` and after `htmx:afterSwap`, then sets `textContent` from `new Intl.DateTimeFormat(undefined, { year, month, day, hour, minute, second, hour12: false })`.
- [x] 2.2 Keep the script idempotent (always rewrite `textContent` from `datetime`) and resilient to `Invalid Date` (skip the node, leave the UTC fallback).
- [x] 2.3 Verify the script is included exactly once in every rendered page (grep the rendered HTML in an existing dashboard test, or add a fresh `shell()` unit test).

## 3. Verify every dashboard call site renders correctly

- [ ] 3.1 Start the dev server (`pnpm run dev` + `pnpm start`), open `/dashboard/memories`, `/dashboard/sessions`, `/dashboard/sessions/<id>` (incl. a soft-deleted session if available), `/dashboard/projects`, `/dashboard/consolidation`, `/dashboard/consolidation/<run-id>`, `/dashboard/relations`, `/dashboard/tokens`. Confirm: visible text is local-TZ in the browser, `view-source:` still shows UTC, and the `datetime=` attribute carries the ISO with `Z`.
- [ ] 3.2 Filter on memories list with HTMX → confirm the swapped rows also display local time.
- [ ] 3.3 Open one memory detail page that has a `replaces` chain → confirm every predecessor's timestamp is upgraded.

## 4. Tests

- [x] 4.1 Find existing assertions that match `' UTC'` in dashboard test files: `grep -rn "' UTC'\|\" UTC\"" src/dashboard/`. Update each so it asserts on the `datetime=` attribute (deterministic) instead of the visible text.
- [x] 4.2 Add an end-to-end-style test (or a `shell()`-level test) that asserts: rendering any timestamp emits `<time datetime="…Z" data-rembric-ts>…UTC</time>` and the `<head>` contains the upgrader script.

## 5. Document the convention

- [x] 5.1 Add a short subsection to `CLAUDE.md` (under "Architecture" → dashboard area, or a new "## Dashboard conventions" section near "Code style highlights") stating: "Dashboard templates MUST surface timestamps via `formatTs` from `src/dashboard/templates.ts`. Never inline `toISOString()`, `toLocaleString()`, or hand-formatted date strings in templates. The helper emits `<time data-rembric-ts>` with a UTC SSR fallback; an inline script in the layout localizes it via `Intl.DateTimeFormat`."
- [x] 5.2 (saved as `01KRPBMRQTHXCW6KTVZX3V1DMY`) Save a rembric memory: `mcp__plugin_rembric_rembric__memory_save` with `type=feedback`, `topic_key=dashboard-timestamp-convention`, content reflecting the same rule + the rationale + a pointer to `src/dashboard/templates.ts:formatTs` and this change folder.

## 6. Quality gates

- [x] 6.1 `pnpm run lint` clean.
- [x] 6.2 `pnpm run typecheck` clean.
- [x] 6.3 `pnpm test` green (coverage gate intact).
- [ ] 6.4 Manual screenshot of memories list with the new render included in the PR description for review.

## 7. Release

- [ ] 7.1 Conventional commit `feat(dashboard): render timestamps in viewer-local timezone`.
- [ ] 7.2 PR description references this change folder (`openspec/changes/dashboard-local-tz-render`) and links the design/spec.
- [ ] 7.3 After merge: run `/opsx:archive dashboard-local-tz-render` to move the change to `openspec/changes/archive/` and update `openspec/specs/dashboard/spec.md` with the ADDED requirement.
