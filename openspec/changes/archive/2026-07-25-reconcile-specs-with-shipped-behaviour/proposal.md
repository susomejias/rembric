## Why

An eight-agent adversarial review of the six changes archived on 2026-07-25 turned up code defects (fixed directly in `51ef0d1..57b39a2`) and a second, larger class that cannot be fixed by editing code: **the specs no longer describe what ships.** Specs in `openspec/specs/` are this repo's authoritative contract, so each of these is a defect, not a doc nit.

The batch already found and fixed two stale statements asserting that search touches `last_seen_at`. It missed a third, and the sweep for that one surfaced roughly twenty more across nine spec files. Three shapes, in descending severity:

1. **Specs that overclaim** — a requirement the code does not satisfy. A reader implementing against the contract gets it wrong.
2. **Load-bearing behaviour no requirement records** — most glaringly, `memory.confirm`'s refutation channel, the headline feature of `separate-access-from-usefulness`, has **zero** occurrences of "refut" in `mcp-api/spec.md`. It exists only in a zod `.describe()`.
3. **Tool descriptions that mislead the agent at runtime.** These are worse than stale prose: an agent reads them every turn and acts on them. Three actively lie about filtering, completeness, and history.

Plus two documented operator commands in `docs/backup.md` that do not work, and one restore path that silently pins a derived index to the previous extraction recipe with no error — the kind of thing an operator only discovers after a real incident.

This change reconciles the contract with reality. Where code and spec disagree it decides **which one is right** rather than defaulting to either: some specs describe the better design and the code should move; most describe an intent the code deliberately improved on, and the spec should be amended.

## What Changes

### Spec overclaims to resolve

- **`consolidation/spec.md` orthogonality invariant.** Already resolved in code (`ab7a5f6`) by removing escalation from the decay axis; the spec's absolute now holds again. Task here is only to add the read-time escalation signal as a recorded requirement so `reviewEscalated` is contract, not accident.
- **`mcp-api/spec.md`: `entity` "MAY be combined with the existing `status` and `type` filters".** False — neither is threaded into `findMemoriesByEntity`, and `tag`/`topic_key` are dropped too. An agent narrowing to `type:'user'` gets unfiltered rows and reads them as preferences. **Thread the filters** (the spec describes the better behaviour).
- **The entity path promises "complete — no ranking, no cutoff" and returns 8.** `clampLimit(undefined)` = 8. Either bound it by `RANK_WINDOW_CEILING` as the query-narrowing sub-branch already does, or drop the completeness claim from both spec and description. Prefer the former.
- **`topic_key` documented as "any status" / "every memory ever saved under a given key" but defaults to `status='active'`.** There is no call that returns the history, which defeats the stated purpose (checking whether a topic converged before saving a synonym). **Omit the status predicate when `topicKey` is set and `status` is absent.**
- **`memory-entities/spec.md`: global entities visible to a project-scoped read.** `includeGlobal` is never threaded into `entityScopeCondition`, so a global memory referencing the same path is silently dropped while the argument's own description promises otherwise.
- **`memory-entities/spec.md`: extraction "SHALL run inside the same transaction as the save".** It does not, and should not — linking happens after the commit with an `embedNow` in between. The code is the better design; **amend the spec** to "immediately after the save commits, best-effort".
- **`dashboard/spec.md`: "the view is scope-isolated".** Not implemented — `adminListEntities` takes no project parameter, and the test _named_ for this scenario asserts the opposite (both a global-only and a project-only entity on one page). `add-entity-index/tasks.md` 7.3 is marked complete. Decide: add a `?project=` filter, or rewrite the requirement as cross-scope-with-labels (consistent with `/dashboard/memories`).
- **`dashboard/spec.md`: "an entity links to its memories".** The drill-down is `/dashboard/memories?q=<value>`, an FTS query. Verified live: the dev DB's only entity, `ticket #36` with linkCount 1, links to a page that renders "No memories match this filter" because the tokenizer drops `#`. Back it with `findMemoriesByEntity`.
- **`claude-code-plugin/spec.md`: the "first-prompt relevance prefetch" makes no HTTP call** — it echoes a fixed instruction telling the model to call `memory.context`. Either call the recall endpoint Hermes already uses, or drop "prefetch"/"bounded result".
- **Four specs still describe the recall hook as matcher-gated**; the matcher was deliberately removed so first-prompt detection sees every prompt.
- **`claude-code-plugin/spec.md`: "`UserPromptSubmit` hook output ≤30 tokens".** Measured ~135 across two entries on turn 1.
- **`retrieval-evaluation/spec.md`: "baseline scorecards SHALL define a floor per metric".** `checkFloors` gates three of five; `abstentionFalsePositiveRate` and `avgTokensReturned` are computed, printed, discarded — so a regression that doubled tokens returned passes CI. Add ceilings and gate them, or narrow the sentence.
- **`data-access/spec.md`** closes a loophole its own older requirement still permits, and two unscoped reads reachable from `memory.doctor` (`vectors.backlogCount()`, `consolidation.latestRun()`) never got the `admin` prefix while the sibling `entities.adminBacklogCount()` did.

