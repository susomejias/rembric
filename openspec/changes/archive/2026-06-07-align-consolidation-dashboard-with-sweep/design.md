# Design: align-consolidation-dashboard-with-sweep

## Context

`remove-llm-consolidation` changed the engine; the dashboard kept narrating the old one. The mental model shift the UI must catch up with:

```
BEFORE (cron + LLM)                    NOW (lazy sweep)
───────────────────                    ─────────────────
"did it run last night?"      ──▶      "does it run when it should?"
"which model decided?"        ──▶      (nothing to ask — deterministic)
"when is the next run?"       ──▶      there is no schedule; triggers are:
"what did the LLM decide?"    ──▶      "how much decay/orphaning is happening?"
```

Sweep mechanics the UI must describe truthfully (`apps/server/src/consolidation/runner.ts`):

```
agent starts session ──▶ swept this scope within minInterval (6h)?
                              │ yes → skip (silent)
                              │ no  ▼
                        SWEEP (deterministic, two passes)
                        ├─ 1. decay: archive aged low-confidence rows
                        └─ 2. orphaning: 'pending' relations …
                              ├─ > JUDGMENT_ORPHAN_AFTER_MS    → re-exposed via memory.context
                              └─ > JUDGMENT_ORPHAN_DEADLINE_MS → 'orphaned' (journaled, undoable)
```

Stale surfaces found by audit:

| Surface                                     | Problem                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Home cell 4 (`dashboard-router.ts:484-490`) | reads `CONSOLIDATION_CRON` (in `REMOVED_ENV_VARS`) with `'03:00 UTC'` fallback; `MODEL` always `—`                                  |
| Home cell 3 caption                         | "AUTO-PROMOTED FROM PENDING > 96H" — LLM-era verb, stale threshold                                                                  |
| Home cell 1 sub                             | scope rendered as raw `project:<ULID>`                                                                                              |
| Runs list `model` column                    | `—` for every post-LLM run (3 legacy qwen rows are the only exceptions)                                                             |
| Run detail `Model` card                     | same                                                                                                                                |
| Run detail `Summary`                        | now raw JSON `{"archives":N,"orphaned":M}` (was LLM prose)                                                                          |
| Missing button                              | archived proposal promised "the manual dashboard trigger remains"; `http.ts:54` claims it exists; task 3.3 marked done; never wired |
| `seed-dev.ts:229,332`                       | fictional content teaching the cron model                                                                                           |

## Goals / Non-Goals

**Goals:**

- Every consolidation-related string the dashboard renders is true under the lazy-sweep model.
- Manual sweep trigger reachable from the dashboard (operator surface = dashboard, no CLI).
- Threshold copy driven by configured values, not literals — immune to future config changes.
- Legacy LLM-run provenance (the 3 qwen runs anchoring 4 real journaled ops) stays visible where it exists.

**Non-Goals:**

- No change to sweep semantics, throttle, thresholds, or the admin endpoint.
- No schema migration; `llm_model` column stays (append-only history).
- No new CSS or design tokens; reuse `.health`, table, and form styles.
- No redesign of the consolidation views beyond what truthfulness forces.

## Decisions

### D1 — Dedicated dashboard route for the manual trigger

`POST /dashboard/consolidation/run` inside `createConsolidationRouter`, gated by dashboard session + CSRF (`readFormAndVerifyCsrf`, same pattern as the undo routes in the same file), redirecting back to `/dashboard/consolidation`. `ConsolidationDeps` gains `triggerSweep: () => ConsolidationRunSummary`; `bootstrap.ts` passes the same `runner.runAll({ force: true })` lambda already built for the admin endpoint.

- _Alternative — form posts to `POST /admin/consolidation/run`_: rejected; a browser form cannot set the `Authorization` header that endpoint requires, and weakening the admin endpoint to accept cookies would conflate two auth models.
- _Alternative — HTMX call with token injection_: rejected; needs the admin token in page markup — a credential leak into HTML for zero benefit over a plain form.

### D2 — Confirmation tone `warn`, not `danger`

A forced sweep only archives via journaled, undoable ops (and orphans relations, also journaled). Per the dashboard spec's tone rule, reversible ⇒ `warn`.

### D3 — Trigger cell replaces NEXT RUN / MODEL

Static copy `TRIGGER · ON SESSION START` with sub `THROTTLED 6H / SCOPE · MANUAL FROM CONSOLIDATION`.

- _Alternative — computed "next eligible" timestamp (`finished_at + 6h`)_: rejected; the throttle is per scope, so a single home timestamp would be wrong for every scope except the last-swept one.

### D4 — Threshold copy reads config

The orphaned-pendings caption renders `JUDGMENT_ORPHAN_AFTER_MS` / `JUDGMENT_ORPHAN_DEADLINE_MS` formatted from the resolved config, threaded into the dashboard router deps. Hardcoding "24H"/"14D" would recreate exactly the bug this change fixes the moment an operator tunes the env vars.

- _Alternative — generic copy with no numbers_: workable but strictly less useful; the values are already resolved at boot, threading them is cheap.

### D5 — Model rendering: conditional in detail, gone from list

Run detail renders the `Model` stat card only when `llm_model IS NOT NULL` — the 3 legacy qwen runs keep their provenance (they anchor the only real journaled ops from the LLM era), new runs show no dead cell. The list column is removed outright: a column that is `—` for 99% of rows doesn't pay for its width; provenance lives one click away.

### D6 — Summary render parses the new shape, falls back for legacy

Sweep runs write `summary = JSON.stringify({archives, orphaned})`. Detail view parses; on success renders "N archived · M orphaned", on parse failure renders the raw text (legacy LLM prose). No data rewrite — append-only.

### D7 — Scope slug resolution in SQL

`consolidation_runs.scope` is `'global'` or `'project:<ULID>'`. The home query LEFT JOINs `projects` on `substr(scope, 9)` to render the slug (`project:my-app` → `MY-APP`), falling back to the raw string for unknown ids (deleted projects).

## Risks / Trade-offs

- [Risk] Forced sweep from the dashboard runs synchronously in the request → Mitigation: it is two indexed scans per scope, the same cost the admin endpoint already pays synchronously; no new exposure.
- [Risk] Legacy runs with prose summaries could accidentally parse as JSON → Mitigation: parse guard requires both `archives` and `orphaned` numeric keys before using the structured render.
- [Trade-off] Home trigger cell is static copy rather than live state → Accepted because per-scope throttle state has no honest single-value summary; the consolidation list shows actual run recency per scope.
- [Trade-off] List loses the model column even for the 3 legacy rows → Accepted because provenance remains in the run detail, conditionally rendered.

## Migration Plan

Presentation + one additive route; ships in a normal release. No migration, no data backfill, instant rollback by reverting the commit.

## Open Questions

None.
