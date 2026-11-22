## 1. Description wording swaps (A)

- [x] 1.1 Rewrite `SEARCH_DESCRIPTION` in `apps/server/src/mcp/server.ts`: add proactive-moment triggers alongside the reactive ones (the reactive trigger stays, per the published `memory.search` scenario). Measured 1873 / 1900 (27 headroom).
- [x] 1.2 Rewrite the `RECALL` line in `apps/server/src/mcp/instructions.ts` BASE: added proactive moments alongside existing reactive triggers. Measured ~773 / 1000.
- [x] 1.3 Update `apps/plugin/test/nudge-fixtures.json`: the `recall` fixture is already consistent with `prompt-search.sh` conventions (client-composed keyword-recall nudge unchanged); verified.
- [x] 1.4 Run `pnpm run typecheck` — passes.
- [x] 1.5 Run `pnpm run lint` — passes.
- [x] 1.6 Run `pnpm test` — must pass (includes `test/mcp-integration.test.ts` CI assertions for DESCRIPTION_MAX_LENGTH and `instructions.test.ts` for INSTRUCTIONS_MAX_LENGTH).
- [x] 1.7 Run `pnpm run eval` — retrieval metrics must not regress (baseline: P@8=0.212, R@8=0.975, MRR@8=0.917).

## 2. Server: recall-hints endpoint (B)

- [x] 2.1 In `apps/server/src/server/api-router.ts`: add `POST /sessions/:id/recall-hints` endpoint. Zod schema: `{prompt: string}`. Extract session from URL, call `recallHints()` from agent-sessions, return `{lines: string[]}`. Auth via existing session auth middleware.
- [x] 2.2 In `apps/server/src/services/agent-sessions.ts`: add `recallHints(sessionId, prompt)` function. Call `extractEntities()` on the first 500 chars of the prompt, then `repos.entities.findMemoriesByEntity()` for each entity. Filter to `type IN ('project', 'feedback', 'procedural')`. Maintain a per-session `Set<string>` of entities already recalled (in-memory, keyed by session id, transient). Cap at 3 recall lines, each with top-2 memory titles. Return recall lines as `{lines: string[]}`.
- [x] 2.3 Write unit tests for `recallHints`: empty prompt → no lines; prompt with matching entity → recall line; entity already recalled → deduped; more than 3 entities → capped; only project/feedback/procedural types surfaced.
- [x] 2.4 Verify append-only invariant: write a test asserting the prompt text does not appear in any `memory`, `prompts`, `agent_sessions`, `consolidation_ops`, or other table row after processing the hints request.
- [x] 2.5 Run `pnpm run typecheck` — must pass.
- [x] 2.6 Run `pnpm run lint` — must pass.
- [x] 2.7 Run `pnpm test` — must pass.
- [x] 2.8 Real Docker smoke: seed data, send a recall-hints request with a prompt mentioning an entity present in the seed, verify recall lines in the response.

## 3. Client: hints call sites at turn start (B)

- [x] 3.1 In `apps/plugin/bin/rembric-plugin-core.mjs`: add `recallHints(sessionId, prompt)` function that calls `POST /api/<slug>/sessions/:id/recall-hints` with `{prompt}` (already `<private>`-redacted, truncated to 500 chars). Bounded timeout (200ms default), returns `{lines: string[]}`, returns `[]` on error or timeout.
- [x] 3.2 In `apps/plugin/.pi-plugin/index.ts` (`before_agent_start` handler): after computing nudges, call `recallHints()` with the event prompt. Merge returned lines into `result.message` alongside existing nudgesForTurn output. Await the hints call (already in an async context). No change to the turn-report body.
- [x] 3.3 In `apps/plugin/.opencode-plugin/plugin.ts` (`chat.message` handler): call `recallHints()` with the prompt content. Push returned lines as nudge parts alongside existing nudgesForTurn output. Await the hints call. No change to the turn-report body.
- [x] 3.4 In `apps/plugin/scripts/_api.sh`: add `rembric_recall_hints` function with bounded timeout. Pattern: POST to recall-hints endpoint, echo returned lines.
- [x] 3.5 In `apps/plugin/scripts/prompt-hints.sh` (NEW dedicated matcher-less `UserPromptSubmit` entry, registered in both hook manifests): call `rembric_recall_hints` synchronously with the prompt from stdin. Echo returned lines. `prompt-search.sh` stays request-free; no change to stop-report.sh or the turn body.
- [x] 3.6 Verify the turn body in `rembric-plugin-core.mjs` `reportTurn()` does NOT include a `prompt` field — body stays `{usedTools}` (+`title` once).
- [x] 3.7 Run `pnpm test` — must pass (includes hook-manifest tests).

