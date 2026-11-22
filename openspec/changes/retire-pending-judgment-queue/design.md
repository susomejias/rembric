## Context

Save-time curation (`packages/core/src/services/save-curation.ts`) finds memories that resemble the
one just saved through three channels (vector similarity, lexical containment, a shared rare
entity), classifies each pair into a band (`high` at vector similarity 0.85 or more, `low` below
0.65, `middle` otherwise) and, for every middle- or high-band pair up to `CANDIDATES_PER_SAVE_MAX`,
inserts a `memory_relations` row with `status = 'pending'`. The row's `judgmentId` goes back to the
caller in `candidates[]`. An agent closes it with `memory.judge_batch`; unjudged rows re-surface in
`memory.context.pendingJudgments[]` (five aged rows per call by default) and are orphaned by the
consolidation sweep after 14 days, at most 50 per project per day.

Four paths run this curation: `memory.save`, `memory.capture_passive` (per extracted learning), a
confirmed `memory.merge`, and the hook route `POST /api/<slug>/sessions/:id/learnings`, whose caller
has no agent and receives no candidate list.

### Measurements

All figures come from a production backup taken 2026-11-22, read with `sqlite3 -readonly`, all
projects, unless a line says otherwise.

| Measure                                           | Value                                                  |
| ------------------------------------------------- | ------------------------------------------------------ |
| `memory_relations` rows                           | 17,777                                                 |
| Agent verdicts                                    | 14,714                                                 |
| of which `related` / `compatible` / `scoped`      | 5,478 / 2,936 / 2,261 (72.5%)                          |
| of which `not_conflict`                           | 3,731 (25.4%)                                          |
| of which `supersedes` / `conflicts_with`          | 285 / 23 (2.1%)                                        |
| `supersedes` rows written by a `topic_key` upsert | 1,156                                                  |
| Orphaned rows                                     | 1,261, of which 877 expired at the deadline unjudged   |
| Pending rows                                      | 643: 510 from the learnings hook, 133 from agent saves |

Delay between detection (`created_at`) and verdict (`judged_at`) for the effect verdicts:

| Verdict          | Total | Under 10 min | 1 hour or more                    |
| ---------------- | ----- | ------------ | --------------------------------- |
| `supersedes`     | 285   | 280          | 3 (70.9 h, 167.5 h, 320.5 h)      |
| `conflicts_with` | 23    | 19           | 4 (8.3 h, 17.1 h, 18.0 h, 46.9 h) |

Verdicts issued a day or more after detection total about 476; 4 of them had an effect.

Monthly baseline, used by the validation gate below:

| Month                 | Agent saves | Agent verdicts | Effect verdicts | Effect per 1,000 agent saves | `topic_key` supersessions |
| --------------------- | ----------- | -------------- | --------------- | ---------------------------- | ------------------------- |
| 2026-06               | 147         | 321            | 15              | 102.0                        | 34                        |
| 2026-07               | 179         | 477            | 17              | 95.0                         | 51                        |
| 2026-08               | 381         | 1,492          | 46              | 120.7                        | 115                       |
| 2026-09               | 1,214       | 5,820          | 128             | 105.4                        | 499                       |
| 2026-10               | 1,187       | 5,709          | 82              | 69.1                         | 356                       |
| 2026-11 (to the 22nd) | 329         | 698            | 20              | 60.8                         | 80                        |

Two further measurements, on one project (1,118 memories):

- Replaying every memory in creation order through the production curation path with the real
  embedder wrote 1,441 pending rows, 1.29 per save. 22 of them were high band. Hook learnings wrote
  1.36 rows per save and agent saves 1.27, so learnings are not noisier, only unjudged.
- 2 of 227 hook learnings had a high-band match. A rule that skips near-duplicate learnings would
  therefore remove about 1% of them and is not part of this change.
- In search results, relation annotations at the default `relations_limit` weigh about 844
  characters per active memory, 84% of them `related`, `compatible` or `scoped`.

The calibration fixture (`run-save-time-sweep.ts`, floor 0.60, cap 5, 37 labelled saves) places all
8 near-duplicates in the high band and all 4 expanded rewrites and all 5 contradictions in the
middle band. Persisting only the high band would therefore keep none of the pairs the queue is
meant to catch, which is why this change does not keep a reduced queue.

