## Why

Every `memory.save` persists one `pending` relation row per detected candidate (up to
`CANDIDATES_PER_SAVE_MAX`, default 5) and asks an agent to close each one with a verdict. Measured
on a production backup taken 2026-11-22 (17,777 `memory_relations` rows, all projects), that queue
costs far more than it returns:

- 14,714 agent verdicts were recorded. 308 of them (2.1%) changed a memory: 285 `supersedes` and
  23 `conflicts_with`. 10,675 (72.5%) were `related`, `compatible` or `scoped`, which change
  nothing. 3,731 were `not_conflict`.
- 301 of the 308 effect verdicts were issued within one hour of the save that detected the pair
  (280 of 285 `supersedes` and 19 of 23 `conflicts_with` within ten minutes). The queue's second
  chance produced 7 effect verdicts in six months.
- `topic_key` upserts retired memories 1,156 times, four times as often as a verdict did.
- 877 pending rows from agent saves expired at the 14-day deadline without a verdict, and 643 rows
  are pending now. 510 of those 643 come from the subagent-learnings hook, which has no agent to
  hand its candidates to, so the queue has grown without bound since 2026-11-16.

The agent that saves already receives the candidates with fresh context. The persisted queue adds
thousands of no-effect verdicts a month and a backlog that only a deadline empties.

## What Changes

- **New operator switch `JUDGMENT_QUEUE_ENABLED`, default `0`.** With the queue disabled, save-time
  candidate detection still runs and still returns `candidates[]`, `related[]` and
  `candidatesDetected`, but no `memory_relations` row is written at detection time.
- **BREAKING (response shape, queue disabled):** `candidates[]` entries carry `sourceId` and no
  `judgmentId`; a high-band entry carries `converge: true`; `convergeWith[]` is empty and
  `judgmentRequired` is `false`. Applies to `memory.save`, `memory.capture_passive` and a confirmed
  `memory.merge`.
- The agent acts on a candidate only when the action has an effect: `memory.compare` with
  `supersedes` or `conflicts_with`. Guidance no longer asks for `related`, `compatible` or `scoped`
  verdicts. The `instructions` block and the tool descriptions say so.
- `POST /api/<slug>/sessions/:id/learnings` writes no pending relation with the queue disabled.
- Nothing is deleted and no tool is removed. `memory.judge_batch`, `memory.context.pendingJudgments[]`,
  the orphaning deadline and the drain keep working, so the rows pending at upgrade are judged or
  expire through the existing paths.
- Setting `JUDGMENT_QUEUE_ENABLED=1` restores today's behaviour exactly. That is the rollback.
- `design.md` records the validation gate that must pass in production before a follow-up change
  removes the queue code, its tool surfaces and the legacy no-effect rows.

## Capabilities

### Modified Capabilities

- `memory`: save-time candidates are advisory and unpersisted while the judgment queue is disabled.
- `mcp-api`: response shape of `memory.save`, `memory.capture_passive` and `memory.merge` with the
  queue disabled; the `instructions` block and tool descriptions; the operator switch.
- `http-api`: the learnings route writes no pending relation with the queue disabled.
- `hermes-agent-plugin`: the static prompt block teaches the queue-disabled flow, because Hermes never
  receives the server's instructions.

## Impact

- Operators: one new environment variable. Upgrading changes behaviour by default; the previous
  behaviour is one setting away. No migration, no data change.
- Agents: fewer follow-up calls after a save. A candidate the saving agent ignores is not offered
  again; 4 of 23 recorded contradictions were found on such a later pass.
- Code: `packages/core/src/services/save-curation.ts`, `packages/mcp/src/{memory-tools,observability-tools,instructions,server}.ts`,
  `apps/web/src/lib/services.ts`, `docs/{relations,agents,embeddings,troubleshooting}.md`,
  `README.md`, `CLAUDE.md`, and the Hermes prompt block in `apps/plugin/.hermes-plugin/__init__.py`.
  The Hermes change cuts a `plugin` release. The other plugin texts that name `memory.judge_batch`
  (`apps/plugin/commands/context.md`, `apps/plugin/README.md`) stay true, because the tool and the
  legacy pending rows remain.
- Not in this change: removing `memory.judge_batch`, the `pendingJudgments` surfaces, the sweep's
  orphaning and drain, the dashboard queue view, or any stored row. Those belong to the follow-up
  change described in `design.md`, which starts only after the validation gate passes.
