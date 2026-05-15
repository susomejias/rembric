## Why

The dashboard renders every timestamp in UTC (e.g. `2026-05-15 16:35:12 UTC`), forcing every operator to do a mental TZ conversion. For a Spain-based operator on CEST that is `+2h`; for anyone on the road across multiple TZs the offset is worse. Storage stays UTC (ms-since-epoch), and machine-facing MCP responses keep `Z`-suffixed ISO-8601 — but the human-facing dashboard should show the operator's local time. The fix is small (the dashboard is the only human surface) and unblocks faster scanning of recent activity.

## What Changes

- `formatTs` helper in `src/dashboard/templates.ts` SHALL emit a server-rendered `<time datetime="...Z">` element with a deterministic UTC fallback as visible text, instead of a plain UTC string. **Every** dashboard page is in scope — memories, sessions, session detail, prompts, consolidation runs, projects, tokens, memory detail (`replaces` chain timestamps), and any future page that surfaces a timestamp.
- A small client-side script bundled with the dashboard layout SHALL upgrade every `<time data-rembric-ts>` element in place, formatting its `datetime` attribute via `Intl.DateTimeFormat` using the browser's timezone and locale.
- Operators with JS disabled, or before the script runs, SHALL still see a legible timestamp — the UTC string remains the SSR text content.
- No environment variable, no per-user setting, no server-side config change. The MCP wire format and the SQLite schema stay UTC.
- The project-level convention "dashboard renders timestamps via `formatTs`; never inline `toISOString()` or hand-built date strings" SHALL be documented in `CLAUDE.md` (project) and persisted as a rembric memory so future agents follow it without re-deriving the contract.

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `dashboard`: timestamp rendering becomes locale- and TZ-aware in the browser, with a UTC SSR fallback.

## Impact

- Affected code: `src/dashboard/templates.ts` (`formatTs`, layout `<script>` injection). All dashboard pages that surface timestamps (memories list, memory detail, sessions list/detail, prompts, consolidation runs, projects, tokens) inherit the change because they call `formatTs`.
- Unaffected: SQLite schema (still `timestamp_ms`), service layer (`new Date()`), MCP serialization (still ISO with `Z`), CLI output, log lines.
- Risk: very low. The change is additive on the SSR side (the UTC string remains the no-JS fallback) and isolated to one helper plus one script tag.
