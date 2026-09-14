# Verify report: fix-pi-ghost-sessions (issue #377)

Verdict: **PASS**, with one documented gap that is operator-only (e2e walkthrough §4.5–4.6).

## Per-capability evidence

### `sessions` — no-guess carve-out for `memory.session_start` + sole-active lookup

- Implementation: binding-first resolution in `apps/server/src/mcp/session-tools.ts::handleSessionStart`
  (pin → windowed lookup → `findSoleActiveForReuse` → mint), new lookup in
  `apps/server/src/services/agent-sessions.ts` and `apps/server/src/db/repositories/agent-sessions-repository.ts`.
- Tests: `session-tools.test.ts` (sole-active adoption past the window; two stale rows still mint;
  binding-first beats a fresher row; terminal bound row falls through with the binding re-pointed;
  soft-deleted bound row not adopted), `agent-sessions.test.ts` (sole-active describe incl. the
  windowed-lookup no-leak control), `agent-sessions-repository.test.ts` (sole-or-nothing, LIMIT 2
  boundary, exclusions, scope), `ghost-session-repro.test.ts` (control, bound weeks-long timeline,
  binding-less timeline, opencode cadence).
- Auto-attach untouched: `memory-tools.test.ts` control asserts a stale sole row still yields
  `session_id = NULL`.
- Mutation evidence (all caught by `scripts/mutate.mjs`): M1 status guard, M2 `deletedAt` guard,
  M3 `limit(1)`, M3b unconditional `rows[0]`, M4 staleness window reintroduced, M5 window removed
  from `findActiveForTransport` (inverse, caught by the no-leak control).

### `mcp-api` — binding precedence and the description clause

- Tests: `mcp-integration.test.ts` — description length pin re-measured from the live `tools/list`
  (818 → 971, cap 1900), the two clause assertions, and the pre-existing
  "a second `memory.session_start` adopts the first session and says so" still green.
- Mutation evidence: M6 (prose guard removed) caught by the clause assertions.

### `pi-plugin` — the extension declares its identity on the MCP transport

- Tests: `apps/plugin/.pi-plugin/plugin.test.ts` — declaration after the first `ensure` answers
  `session_start` by pin; silent retry after a failed declaration; re-declaration after a transport
  re-init; the failure cap degrades silently; the failure budget resets when the transport re-keys.
- Mutation evidence: M7 (cap removed), M8 (re-key gate), M9 (budget reset) all caught.
- The source contains no discovered tool name as a literal: the declaration resolves its tool by
  discovery (`sessionResumeToolName()`), so the pre-existing invariant tests stay green.

## Gates

| Gate                                               | Result                                                       |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm test`                                        | EXIT 0 (full monorepo suite)                                 |
| `pnpm run typecheck`                               | 0                                                            |
| `pnpm run lint`                                    | 0                                                            |
| `openspec validate fix-pi-ghost-sessions --strict` | valid                                                        |
| `pnpm run check:delta-freshness`                   | ok (6 deliberate-rewrite advisories across 3 active changes) |
| `pnpm run check:delta-sections`                    | ok (9 delta files)                                           |
| `pnpm run check:spec-provenance`                   | not runnable locally (no commits yet; CI gate)               |

## Review

RDD lineage `review-f214a58dda868e88`: tier high, 4/4 lenses admitted (risk, resilience, readability,
reliability), outcome **approved** with 9 non-blocking advisory findings; the exact
`acknowledge-approved` continuation was executed and returned `authority: burned`.

## Post-review corrections (landed after the approved candidate)

Three advisory findings were acted on after the review closed:

1. `apps/plugin/.pi-plugin/index.ts` — the declaration's failure budget is now reset when the
   transport re-keys (`lastBindAttemptKey`), plus a one-shot `diag` when the tool was never
   discovered. Covered by the new plugin test and M9; scenario
   "The failure budget is per transport and resets when it re-keys" added to the `pi-plugin` delta.
2. `apps/server/src/mcp/ghost-session-repro.test.ts` — logging scaffolding removed.
3. `apps/server/src/mcp/session-tools.ts` / `services/agent-sessions.ts` — the `AgentSession` type is
   imported from the schema instead of re-exported through the service.

These edits are NOT covered by the burned review authority: the reviewer saw the pre-correction
candidate. They are small, carry new test coverage, and are recorded here so the owner can decide
whether the existing review suffices for delivery or a fresh candidate should be reviewed.

## Explicitly NOT verified

- **e2e walkthrough (`pnpm run dev:docker:up`, tasks 4.5–4.6)** — operator-only and skipped per the
  owner's standing preference not to raise a local stack while a production connection is
  configured. Consequently: the published `@rembric/pi` npm artifact, the real 30-minute staleness
  boundary, the 24-hour abandonment sweep and multi-week timelines are not verified end-to-end here;
  they are covered only by the fake-clocked suites above. The other four clients are untouched.
- **`check:spec-provenance`** — runs in CI against committed ranges.