## 4. Usage counters (C)

- [x] 4.1 In `apps/server/src/services/`: add an in-memory counter map keyed by token id and tool name. Increment on each successful `memory.search`, `memory.context`, `memory.save` call.
- [x] 4.2 Wire the counter into the MCP tool handlers for `memory.search`, `memory.context`, and `memory.save`.
- [x] 4.3 Expose counters on `GET /api/:slug/debug/counters` requiring admin authorization. Return `{ counters: { [tokenId]: { [tool]: count } } }`.
- [x] 4.4 Write unit tests: counter increments on tool call; counter resets on restart (new instance); admin auth required for debug endpoint.
- [x] 4.5 Run `pnpm run typecheck` — must pass.
- [x] 4.6 Run `pnpm run lint` — must pass.
- [x] 4.7 Run `pnpm test` — must pass.
- [x] 4.8 Real Docker smoke: call `memory.search` twice, hit debug endpoint, verify counter is 2.

## 5. Integration verification

- [x] 5.1 Run full test suite: `pnpm test` — all tests must pass.
- [x] 5.2 Run typecheck: `pnpm run typecheck` — must pass.
- [x] 5.3 Run lint: `pnpm run lint` — must pass.
- [x] 5.4 Run eval: `pnpm run eval` — metrics must not regress from baseline (P@8=0.212, R@8=0.975, MRR@8=0.917).
- [x] 5.5 Docker integration test: start server, connect a client, send turns with entity-rich prompts, verify recall hints are available in the SAME turn response (zero delay — no one-turn lag); verify no lines when prompt has no entities; verify prompt is never persisted to any table.
- [x] 5.6 Verify backward compatibility: old client (no hints call) + new server → no entity recall lines, no errors, turn channel unchanged.

## 6. Deferred / rejected items

- [x] 6.1 **NOT IMPLEMENTED:** PostToolUse hooks (retired by owner decision 2026-07-12).
- [x] 6.2 **NOT IMPLEMENTED:** Resolve/suppress push controls (YAGNI).
- [x] 6.3 **NOT IMPLEMENTED:** Prompt persistence (violates append-only invariant).
- [x] 6.4 **NOT IMPLEMENTED:** Per-turn channel for Hermes (documented gap, separate change).
- [x] 6.5 **NOT IMPLEMENTED:** Turn-cadence search nudges (rejected as noise).
- [x] 6.6 **IMPLEMENTED:** Sync recall-hints endpoint — this was a previously considered alternative for future upgrade; it is now the primary transport (D1′), implemented as the `POST /sessions/:id/recall-hints` endpoint in phase 2.
- [x] 6.7 **DEFERRED:** Database-persisted usage counters (promoted from in-memory if long-term analytics needed).
- [x] 6.8 **DEFERRED:** Dashboard display of usage counters (optional follow-up).

## 7. Correctness fixes found after apply (review + `sdd-verify` FAIL)

Sources: three CRITICAL findings in `verify-report.md`, and four defects reproduced by direct probe
during branch review. Every item here has executed evidence behind it, not a reading.

- [x] 7.1 `findMemoriesByEntity` accepts the whole admitted type set (`types`, via `inArray`)
      alongside the existing single `type`, so the predicate reaches SQL and `LIMIT` bounds rows
      that already passed it (D4). Existing callers keep their current behaviour.
- [x] 7.2 One shared service-layer entity-relevance function, consumed by BOTH `memory.context`'s
      focus pass and the recall path, so the two cannot drift apart again. The admitted type set
      and the status are PARAMETERS, not constants baked into the helper: `memory.context` keeps
      its current behaviour exactly (every type, non-archived, its own limit) and recall passes the
      learning types with `status: 'active'`. Folding recall's narrower filter into the shared
      helper as a default would silently narrow the relevance channel of `memory.context`, which is
      a regression, not a fix — assert `memory.context`'s existing behaviour is unchanged.
