# Tasks

## 1. Reproduce — in the full file, never in isolation

- [x] 1.1 Run the target test **as part of the whole file**: `pnpm vitest run src/test/mcp-integration.test.ts` from `apps/server`, with `{ retry: 3 }` still in place, and read the reported **failed attempts** for `memory.context as the FIRST call on an unscoped connection with a discoverable root returns project scope`. Expect ≥1 failed attempt and a duration near 2529 ms. **An isolated `-t` run is a broken probe** — measured, the cold regime is the only one where the client's standalone GET wins, so `-t` passes on both sides of this change and proves nothing. Do not use it at any point in this task list as evidence.
- [x] 1.2 Confirm the mechanism rather than the symptom: instrument the transport's stream map (or log from `roots-discovery.ts` around the `listRoots` call) and record whether the standalone GET stream was registered at send time. Expected on a failing attempt: **not registered**, and the `listRoots` promise settling only at the 2500 ms bound. A latency near-but-under the bound would falsify the diagnosis; a settle time pinned exactly at the bound confirms it.
- [x] 1.3 Record the "before" numbers now, from one instrument: the target test's own vitest-reported duration and its failed-attempt count. These are the only figures §7 may compare against. **Never quote a whole-file total** — the file bootstraps two real servers and its total moves for unrelated reasons.
- [x] 1.4 Note in the apply report that `apps/server/src/mcp/roots-discovery.test.ts` today covers **only `deriveSlugFromUri` (9 cases)**. Every other function in that file is unguarded, so anything §3/§4 adds there is the first thing holding it — a green file is not a covered one.

## 2. Capture the in-flight tool-call id (design D2)

- [x] 2.1 Add a small AsyncLocalStorage module beside `apps/server/src/server/request-context.ts` holding the current tool call's request id. Keep it separate from `RequestContext`: `runWithContext` wraps the whole POST (`server/http.ts:382-385`) and a POST may be a JSON-RPC batch (`webStandardStreamableHttp.js:483-486` iterates `messages`), so there is no single id at that layer.
- [x] 2.2 Wrap the callback inside `createMcpServer`'s local `registerTool` (`apps/server/src/mcp/server.ts:180-195`) to read `extra.requestId` and run the handler inside that store. No handler signature changes: the SDK already calls `cb(args, extra)` (`server/mcp.js:438`) and `handleContext.bind(null, deps)` (`memory-tools.ts:605`) already receives `extra` as the third positional argument and discards it (`handleContext` declares only `(deps, args)`, `memory-tools.ts:1273-1283`).
- [x] 2.3 Verify the wrapper is the sole registration funnel before relying on it: `grep -n "server.registerTool\|\.registerTool(" apps/server/src/mcp/*.ts` must show the SDK call only inside the local wrapper. A second direct `server.registerTool` call would be a tool that bypasses the capture — if one exists, route it through the wrapper in this task rather than special-casing it.
- [x] 2.4 Do **not** thread a `requestId` parameter through `resolveEffectiveScope` / `requireScope`. Rejected in design D2: ~20 call sites across 6 files (`memory-tools.ts` ×8, `session-tools.ts` ×4, `relations-tools.ts` ×3, `observability-tools.ts` ×3, `prompt-tools.ts` ×2, `project-tools.ts` ×1), and a future tool that omits the argument reverts silently to today's behaviour.

## 3. Route the request (design D1)

- [x] 3.1 `apps/server/src/mcp/_shared.ts:80-83` — read the captured id and pass it into `ensureRootsDiscoveryRun`'s context.
- [x] 3.2 `apps/server/src/mcp/roots-discovery.ts:123` — pass `relatedRequestId` in the existing `RequestOptions` argument to `listRoots`. This is a parameter, not an API change: `listRoots(params?, options?)` (`server/index.d.ts:168`) → `Protocol.request` destructures `relatedRequestId` (`shared/protocol.js:613`) → `transport.send` (`:743`).
- [x] 3.3 Same at `roots-discovery.ts:148` (`refreshRootsAfterChange`). It is dead code today (no production caller — `grep -rn refreshRootsAfterChange apps/server/src` finds only its definition), but leaving one call site unstamped is exactly how the next reader concludes the two paths differ on purpose. One line; do not revive or otherwise change the function.
- [x] 3.4 Explicit fallback: when no id is captured, send unstamped exactly as today. The worst case must be current behaviour, never a throw.
- [x] 3.5 No new comment beyond, at most, one line naming why the id is stamped. The rationale lives in `openspec/specs/projects/spec.md` (delivery obligation); do not restate the design in code.

