## Context

`handleContext` builds `recentSessions[]` from `{id, agent, startedAt, endedAt, status, summary}`. The session `title` exists on the row (`recentForContext` returns full rows) but is not surfaced. Titles start as an auto placeholder (`computePlaceholderTitle` → `basename(cwd) · HH:MM UTC`, `title_final = false`) and become curated (`title_final = true`) when the agent calls `memory.session_summary({ title })`.

## Goals / Non-Goals

**Goals:**

- Give the agent a scannable per-session headline in `memory.context` to complement the summary snippet.

**Non-Goals:**

- Filtering/transforming the title: it is passed through verbatim (no hiding placeholders, no truncation).
- Any change to storage, the title write/precedence path, or `memory.session_get`.

## Decisions

**Decision 1 — Surface `title` always, verbatim (`s.title`), with no filtering/hiding logic.**
Pass the stored title through as-is: a curated title when the agent set one, the auto-placeholder otherwise, and `null` if it were ever null. No conditional on `title_final`, no special-casing of placeholders.

- _Why:_ simplicity and honesty — the title is what it is; the consumer (agent/operator) decides what to do with it. A placeholder (`basename(cwd) · HH:MM UTC`) still orients (project + time) and costs almost nothing.
- _Alternative — curated-only (`title_final ? title : null`):_ rejected. It hides information to avoid mild redundancy with `startedAt`/scope, but that "weird hide logic" is not worth it; if a title is empty it just comes back empty, no machinery.
- _Alternative — `title` + a `titleFinal` boolean:_ rejected; unnecessary surface for the agent.

**Decision 2 — `title` is emitted complete and untruncated, NOT snippet-truncated.**
It is bounded to ≤100 chars at write time, well under `CONTEXT_SNIPPET_CHARS` (350). It is a short label, not long-form text, so the snippet helper does not apply — `memory.context` returns the full title.

## Risks / Trade-offs

- **[Trade-off] Placeholder titles (`project · HH:MM`) appear for uncurated sessions** → Accepted by design: they mildly orient and cost ~nothing; no hiding logic is preferable to a special case.
- **[Risk] A consumer assumes `title` is always a non-null string** → Mitigated: documented as a pass-through (nullable in principle); `memory.context` consumers already handle `summary: null`, so nullable string fields are an established shape.

## Migration Plan

None. Pure read-side addition of one field to the `recentSessions` mapping. Rollback = revert the one-line change.
