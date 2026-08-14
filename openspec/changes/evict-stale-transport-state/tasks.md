# Tasks

## 1. Reproduce and quantify before changing anything

- [x] 1.1 Build the leak probe at the real MCP edge (real `createServer` on 127.0.0.1 plus SDK `Client`, the shape `apps/server/src/test/mcp-integration.test.ts:74-118` already uses). Arms: **CONTROL** — one client connects, calls a tool, calls `client.close()` → both registries return to their pre-connection sizes; **LEAK** — N clients connect, call a tool, and drop without `close()`/`DELETE` → both registries retain N entries. The control must pass before the leak arm counts; if a clean close does not reclaim, the harness is wrong and nothing measured after it is a fact.
- [x] 1.2 Publish the number the issue never had: with `--expose-gc` and a forced GC, record `heapUsed` at baseline and after N=2000 ungraceful disconnects, and derive bytes per retained `SessionRouter` entry and per retained `{McpServer, transport}` pair separately. State the instrument once (`process.memoryUsage().heapUsed` after `global.gc()`), and do not mix it with any other series. The proposal deliberately publishes no figure until this task produces one.
- [x] 1.3 Reproduce the unknown-session response **as it is today**, because design D6 currently rests on a source reading: send a `tools/call` carrying an `mcp-session-id` the process does not hold and record the exact status and JSON-RPC code (expected from `webStandardStreamableHttp.js:590-593`: `400` / `-32000` / `Bad Request: Server not initialized`). Control: the same call with a live id succeeds. If the observed status is already `404`, stop and revise design D6 rather than implementing against a stale reading.
- [x] 1.4 Confirm the two premises the delta states as fact: `grep -n "entries.delete" apps/server/src/server/session-router.ts` finds nothing, and `grep -rn "setDiscoveryPromise" apps/server/src` finds one production writer (`mcp/roots-discovery.ts:144`) plus test call sites only. These are the evidence for "leaks" and "does not leak" respectively.
- [x] 1.5 Record whether an idle transport holding an open standalone SSE stream would be classified stale by condition (b) — i.e. whether `getOrCreate` is reached again after the stream is opened. This is design Risk 2 and Open Question 3; the answer decides nothing in this change but must be on the record, measured rather than reasoned.

## 2. Transport manager: activity clock, reads, and eviction (design D1, D5)

- [x] 2.1 In `apps/server/src/mcp/transport.ts`, add `lastSeenAt` to the `Session` record: stamped in `onsessioninitialized` and bumped on every `getOrCreate` hit for a known id. This is the only place that sees every request for a transport, which is why the clock lives here and not on the router (design Open Question 4).
- [x] 2.2 Add the reads the pass needs and nothing more: an existence check for an id, and an iteration exposing `(mcpSessionId, lastSeenAt)`. No staleness policy in this class — the threshold and the predicate live in one module (D9).
- [x] 2.3 Add an eviction that closes the pair (transport and server) and removes the entry, idempotent when `onclose` has already removed it. `close()` and the existing `onclose` handler keep their current behaviour.
- [x] 2.4 Unit-test that `lastSeenAt` advances on a served request and does not advance for a request naming a different id.

## 3. Router: a real removal, and an honest docstring (design D5)

- [x] 3.1 In `apps/server/src/server/session-router.ts`, add removal of every entry for a given `mcp-session-id` (the key is `tokenId::mcpSessionId`, and one transport may legitimately carry entries for two tokens — see `archive/2026-08-09-fix-the-roots-discovery-lifecycle/design.md` D3), plus the iteration the pass needs over `(tokenId, mcpSessionId, projectId, rembricSessionId)`.
- [x] 3.2 Fix `clearSession`'s docstring (`:109`), which claims to "clear an entire transport entry" while the body nulls one field. Per repo policy this is a corrected one-line docstring, not an added explanation — the reasoning lives in the spec.
- [x] 3.3 Leave `discoveryInFlight` untouched and leave `resetAll` test-only. If either changes, the delta's "explicitly NOT part of this requirement" clause has been violated.

## 4. The predicate and the pass, in one module (design D1, D3, D4, D9)