## Goals

- Stop writing relation rows that no one acts on, on every write path, including the hook route.
- Keep candidate detection and keep showing its result to the agent that saves.
- Keep every effect an agent can have today: superseding a memory and flagging a contradiction.
- Ship it so that the previous behaviour is restored by one setting, with no data change.
- State in advance what must be observed in production before anything is removed.

## Non-Goals

- Removing `memory.judge_batch`, `pendingJudgments`, the orphaning deadline, the drain, the dashboard
  queue view or any stored row. See "Follow-up change".
- Changing detection: channels, floors, bands and the per-save cap are untouched.
- A server-side model that judges pairs. The server stays deterministic.
- Skipping near-duplicate learnings (measured above as about 1% of them).

## Decisions

### D1 — An operator switch, not a removal

`JUDGMENT_QUEUE_ENABLED` (`0` or `1`, default `0`) gates one thing: whether curation persists a
pending row per candidate. `1` is today's behaviour, byte for byte. The switch exists so that
production can fall back without redeploying an older image and without touching data. It is
temporary by design; the follow-up change deletes it together with the queue.

Alternative considered: remove the queue in one change. Rejected because it removes tools and
response fields that five client plugins and their instructions name, and because the one loss this
design accepts (D5) should be observed in production before it is made permanent.

Alternative considered: default `1` and flip it in production by hand. Rejected: every other
installation would keep paying for the queue, and the default would need a second release to change.

### D2 — With the queue disabled, a candidate carries its pair, not a judgment

No row exists, so no `judgmentId` exists. Each `candidates[]` entry carries `sourceId` (the memory
just saved) next to `targetId`, which is what `memory.compare` takes. `memory.capture_passive`
aggregates candidates over several saves, so the pair must be explicit there; `memory.save` carries
it too so one shape serves every path. A high-band entry carries `converge: true`.
`convergeWith[]`, which lists judgment ids, is empty. `judgmentRequired` is `false`.

### D3 — `memory.compare` is the verb for acting on a candidate

It already records a verdict on two memories as a `judged` row and, for `supersedes`, retires the
target. Nothing is added to it. Guidance asks for exactly two verdicts after a save: `supersedes`
when the new memory replaces the candidate, `conflicts_with` when they contradict each other. For
every other candidate the agent does nothing, and nothing is written.

`memory.compare` keeps accepting `related`, `compatible` and `scoped`, because refusing them would
break callers for no gain in this change. The follow-up change decides whether they stay.

`not_conflict` is not offered: with no pending row there is nothing to dismiss. Its present effect
(a `topic_key` revision does not re-propose a pair an ancestor dismissed) keeps working for the
verdicts already stored. New revisions may show a candidate again in the response; that costs
response tokens and no rows.

### D4 — Rows pending at upgrade are left to the existing paths

They stay judgeable through `memory.judge_batch`, stay visible in `memory.context.pendingJudgments[]`
and expire through the existing deadline. No migration closes them. With 643 pending rows, a 14-day
deadline and 50 orphanings per project per day, the queue is empty about 22 days after upgrade.

### D5 — Accepted loss: no second pass

A candidate the saving agent ignores is not offered again. In the measurements, later passes
produced 3 of 285 supersessions and 4 of 23 contradictions. The supersession loss is negligible.
The contradiction loss is small in number and is the reason the validation gate tracks
`conflicts_with` separately.

### D6 — Additive deltas

This change adds requirements that apply while the queue is disabled and name the published
requirements whose clauses they override. The published requirements stay true for
`JUDGMENT_QUEUE_ENABLED=1`. The follow-up change removes or rewrites them when the switch goes.
Rewriting them now would publish text that describes a mode production may still fall back to.

## Risks / Trade-offs