## 4. Stop poisoning the connection (design D3)

- [x] 4.1 `apps/server/src/mcp/roots-discovery.ts` — move `markDiscoveryRun` out of its pre-`try` position (`:117`) so it fires only on a **definitive outcome**: the client answered (root list, empty or not), the client returned a JSON-RPC error, or the client advertises no `roots` capability (`:119-120`). A timeout, an undelivered request or a transport failure must leave the slot unconsumed.
- [x] 4.2 Check the interaction with the single-flight guard before assuming this is one line: `ensureRootsDiscoveryRun` (`:95-109`) short-circuits on `getDiscoveryPromise` and on `isDiscoveryRun`, and `maybeDiscoverViaRoots` re-checks `isDiscoveryRun` at `:116`. A settled promise left in the router would re-block the retry that 4.1 is meant to enable — confirm the router's promise is cleared (or not consulted) once settled, and fix it here if not.
- [x] 4.3 Do not add a retry counter or backoff (design D3). The throttle is that discovery only runs on unscoped connections and only until an answer arrives.

## 5. Tests — assert the routing, not the outcome

- [x] 5.1 **The routing assertion is the point.** Add a test that discovery **succeeds while the standalone GET stream is absent** (`standaloneUp === false` at the moment of the send, asserted, not assumed). This is the shape the reproduction executed. A test that only checks the resolved scope passes on both sides of the change whenever the race is won, so it cannot be the guard.
- [x] 5.2 **Remove `{ retry: 3 }` from both tests** — `apps/server/src/test/mcp-integration.test.ts:3005` and `:3049` — and drop the two now-false `retry:` comments above them (they cite the `d62d254` diagnosis this change refutes). While `retry` stands, nothing in this section is a gate. `:3049` has 0 failed attempts today, so removing it costs nothing; remove it anyway so it stops being cited as precedent.
- [x] 5.3 **Warm arm**: the discovered-scope assertion must be exercised on a fresh connection in a process that has already served ≥3 prior client connections on the same host, with `retry: 0`. Today's suite goes red on this arm — that redness **is** the regression this change turns green. Verify it is red before §3/§4 land.
- [x] 5.4 **Cold arm as the control**: the same assertion in a process that has served no prior traffic. It passes today (measured: 0 failed attempts) and must keep passing. Without it, a warm-only test cannot distinguish a fix from a harness that never reaches the discovery path.
      **Deviation (measured):** the arm exists (`resolves the discovered project on the first connection a server serves`, first test on its own freshly bootstrapped server) but it does NOT pass without the fix — mutation A reds it too. A process that has already served ~90 connections is not cold, and a per-process cold regime is not expressible inside a suite run. The control role is therefore carried by `resolves the default project when the client advertises no roots capability` (green on both sides) plus the routing arm's own live-instrument assertion that its POSTs reached the server.
- [x] 5.5 **Poisoning assertion, directly**: after a deliberately dropped `roots/list`, a **second** `memory.context` on the same connection must still resolve the discovered project. Drop the first request at the transport (do not simply stub `listRoots` to reject — a rejection is an answer and, per D3, legitimately consumes the slot; the case under test is _no answer_).
      **Deviation:** the drop is implemented as a client `roots/list` handler that never settles, so the server's request IS delivered and no answer of any kind arrives (the 2500 ms budget expires). Dropping the frame inside the client transport's SSE parser would test the same observable through more test-only machinery.
- [x] 5.6 Add unit coverage for the D3 outcome classification in `apps/server/src/mcp/roots-discovery.test.ts`: answered / empty list / JSON-RPC error / no `roots` capability all consume the slot; timeout does not. Per 1.4 this file currently guards only `deriveSlugFromUri`, so these are new ground.
- [x] 5.7 Keep the `retry: 0` requirement visible in the test file as a one-line note pointing at the spec, not as a paragraph. The reasoning lives in `openspec/specs/mcp-api/spec.md`.