### Behaviour to record

- **The refutation channel** — `verdict`/`reason` args, the `invalid_input` thrown when `refute` lacks a reason, refuted rows surfacing in the review queue, and the rule that refutation does not advance the affirmation baseline.
- **`memory.context`'s entity pre-pass** — exact-entity rows are admitted first and hybrid search runs only if the quota is unfilled, with an agent-visible `via: 'entity' | 'ranked'`. `mcp-api/spec.md` currently says the channel is "produced by the same scoped hybrid search that backs `memory.search`".
- **`persistence/spec.md` DDL** for the three entity tables, `sessions.last_activity_at` (0022) and `confirmations.verdict`/`reason` (0024). Most load-bearing omission: `memory_entities_identity_idx (scope, project_id, kind, value)` is the structural guarantee that an identifier in project A cannot join project B's memories, and it lives only in a code comment.
- **Entity-channel candidate similarity is unit-incompatible with the other channels** (`1 - linkCount/scopeMemoryCount`, so a once-linked entity in a 1000-memory scope scores 0.999 and beats any realistic cosine in the `max()` merge). Either record the units or normalise them.

### Self-contradictions to strike

Chiefly the surviving `last_seen_at` claims: a projection clause specifying "the `last_seen_at` touch" for `memory.search`; a passage **added by this batch** arguing for the relevance channel on the grounds that "the access timestamp advances on every read" — the premise the same batch deleted; and a line asserting it "advances on every read (access)", false both for search and for batch `memory.get({ids})`, which also contradicts a new scenario two hundred lines later. Also `sessions/spec.md`, where a periodic-retirement requirement keyed on `last_activity_at` was appended without retiring the startup-only one keyed on `started_at`, leaving two contradictory requirements.

### `docs/backup.md` — an operator restores from this

- **The restore trap.** The "already processed" bookkeeping lives inside the DB (`memory_entity_scan`, `memory_vec`) while the recipe version lives outside it (`entity-state.json`, `embedding-state.json`). Restore an older `data.db` while a matching-version marker survives and the gate skips the wipe, `findMissingScans` returns nothing, and the index stays pinned to the **old** recipe forever with no error. Absence of the marker is the safe direction. Document: delete both markers before booting on a restored DB, and classify all five derived tables as regenerable.
- **`REMBRIC_ALLOW_DATA_SHRINKAGE=1 docker compose up -d` never reaches the container** — compose passes only `env_file: .env`, so the host-shell variable is used for file interpolation, not injected. The operator hits the guard, runs the documented command verbatim, and gets the identical refusal.
- **"hitting the same form endpoint from cron with a valid admin bearer token"** — that endpoint authenticates by dashboard cookie only, so a cron job 302s and acquires zero backups while looking successful.
- **The data-loss guard is overstated**: it trips at a ≥50% drop in a monitored table, not on any older-or-smaller snapshot.
- **`persistence/spec.md` says "both tables"** for the entity rebuild; there are three, and following it literally leaves `memory_entity_scan` populated, which makes the rebuild a silent no-op.

### The evidence bar this change must also meet

`memory-entities/spec.md` requires that a kind "MUST earn its place against the lexical branch, not merely be plausible", with a measured justification table. The measurement apparatus does not exist: the 67% / 50–75% / 0% figures are prose, with no corpus, script, or asserting test — and one published figure is wrong (`error_code` is credited 0% as "self-terminating under tokenization", but FTS5's `unicode61` drops `_` exactly as it drops the `.` the table penalises `hostname` for; `PERMISSION_DENIED` measures 50% noise and `NOT_FOUND` 75%). Commit the adversarial corpus and a noise-rate script in the shape `retrieval-evaluation` already established, then correct the table.

## Impact

Affected specs: `memory`, `mcp-api`, `memory-entities`, `consolidation`, `dashboard`, `persistence`, `sessions`, `data-access`, `retrieval-evaluation`, `claude-code-plugin`, `codex-distribution`.

Affected code (where the spec is judged right): `services/memory.ts` and `db/repositories/entities-repository.ts` (entity filters, `includeGlobal`, entity-branch bound), `mcp/memory-tools.ts` (`topic_key` history), `dashboard/entities.ts` (link-backed drill-down, optional project filter), `test/retrieval/run-eval.ts` (gate the two ungated metrics), `docs/backup.md`, `.env.example`, `README.md`.

Not in scope, tracked separately: the efficiency findings (`linkMemory` is O(corpus²) and runs on every save; the unpaced dashboard rebuild blocks the event loop ~8s at the batch cap), the file-level rather than method-level `invariants.test.ts` exemptions, the 30-minute hardcoded `TRANSPORT_STALENESS_MS` that silently detaches sessions from `memory.save` after a long gap, and the `tokenizeWords` punctuation mismatch that makes save-time candidate similarity report 0 for a genuine lexical match.

The deferred `needsReviewExprs` finding is owned by `index-confirmation-review-reads`, which closes it with a composite index after measurement overturned the assumed `LEFT JOIN` fix. Do not re-adopt it here.