| Risk                                                                      | Likelihood                   | Prevention                                                                                                                               | Detection                                                                                       | Response                                 |
| ------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Agents stop superseding once nothing demands a verdict                    | Medium                       | Guidance names the two actions; `converge: true` marks the likely restatements; the `instructions` block keeps the step in the save loop | Gate metric V3                                                                                  | `JUDGMENT_QUEUE_ENABLED=1`               |
| Contradictions go unflagged                                               | Low in number                | Middle-band candidates are still returned to the saving agent                                                                            | Gate metric V4                                                                                  | Keep the queue enabled and reconsider D5 |
| Near-duplicate active memories accumulate                                 | Medium                       | `topic_key` remains the main convergence path (1,156 supersessions against 285 by verdict)                                               | Gate metric V5                                                                                  | `JUDGMENT_QUEUE_ENABLED=1`, then decide  |
| An older plugin's text still tells the agent to call `memory.judge_batch` | Certain until plugins update | The tool stays registered and the server-shipped `instructions` and tool descriptions carry the new guidance                             | A `judge_batch` call with no pending rows returns `not_found`, which is visible in tool results | None needed; plugin release follows      |
| A client reads `candidates[].judgmentId` as required                      | Low                          | The field becomes optional in the output schema; the switch restores it                                                                  | Client-side schema errors                                                                       | `JUDGMENT_QUEUE_ENABLED=1`               |
| The switch outlives its purpose                                           | Medium                       | The follow-up change is recorded here with its gate and a date to review                                                                 | Task 6.1                                                                                        | Open the follow-up or record why not     |

## Rollout and validation gate

1. **Ship** with the default `0`. Take a backup before the upgrade.
2. **Observe for 30 days.** Take a backup at day 30 and compute, per project and in total:

   | Id  | Metric                                                                                              | Pass                                                                                   |
   | --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
   | V1  | Pending rows created after the upgrade                                                              | 0                                                                                      |
   | V2  | Pending rows remaining                                                                              | 0                                                                                      |
   | V3  | Effect verdicts (`supersedes` + `conflicts_with`, `marked_by_kind = 'agent'`) per 1,000 agent saves | 35 or more (half the lowest baseline month)                                            |
   | V4  | `conflicts_with` verdicts                                                                           | Reported, with the 23-in-six-months baseline beside it; no threshold, the owner judges |
   | V5  | Share of new saves carrying a `topic_key`                                                           | 59% or more, the lowest baseline month, counted over agent saves                       |
   | V6  | Relation rows written per month                                                                     | Reported against the 6,000-a-month baseline                                            |

3. **Decide.** All of V1, V2, V3 and V5 pass and the owner accepts V4: open the follow-up change.
   Any fails: set `JUDGMENT_QUEUE_ENABLED=1`, record the figures in this change's tasks, and decide
   whether the queue stays.

Rollback at any point is the one setting. It needs no migration: rows written while the queue was
disabled are ordinary `judged` rows.

## Follow-up change (not started by this one)

Name: `remove-judgment-queue-surfaces`. It starts only when the gate above passes, on a fresh
backup that has been restored once to prove it is usable. Its scope, recorded here so the
destructive step is planned rather than improvised:

- Remove `JUDGMENT_QUEUE_ENABLED` and the pending-row code path.
- Remove `memory.judge_batch`, `memory.context.pendingJudgments[]` / `pendingJudgmentsTotal` / the
  `judgments` argument, the `pendingJudgments` counters of `memory.stats` and `memory.doctor`, the
  sweep's deadline orphaning and drain, and the dashboard's pending queue controls.
- Rewrite or remove the published requirements that this change's deltas override.
- Decide what happens to stored rows that never had an effect: `pending`, `orphaned`, and `judged`
  rows whose relation is `related`, `compatible` or `scoped`. Deleting them shrinks search
  annotations (84% of annotation characters today) and unblocks purging archived memories they
  reference. It also contradicts "Append-only at the row level" in the `memory_relations`
  migration header and the consolidation journal's promise that an orphaning can be undone, so it
  needs its own requirement, an entry in the purge allow-list of the invariants test, and the
  owner's explicit decision. Rows with an effect (`supersedes`, `conflicts_with`) and `not_conflict`
  rows are kept in every option.

## Open Questions

- Whether the follow-up deletes the no-effect rows or only hides them. Deleting is the owner's
  stated direction; it is deferred to that change because it amends an invariant.
- Whether `memory.compare` should refuse `related`, `compatible` and `scoped` once the queue is gone.