## 6. Mutation check — each half must be independently load-bearing

- [x] 6.1 **Uniqueness first.** `roots-discovery.ts` contains `listRoots(` at `:123` and `:148`, and `markDiscoveryRun` at both its definition (`:55`) and its call (`:117`). `scripts/mutate.mjs` does a literal replace and **skips** a non-unique match, counting the skip as uncovered — so the failure mode is a `SKIP` line misread as a pass. For every `--mutation` string, confirm `grep -c -F "<string>" apps/server/src/mcp/roots-discovery.ts` prints exactly `1` before running; extend the string upward to the nearest unique line if not.
- [x] 6.2 Mutation A — revert `relatedRequestId` (send unstamped). Must red the routing test from 5.1 and the warm arm from 5.3, **by name**. If only the cold arm reds, 5.3 is not warm and must be fixed.
- [x] 6.3 Mutation B — move `markDiscoveryRun` back before the `try`. Must red the poisoning test from 5.5 **by name**. It must NOT be caught only by 5.1 — if 5.1 is the only red test, 5.5 is not exercising the drop.
- [x] 6.4 Run them separately, one per invocation, so the two halves are proven independent:
      `node scripts/mutate.mjs --file apps/server/src/mcp/roots-discovery.ts --spec src/test/mcp-integration.test.ts --mutation '<A, verified unique>' --with '<A reverted>'` and the same for B against `src/mcp/roots-discovery.test.ts` where the assertion lives there.
- [x] 6.5 A `SKIP` in the output is a failure, not a pass. Read the reported test names, not just the caught/not-caught verdict.

## 7. Measure — one instrument, end-to-end

- [x] 7.1 Re-run §1.1 exactly (full file, same command, `retry` now removed) and record the target test's own vitest-reported duration. Expected: 2529 ms → **under 300 ms**. Quote it as the end-to-end figure for that test and name the instrument.
- [x] 7.2 Do **not** quote a whole-file or whole-suite total as the improvement, and do not compare figures taken under different instrumentation (coverage on vs off, `-t` vs full file). The before/after pair must come from the same command shape.
- [x] 7.3 Record failed attempts on the warm arm: expected ≥1 before, **0** after, with `retry: 0`.

## 8. Documentation drift touched by this change (design D6)