- [x] 4.1 Add the existence read to `apps/server/src/db/repositories/agent-sessions-repository.ts`, beside `findActiveForTransport`: any `status='active'`, `deleted_at IS NULL` row for `(tokenId, projectId)` whose `EFFECTIVE_LAST_ACTIVITY >= activeSinceMs`. Reuse the existing expression and index; return a boolean, and deliberately do **not** reuse the `rows.length === 1` rule (`:173`) — eviction chooses nothing, so ambiguity must not read as absence. All SQL stays in `db/`.
- [x] 4.2 Expose it from `apps/server/src/services/agent-sessions.ts` applying `TRANSPORT_STALENESS_MS`, so the constant never leaves the file that owns it.
- [x] 4.3 Create `apps/server/src/server/transport-state-reaper.ts` with the single predicate and pass: evict every router entry whose `mcp-session-id` is absent from the transport manager (no window); then, for each remaining transport, evaluate the in-memory clock **first** and the SQL existence check only for candidates it fails (design trade-off on cost); evict both registries together for a stale transport, never one alone.
- [x] 4.4 Wire it into the existing reaper tick at `apps/server/src/server/bootstrap.ts:274-286` — same `try`/log discipline as the session reap, no new `setInterval`, no cron. Log evicted counts only when non-zero, matching the surrounding lines.
- [x] 4.5 Add the two invariant cases to `apps/server/src/test/invariants.test.ts`: the reaper module declares no millisecond literal (the threshold cannot be forked — a behavioural test would not catch a second copy that currently agrees), and neither registry class declares a staleness rule of its own.

## 5. Server tests — one arm per clause, each with a live control

- [x] 5.1 Both clocks stale → both registries evicted, and a concurrently live transport's entries survive. Assert the survivor explicitly; an assertion that the maps are empty passes vacuously on an empty harness.
- [x] 5.2 Quiet transport with a live session row → not evicted. Drive the row's freshness through the real path (`POST /api/<slug>/sessions`, which bumps `last_activity_at` via `ensure`), not by writing the column directly.
- [x] 5.3 Busy transport with no session row at all → not evicted.
- [x] 5.4 Orphan clause: transport removed by a clean `onclose`, router entry left behind, elapsed time well under the window → the entry is evicted anyway.
- [x] 5.5 Anti-misscope arm, the one that protects a load-bearing invariant: a path-less transport with a `project.use` pin that keeps calling tools still resolves to its pinned project, with its original `source`, after any number of passes. This arm must fail if any code path evicts a router entry without its transport.
- [x] 5.6 Interaction with `purgeEmpty` (design Open Question 5): a transport whose only session row was empty and has been purged is classified by condition (b) alone, and a live transport in that state is not evicted.
- [x] 5.7 The pass reclaims with no session start and no traffic — call the tick directly against a process holding only stale state.
- [x] 5.8 `discoveryInFlight` arm: a discovery attempt in flight across a pass is still removed exactly once by its own `finally`, and the pass removes nothing from that map.
- [x] 5.9 Unknown-session `404` arms (mcp-api delta): unknown id + `tools/call` → `404` / `-32001`; a counting server factory records zero constructions across several such requests; `initialize` carrying a stale id still establishes a session; a known id is unaffected.

## 6. Mutation check — every guard independently load-bearing

`scripts/mutate.mjs` **skips** a non-unique `--mutation` string and reports the skip as uncovered, which reads exactly like a failure. For each string below, first run `grep -c '<string>' <file>` and confirm it prints `1`; extend with surrounding context until it does.

- [x] 6.1 Weaken the predicate to condition (b) only (drop the SQL existence check) → 5.2 must go red.
- [x] 6.2 Weaken the predicate to condition (a) only (drop the `lastSeenAt` comparison) → 5.3 must go red.
- [x] 6.3 Remove the together-or-not-at-all coupling so router entries are evicted alone → 5.5 must go red. If it stays green the anti-misscope arm is decorative and must be rewritten before this lands.
- [x] 6.4 Remove the orphan clause → 5.4 must go red.
- [x] 6.5 Make the existence read inherit `rows.length === 1` → add or confirm an arm with two live sessions on one identity goes red (a transport with two live sessions must not be evicted).
- [x] 6.6 Remove the `404` branch so unknown ids fall through to `getOrCreate` → 5.9 must go red on both the status and the factory-count assertions.
- [x] 6.7 Record every mutation that reddens nothing as the finding it is, and fix the test rather than the note. A test green on both sides of the change is the default outcome, not the exception.

## 7. Client-side recovery (design D7, D8) — Pi is code, the rest is measurement

