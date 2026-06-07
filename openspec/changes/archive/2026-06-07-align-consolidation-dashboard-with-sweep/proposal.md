# Proposal: align-consolidation-dashboard-with-sweep

## Why

`remove-llm-consolidation` (archived 2026-06-05) replaced the nightly LLM cron with a deterministic lazy sweep, but scoped out the dashboard beyond the trigger rename. The dashboard still narrates the old system: the home "Consolidation health" section renders a NEXT RUN time read from `CONSOLIDATION_CRON` — an env var in `REMOVED_ENV_VARS` — with a hardcoded `03:00 UTC` fallback (there is no cron), a MODEL cell that is permanently `—` for new runs, and an "AUTO-PROMOTED FROM PENDING > 96H" caption whose verb and threshold both belong to the removed LLM judge. The archived proposal also promised "the manual dashboard trigger remains" and `http.ts:54` claims a dashboard button exists, but no such button was ever wired — the only manual trigger is `curl` with an admin bearer token, contradicting the operator-surface-is-the-dashboard posture.

## What Changes

- Home "Consolidation health" section (`apps/server/src/server/dashboard-router.ts`): replace the NEXT RUN / MODEL cell with the real trigger model (on session start, throttled per scope, manual from the consolidation view); fix the orphaned-pendings caption to describe deterministic deadline orphaning using the **configured** thresholds (`JUDGMENT_ORPHAN_AFTER_MS`, `JUDGMENT_ORPHAN_DEADLINE_MS`), not hardcoded copy; render the last-run scope as a project slug instead of a raw `project:<ULID>` string; stop selecting `llm_model`.
- Consolidation list (`apps/server/src/dashboard/consolidation.ts`): drop the `model` column (always `—` for post-LLM runs); add a `RUN SWEEP NOW` button — confirmation modal, `warn` tone (journaled + reversible) — posting to a new dashboard route; update the empty-state copy to point at the button instead of the admin `curl`.
- New route `POST /dashboard/consolidation/run`: dashboard-session + CSRF gated, invokes the existing forced sweep (`runner.runAll({ force: true })`). The admin endpoint `POST /admin/consolidation/run` is unchanged (automation surface). A browser form cannot set an `Authorization` header, hence the dedicated route.
- Run detail: render the `Model` stat card only when `llm_model IS NOT NULL` (legacy qwen runs keep their provenance visible; new runs show no dead cell); render the sweep summary JSON (`{"archives":N,"orphaned":M}`) as legible text, falling back to raw text for legacy LLM prose.
- Seed refresh (`apps/server/src/scripts/seed-dev.ts`): rewrite the two fictional texts that teach the removed cron model (`CONSOLIDATION_CRON`, "nightly at 03:00 UTC").

No schema migration. Append-only journal untouched — `llm_model` stays in the DB; this change only stops rendering it unconditionally.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard`: the home consolidation-health section MUST describe the lazy sweep trigger model and MUST NOT reference removed scheduling/LLM configuration; a manual sweep trigger MUST be available from `/dashboard/consolidation` (CSRF-protected, confirmation-gated); run views MUST NOT render an unconditional model column/cell.

## Impact

- `apps/server/src/server/dashboard-router.ts` — home health section markup + query (drop `llm_model`, resolve scope slug); dashboard deps gain the configured orphan thresholds and a sweep trigger.
- `apps/server/src/dashboard/consolidation.ts` — model column removal, `RUN SWEEP NOW` form + `POST /run` route, empty-state copy, conditional model card, legible summary render.
- `apps/server/src/server/bootstrap.ts` — wire the forced-sweep trigger (already built for the admin endpoint) into the dashboard router deps.
- `apps/server/src/scripts/seed-dev.ts` — two stale fictional texts.
- Tests: new route (session gate, CSRF gate, runner invoked with force) plus presentation asserts where router tests exist.
- Out of scope: admin endpoint behavior, sweep semantics, `consolidation` spec requirements, design tokens, CSS (existing `.health` and table styles reused).