- [x] 8.1 `apps/server/vitest.config.ts:22-26` — the comment says a "1s budget" and discovery falling "back to global". The budget is 2500 ms and the global scope was retired (`openspec/changes/archive/2026-08-05-retire-the-global-scope`). Correct both. Also re-read whether `fileParallelism: false` is still justified by the stated reason once delivery no longer depends on event-loop timing; if the justification no longer holds, **say so in the apply report and leave the setting alone** — flipping it is a suite-wide change needing its own evidence.
- [x] 8.2 `apps/server/src/mcp/roots-discovery.ts:9-17` and `:81-93` — both document an eager `server.oninitialized` path that no longer exists, and `:9-17` asserts `roots/list` from `oninitialized` "always times out", which is the claim this change corrects. Replace with a minimal pointer to the spec; do not write a new essay in the code.
- [x] 8.3 `apps/server/src/mcp/roots-discovery.ts:35-43` — the `ROOTS_LIST_TIMEOUT_MS` comment justifies 2500 ms with the `d62d254` reasoning (async scrypt slowing the client's response). Measured, the request never arrived, so that justification is false. Correct the comment; **do not change the value** (design open question 3).
- [x] 8.4 `apps/server/src/mcp/_shared.ts:68-71` — the resolver docstring also cites the eager `oninitialized` fallback. One-line correction.

## 9. Verification

- [x] 9.1 `pnpm run typecheck`
- [x] 9.2 `pnpm run lint`
- [x] 9.3 `pnpm test`
- [x] 9.4 `pnpm run eval` is **not** run: no retrieval, ranking or scoring path is touched. Recorded so the omission is a decision, not a gap.
- [x] 9.5 `openspec validate route-roots-discovery-over-the-tool-call-stream --strict`
- [x] 9.6 `pnpm run check:delta-freshness` — expect exactly **1 body difference, in `projects`**: the rewrite of the `roots/list` sentence at `openspec/specs/projects/spec.md:85` (dropping "once after `initialized`", whose "once" is rescoped and whose "after `initialized`" has been stale since discovery went lazy). Expect **0** in `mcp-api` — that delta only appends. Expect **no dropped scenarios** from either; both keep every existing scenario verbatim, so any reported drop is a copy error in a MODIFIED block. A second difference in `projects`, or any difference in `mcp-api`, is a silent revert of another change's published text. A difference attributed to a _different_ active change is not this change's.

## 10. Docker smoke against pre-existing seeded data

Standing requirement for anything touching MCP or production behaviour. `dev:docker:up` runs `seed-dev --reset` inside the container command, so **every boot wipes and reseeds** — do not point it at a corpus you want to keep. If it dies with `SQLITE_CANTOPEN`, run `chown -R 10001:10001 data-dev`.

- [x] 10.1 `pnpm run dev:docker:up`; confirm the seeded corpus is present before probing.
- [x] 10.2 Connect a real MCP client to **`/mcp`** (unscoped) advertising `capabilities.roots`, with a first root whose basename equals a seeded project slug. Call `memory.context` as the first tool call and assert the returned `scope` is that project's, not the default project's.
- [x] 10.3 Control that must pass: the same connection advertising **no** `roots` capability resolves to the default project. Without it, "the discovered project" everywhere could just mean the default project happens to be that project.
- [x] 10.4 Second control: `/mcp/<seeded-slug>` still pins that project and a slug naming no project still refuses with `project_not_found`. This change touches the resolver's discovery branch and must not move the path-scoping contract.
- [x] 10.5 Save one memory over the discovered connection and confirm from the dashboard (`/dashboard/memories`) that the row landed in the discovered project — the misfiling is the actual harm, and it is only observable at the row.
- [x] 10.6 State plainly in the apply report what the smoke did **not** cover: it does not reproduce the ~1 ms arrival race (a container gives no control over which fetch wins the keep-alive socket). The race is covered by §5/§6 in-process, where the ordering is controllable. Do not claim the smoke reproduced it.

## 11. Deliberately out of scope — recorded so it is not lost

- [x] 11.1 `refreshRootsAfterChange` (`roots-discovery.ts:140-164`) is **dead code**: no production caller. This change stamps its `listRoots` for consistency (3.3) and does nothing else with it. Deleting it, or wiring it up, is a separate change.
- [x] 11.2 `resetDiscoveryState` is marked "Test-only helper" (`roots-discovery.ts:63`) yet is called from the `RootsListChangedNotificationSchema` handler (`mcp/server.ts:531-532`), and it clears the sentinel Set **globally** — so one client's `list_changed` re-arms discovery for **every other transport in the process**. Real defect, separate concern, needs its own evidence and its own change. Not fixed here.
- [x] 11.3 `discoveryRunForTransport` (`roots-discovery.ts:49`) has no eviction path; `transport.onclose` (`mcp/transport.ts:71-75`) drops the session but leaves the sentinel. Design open question 2. Default: leave it, and fold eviction into the same follow-up as 11.2.
- [x] 11.4 `ROOTS_LIST_TIMEOUT_MS` is **not** retuned (design open question 3). Its current value rests on a refuted diagnosis, so it has no evidence in either direction; re-tuning needs per-client data blocked on open question 1.
- [x] 11.5 **Rejected, not deferred**: configuring an `eventStore` (replay needs a `Last-Event-ID` the client deliberately omits — `client/streamableHttp.js:375`); awaiting the standalone GET before sending (the SDK calls that stream optional — `:80-82`); moving discovery back to `oninitialized`. Rationale in design D1. Recorded so none is re-proposed as the obvious missing fix.
- [x] 11.6 **Open question left open, deliberately**: whether Claude Code, Codex CLI and opencode advertise `capabilities.roots`. All three funnel through `apps/plugin/bin/rembric-bridge.mjs:56` when `.rembric` is absent, and `mcp-remote` forwards the host's capabilities verbatim, so no harness can settle it — it needs one manual session per host logging `getClientCapabilities()`. It changes the severity claim, not the fix, which is why this change does not wait on it. If someone runs those sessions, record the answers against design open question 1. Measured negative already in hand: Pi cannot hit the race, `apps/plugin/.pi-plugin/index.ts:146` sends `capabilities: {}`.