- [x] 7.1 Read `.agents/skills/rembric-plugin-development/SKILL.md` and `references/per-client-gotchas.md` before touching `apps/plugin/`. Sanity check afterwards: `git ls-files apps/plugin/` still shows one copy of every shared resource; this change must touch `.pi-plugin/index.ts` only.
- [x] 7.2 In `apps/plugin/.pi-plugin/index.ts`, on a `404` to a request that carried an `mcp-session-id`: discard the id, re-run `initialize` plus the initialized notification, retry the original request once. `404` only — `401`, `403`, `429` and `5xx` keep throwing as they do today. No loop, no tool re-registration.
- [x] 7.3 Extend `apps/plugin/.pi-plugin/plugin.test.ts` with arms against its stub server (the shape at `:1139` already exists): recovery succeeds and sends exactly one extra `initialize`; a second `404` surfaces as an error with no third attempt; a `401` triggers no `initialize`; no extra tool registration occurs.
- [x] 7.4 Mutation: make the retry unconditional on status → the `401` arm must go red. Make the retry a loop → the second-failure arm must go red.
- [ ] 7.5 **Operator step, real edge.** DEFERRED, not feasible from this environment: `pi` v0.84.1 is installed, but no LLM provider credentials are configured (no `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/etc., no `~/.pi` model config), and Pi's RPC mode (`modes/rpc/rpc-mode.js`) exposes no "invoke this tool directly" command — every path to a real `tools/call` goes through a model-driven `prompt` turn. Without a model able to decide to call a Rembric tool, a genuine 404 round-trip through the real `pi` binary cannot be produced here. What IS verified: the recovery logic itself, end-to-end against the real wire shape (404 status + `-32001` body), via `plugin.test.ts`'s stub-server arms (7.3) — this covers the client logic, not the real Pi TUI/RPC process.
- [ ] 7.6 **Operator step, and a merge gate (design Open Question 2).** DEFERRED to the orchestrating session per explicit instruction — not attempted by this applier.
- [x] 7.7 Record Codex CLI, opencode and Hermes as **unverified** unless actually driven, with one line each on why: **Codex CLI** — reaches `/mcp` through the Codex Rust binary's own MCP client; this repo has no scriptable non-interactive Codex session in this environment. **opencode** — its plugin is in-process JS/TS but still needs the opencode host CLI driving a real model turn to issue a `tools/call`, which is the same credential gap as Pi. **Hermes Agent** — same: an in-process Python provider whose lifecycle is driven by the Hermes host, not independently scriptable here. None of the three was driven against a real 404; none is described as "fine" — D8 already records that this repository cannot verify a host's reconnection policy from inside itself, and that stands for all three.

## 8. Measure — name the numbers this change must produce

- [ ] 8.1 One instrument per series, named. Memory figures are `heapUsed` after a forced GC; latency figures, if any, are end-to-end at the client. Never present the two in one table.
- [ ] 8.2 Re-run 1.2's arm after the change: with N=2000 ungraceful disconnects plus at least one live transport, one pass returns both registries to exactly the live count (> 0), and `heapUsed` returns to within a stated percentage of baseline. Publish that percentage; do not round it into "no leak".
- [ ] 8.3 Publish the pass's own wall clock at N=2000 candidates, and the `EXPLAIN QUERY PLAN` for the new existence read showing `sessions_token_status_idx` in use. If the plan is a scan, stop and consult `db-performance-auditor` before adding any index.
- [ ] 8.4 State the per-entry cost of each registry separately (router entry vs `{McpServer, transport}` pair). This is the correction to the issue's `≈120 B/entry` figure, which measured a different structure entirely; the PR body must say so rather than quietly replacing the number.

## 9. Verification

- [ ] 9.1 `pnpm run typecheck`
- [ ] 9.2 `pnpm run lint`
- [ ] 9.3 `pnpm test` (server + plugin workspaces). Run test suites in series, not in parallel.
- [ ] 9.4 `pnpm run check:spec-provenance` on the branch.
- [ ] 9.5 **Operator step.** Docker smoke against pre-existing seeded data, per `.agents/skills/rembric-smoke-tests/SKILL.md`: `pnpm run dev:docker:up` (note it reseeds from scratch — the corpus under test is the seeded one), then connect, disconnect ungracefully, force a pass, and confirm from the dashboard that no session row changed status and no memory row moved project as a result. Eviction must be invisible in the data.
- [ ] 9.6 `pnpm run eval` is **not** required: no retrieval path is touched. Stated so the omission is a decision, not an oversight.

## 10. Deferred and explicitly rejected — recorded so they are not lost

- [ ] 10.1 A capacity bound / LRU for either registry: rejected (design D3), because it makes eviction depend on load rather than liveness. Not deferred — do not add it later without a change that owns scope resolution.
- [ ] 10.2 Making the threshold configurable: rejected (D3). If an operator ever needs it, the change is to `TRANSPORT_STALENESS_MS` itself, which moves both clocks together by construction.
- [ ] 10.3 Counting an open standalone SSE stream as transport activity: deferred (Open Question 3), pending 1.5's measurement.
- [ ] 10.4 Persisting router state across restarts: out of scope and unchanged — the boot-time `abandonStale` pass already reconciles the DB with a cold router.
- [ ] 10.5 Any eviction hook on `SessionRouter.discoveryInFlight`: rejected with evidence (1.4). The delta records the correction so the issue's three-registry table does not resurface.