- [x] 7.3 Recall passes `status: 'active'` (D4b) and the active-learning `types` set (D4).
      Probe evidence: a `project` memory behind two newer `reference` memories returned no lines;
      two rows under one `topic_key` returned the superseded take beside its successor.
- [x] 7.4 Dedupe keyed on `(kind, value)`; released on session end and soft-delete; retained
      sessions bounded with least-recently-used eviction (D3).
- [x] 7.5 Bound the per-request entity probe (D5).
- [x] 7.6 The recall-hints route authorizes `read`, not `write` — it persists nothing, and
      `/memory/recall` next to it already authorizes `read`.
- [x] 7.7 CRITICAL-1: restore the `sessionId` reinforcement clause to the `instructions.ts` BASE
      block, dropped by commit `88fc639`. Measured room: 968/1000 unscoped, 906/1000 scoped, so no
      component had to go. Remove the whitespace-only line the same rewrite introduced. Add one
      separate assertion per enumerated component, including the clause that was lost unguarded.
- [x] 7.8 CRITICAL-2: pin the bash hints request to the turn-start budget at its own call site.
      Measured 3022 ms against an unresponsive server versus the 200 ms this change published.
      Assert the elapsed bound, not merely that the hook exits 0.
- [x] 7.9 CRITICAL-3: test the core `recallHints` directly (request path, redacted/truncated body,
      populated response, and each declared failure mode), and exercise each carrying client's
      merge with a transport that returns real lines. Today every such suite answers with an empty
      body, so success and every failure mode collapse to the same empty array.
- [x] 7.10 Bash hook: source the canonical redaction helper, apply the order redact → cut 500 →
      escape, and delete the local awk block (D8). Probe evidence: a mixed-case `<private>` span
      survived, and a 499-character prompt followed by a quote produced an unterminated JSON body
      while a 498-character control stayed valid.
- [x] 7.11 Recall counters: requests, non-empty responses, lines served — on the existing instance
      and the existing admin-gated route (D6).
- [x] 7.12 Propagate the recall wording to the Hermes system-prompt block, which
      `hermes-agent-plugin` requires to stay in step with the server's instructions block. This is
      the instructions text only; the per-turn hints channel for Hermes stays a Non-Goal.
- [x] 7.13 Correct the stale headroom comment beside `SEARCH_DESCRIPTION` (says 1816/1900; the
      CI-pinned measurement is 1873/1900) and the adjacent comment that attributes `confirmSwitch`
      to `memory.save`'s description when it is documented in `project.use`'s.
- [x] 7.14 Account for the edits that rode along without belonging to this change: the shell
      reformatting in `_api.sh`, the ternary inversions in `memory-tools.ts`, the OAuth `try/catch`
      in `http.ts`, and the Pi JSON helper. Name each in the proposal's Impact section as an
      incidental non-behavioural edit, rather than reverting them: re-formatting a shell file back
      is a larger and riskier diff than the one it would undo, and the two error-path wrappers
      change only a message, not a contract. The reviewer's problem is an unexplained diff, and
      naming them solves that at a fraction of the cost of churning them.
- [x] 7.15 Every scenario added to the delta specs in this pass gets a test, each proven by
      mutation (`scripts/mutate.mjs`), restoring each file byte-identically after the run. Five
      guards reddened their named test: the `types` predicate, the `status` predicate, `probeMax`,
      the `(kind, value)` dedupe key, and the hook's 200 ms pin. Not caught, and reported as such:
      that same dedupe-key mutation does not redden the two-call dedupe test, which repeats one key
      and so cannot observe its composition. The kind axis is covered by the test that surfaces the
      same entity value under different kinds. The per-guard mapping and the exact failure messages
      are in this commit's message.
- [x] 7.16 Gates: `pnpm run typecheck`, `pnpm run lint`, the full suite, `openspec validate
proactive-entity-recall --strict`, `pnpm run check:spec-provenance`, and the delta-freshness
      check. Note for whoever runs the suite: `apps/plugin/mcp-bridge/bridge.test.ts` carries a
      pre-existing teardown race that makes the process exit 1 on roughly two runs in three with
      all 3070 named tests passing. It is untouched by this change; cross-check the named-test
      count against the exit code rather than trusting either alone.
