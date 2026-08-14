# Tasks

## 1. Reproduce and quantify before changing anything

- [x] 1.1 Built at the real MCP edge with the real SDK `Client`, using a bare `node:http` server + real `McpTransportManager`/`SessionRouter` (temporary probe, deleted after measuring; permanent coverage lives in `transport.test.ts`/`transport-state-reaper.test.ts`). CONTROL: `client.transport.terminateSession()` (the actual DELETE — `client.close()` alone only aborts locally, confirmed by reading the SDK's `close()` vs `terminateSession()`) returns both registries to their pre-connection size. LEAK: N=50 ungraceful disconnects (drop the reference, no DELETE) → both registries retain exactly N entries.
- [x] 1.2 N=2000, `process.memoryUsage().heapUsed` after `global.gc()`, each registry isolated from the other: **`SessionRouter` entry alone ≈262 B/entry** (523,096 B / 2000); **`{McpServer, transport}` pair alone ≈106,201 B/entry** (212,402,424 B / 2000).
- [x] 1.3 Reproduced against a real bootstrapped server, pre-fix (`http.ts` temporarily reverted via `git stash` for this measurement only, then restored): unknown `mcp-session-id` on `tools/call` → **`400` / `-32000` / `"Bad Request: Server not initialized"`**, exactly as D6 predicted. Control (live id) → `200`. Confirmed the fix flips this to `404`/`-32001` by re-running the identical probe after restoring.
- [x] 1.4 `grep -n "entries.delete" apps/server/src/server/session-router.ts` against `HEAD` (pre-fix): no matches, confirming the leak. `grep -rn "setDiscoveryPromise" apps/server/src`: one production writer (`mcp/roots-discovery.ts:144`) plus test call sites only, confirming `discoveryInFlight` does not leak.
- [x] 1.5 Measured directly (`transport.test.ts`): the SDK client's standalone GET SSE stream IS itself one `getOrCreate` hit (bumps `lastSeenAt` once, at open) — but merely holding it open issues no further request, so `lastSeenAt` does not advance again while it stays open. An idle-but-still-streaming client therefore DOES read as stale under condition (b) once the window elapses; this is the residual case Risk 2 names, and the answer is now on the record rather than reasoned.

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

- [x] 8.1 One instrument per series, named. Memory figures are `heapUsed` after a forced GC; latency figures, if any, are end-to-end at the client. Never present the two in one table.
- [x] 8.2 Re-run 1.2's arm after the change: with N=2000 ungraceful disconnects plus at least one live transport, one pass returns both registries to exactly the live count (`SessionRouter.size()` and the transport map both went from 2001 to 1; the survivor's identity kept `mcpTransport.has()` true throughout). `heapUsed` (after forced GC) is **99.7% of the leaked delta immediately after the pass** — `evict()`'s `transport.close()`/`server.close()` are fire-and-forget, matching the pre-existing `close()` method's own behaviour, so an immediate GC undercounts what the pass released. After a 500 ms settle window, a second forced GC shows **31.9% residual**. Not rounded to "no leak": the residual is real and plausibly includes this harness's own artifact (client and server share one process/event loop here, unlike a genuinely dropped remote client whose socket is gone on the OS side).
- [x] 8.3 Pass wall clock at N=2000 candidates: **~285 ms** (`process.hrtime.bigint()` around the single `runTransportStateReaperPass` call). `EXPLAIN QUERY PLAN` for the existence read: `SEARCH sessions USING INDEX sessions_active_transport_idx (token_id=? AND project_id=? AND <expr>>?)` — not a scan. Correction to this task's own text: SQLite picks `sessions_active_transport_idx` (the partial index from `0027_tune_hot_query_paths`, built for exactly this predicate shape: `(token_id, project_id, COALESCE(last_activity_at, started_at)) WHERE status='active' AND deleted_at IS NULL`), not the more generic `sessions_token_status_idx` this task named — a better existing index, still reused, no new one added.
- [x] 8.4 Per-entry cost, N=2000, `heapUsed` after forced GC, each isolated from the other (router entries created with no transport; transport pairs created with no additional router entries beyond the one each carries): **`SessionRouter` entry ≈262 B/entry** (523,096 B / 2000); **`{McpServer, transport}` pair ≈106,201 B/entry** (212,402,424 B / 2000) — three orders of magnitude apart, and the correction to the issue's `≈120 B/entry` figure, which measured the roots-discovery module-global `Set` this proposal's `## Why` shows no longer exists.

## 9. Verification

- [x] 9.1 `pnpm run typecheck` — clean, all workspaces.
- [x] 9.2 `pnpm run lint` (`eslint .`) — clean.
- [x] 9.3 `pnpm test` — 148 test files / 2818 passed / 10 skipped (`apps/server`, includes every `.pi-plugin` and shared-plugin test via the vitest `include` globs) + 91 passed (Hermes Python `unittest`). Series, not parallel (`fileParallelism: false` already set).
- [x] 9.4 `pnpm run check:spec-provenance` → `spec-provenance: ok (origin/main...HEAD)`.
- [x] 9.5 Run against `pnpm run dev:docker:up` (mounts verified against this worktree via `docker inspect rembric-dev`), pre-existing seeded corpus (`memory=35 sessions=5 projects=20`, unchanged by this run — not reseeded, since only the process was restarted for the threshold override below, not the container). `TRANSPORT_STALENESS_MS` and the reaper tick period were temporarily overridden to `5_000` in the bind-mounted source (`tsx watch` respawns on save), reverted (`git checkout`) immediately after measuring, and the process respawned a third time confirming both the revert and a healthy container. Connected over real `/mcp` with the seeded `demo-writer` token, called `project.use({slug:'demo'})` (pins a router entry, `source: tool-explicit`), then went ungracefully silent. `docker logs` showed `transport-state reap: 1 router entry, 1 transport(s) evicted` within one tick; a follow-up `tools/list` on the same `mcp-session-id` got real `404`/`-32001`. A full before/after dump of every `sessions` and `memory` row (id, status, project_id, token_id, ended_at) via a read-only `better-sqlite3` script showed **zero diffs and zero new rows on either table** — eviction was invisible in the data, including against the two PRE-EXISTING seeded `active` sessions that share this token+project (their staleness under the shrunk window is what correctly let this transport evict at all, confirming condition (a) reads real rows, not just the one this test created). Torn down (`docker compose … down --remove-orphans`) and the seeded `demo-writer` token deleted by name from the scratchpad log it landed in.
- [x] 9.6 `pnpm run eval` is **not** required: no retrieval path is touched. Stated so the omission is a decision, not an oversight.

## 10. Deferred and explicitly rejected — recorded so they are not lost

- [ ] 10.1 A capacity bound / LRU for either registry: rejected (design D3), because it makes eviction depend on load rather than liveness. Not deferred — do not add it later without a change that owns scope resolution.
- [ ] 10.2 Making the threshold configurable: rejected (D3). If an operator ever needs it, the change is to `TRANSPORT_STALENESS_MS` itself, which moves both clocks together by construction.
- [ ] 10.3 Counting an open standalone SSE stream as transport activity: deferred (Open Question 3), pending 1.5's measurement.
- [ ] 10.4 Persisting router state across restarts: out of scope and unchanged — the boot-time `abandonStale` pass already reconciles the DB with a cold router.
- [ ] 10.5 Any eviction hook on `SessionRouter.discoveryInFlight`: rejected with evidence (1.4). The delta records the correction so the issue's three-registry table does not resurface.
