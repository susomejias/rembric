# Tasks

## 1. Reproduce before changing anything

- [x] 1.1 Re-run the four probe arms at the real MCP edge (SDK `Client` with `capabilities: { roots: { listChanged: true } }`, a `ListRootsRequestSchema` handler counting calls, `client.sendRootsListChanged()`, against a real `createServer` on 127.0.0.1). Write them as the permanent arms of task 5 from the start rather than as a throwaway script — they are the regression suite. The CONTROL arm (one transport, answered discovery, three `memory.context` calls → exactly one `roots/list`, `suggestedSlugs: []`) MUST pass before the fix; if it fails, the harness is broken and nothing else measured here counts.
- [x] 1.2 Confirm the pre-fix numbers, which the proposal's `## Why` table publishes: CROSS `roots/list` on B goes 1 → 2 with B's scope and `source` unchanged and B's `suggestedSlugs` `[] → ['<b's own slug>']`; EMITTER 1 → 2 with `suggestedSlugs` `[] → ['<new slug>']` and the active project unchanged; GONE-QUIET warm ≈5 ms then 2507 ms and 2506 ms with the count reaching 3. If any of these does not reproduce, stop and revise the proposal — do not implement against a stale diagnosis.
- [x] 1.3 Confirm `grep -rn refreshRootsAfterChange apps/server/src` finds only the definition, and `grep -rn resetDiscoveryState apps/server/src` finds only `roots-discovery.ts` and `roots-discovery.test.ts:120`. Both are premises of design D1 and D8.
  - Both premises hold. One correction to this task's own wording: `resetDiscoveryState` also matched `mcp/server.ts:534-535`, its production caller — which the proposal and task 3.1 both describe, so the premise D8 rests on (the only caller OUTSIDE the module and the handler is that one test line) is the one that was confirmed. After the change both greps find nothing but `refreshRootsAfterChange`'s definition and its single call site in `ensureRootsDiscoveryRun`.

## 2. Per-transport ownership of the discovery state (design D3)

- [x] 2.1 In `apps/server/src/mcp/roots-discovery.ts`, replace the module-level `discoveryRunForTransport` (`:44`) with a per-connection record — `{ answered: Set<string>; refreshPending: boolean }` — reached through a `WeakMap<McpServer, DiscoveryState>`, resolved from `deps.server`. Keep the inner `(tokenId, mcpSessionId)` keying exactly as it is (`transportKey`, `:46`): one transport can carry entries for two tokens, and collapsing the key would change who gets asked, which this change does not do.
- [x] 2.2 `markDiscoveryRun` / `isDiscoveryRun` take the state (or the server) rather than reading a global. No change to `mcp/_shared.ts`, `mcp/transport.ts`, or any tool deps interface — if either file needs editing, the design has been departed from; stop and re-read D3.
- [x] 2.3 Delete `resetDiscoveryState` (`:58-61`) and its `beforeEach` call in `roots-discovery.test.ts:120`. Each fixture builds its own fake server, so the record is fresh by construction. Re-run the grep from 1.3 after: it must find nothing.

## 3. Wire the refresh (design D1, D2, D4, D6)

- [x] 3.1 In `apps/server/src/mcp/server.ts:516-536`, the `RootsListChangedNotificationSchema` handler records that a refresh is due on **its own** server's record and does nothing else. Remove the `await import('./roots-discovery.js')` (a static import has no cycle — `roots-discovery.ts` imports only types from `../server/session-router.js` and `../services/projects.js`) and remove the comment claiming the global reset is "safe because discovery is idempotent and cheap", which the CROSS and GONE-QUIET measurements refute. Per repo policy the replacement is at most one line documenting the non-obvious why (no in-flight tool call here, so the refresh cannot be issued from this handler) — the reasoning lives in the spec, not in a comment block.
- [x] 3.2 In `ensureRootsDiscoveryRun` (`:86-104`), keep the existing order and insert the refresh branch after it: path slug → in-flight promise → **unanswered slot → ordinary discovery** → **`refreshPending` → refresh** → return. D6: when the slot is unanswered, ordinary discovery runs and discharges the pending refresh, so exactly one `roots/list` is issued for that tool call.
- [x] 3.3 Route the refresh through the same single-flight promise (`setDiscoveryPromise` / `clearDiscoveryPromise`) so two concurrent tool calls cannot both issue a `roots/list`.
- [x] 3.4 D4: clear `refreshPending` **before** awaiting the `roots/list`, not after, so a timeout or rejection cannot leave it set. This is the difference between one budget expiry per notification and the measured 2507 ms-per-call stall; it is deliberately the inverse of the answered-slot rule and the spec says why.
- [x] 3.5 `refreshRootsAfterChange` (`:156-180`) itself keeps its body: suggestions only, no sentinel read or write, no activation. It already receives `toolCallRequestId` through `RootsDiscoveryContext`, stamped by the archived change (its task 3.3), so the delivery obligation is satisfied by passing the same ctx the resolver already builds.
- [x] 3.6 Fix the module docstring (`:13-33`), which lists the lazy-path outcomes and says nothing about the refresh path. One added line, in the same register as the existing list.

## 4. Assert the invariant, not just the behaviour (design D9)

- [x] 4.1 Add a case to `apps/server/src/test/invariants.test.ts` asserting that `roots-discovery.ts` declares no module-level mutable registry of per-transport state and exports no helper that clears such state for all transports. Model it on the existing grep-based confinement gates in that file. Reason it exists: the isolation only breaks observably when two transports are live, so a future re-introduction would pass every single-transport test.

## 5. Tests — one arm per defect, plus the control

- [x] 5.1 **CONTROL (must pass on both sides).** One transport, answered discovery, three scope-resolving tool calls → exactly one `roots/list`, correct scope each time, `suggestedSlugs: []`. Without it, a harness that never reaches the discovery path is indistinguishable from a correct one (`mcp-api/spec.md` requires this control for the roots arms).
- [x] 5.2 **Defect 2 — the discriminating arm is TWO live transports.** A and B both answered and both scoped to their own project; A emits `list_changed`; B then makes a scope-resolving tool call. Assert B's `roots/list` count stays **1**, and B's project, `source` and `suggestedSlugs` are all unchanged. A single-transport test passes either way and proves nothing.
- [x] 5.3 **Defect 1 — the refresh actually happens, and this test MUST be red without the wiring.** `roots-discovery.ts` had no coverage beyond `deriveSlugFromUri` until this morning, so assume nothing is guarded: A scoped to `old` via roots, roots change to `new` (an existing project), A emits `list_changed`, then A calls `project.current` → `suggestedSlugs: ['new']` and the active project still `old`. Verify redness by mutation (6.1), not by reading.
- [x] 5.4 **Defect 1b — one attempt per notification (D4).** A answers once, then stops answering; A emits `list_changed`; then two scope-resolving tool calls. Assert the total `roots/list` count is **2** (discovery + one refresh attempt), that the second tool call does **not** wait on the budget, and that the connection keeps the project discovery activated. Time it, because the assertion is about latency: second call < 500 ms against a pre-fix 2506 ms.
- [x] 5.5 **Refresh never activates.** A transport with no active project whose roots resolve to an existing project: after `list_changed` + a tool call, the slug is in `suggestedSlugs`, the resolved project is still the default one and `source` reports the default fallback, not `'roots'`.
- [x] 5.6 **Empty / underivable roots clear the suggestion list** (`roots-discovery.ts:167`, `:172` — untested today).
- [x] 5.7 **D6 — `list_changed` before any answered discovery.** First `roots/list` unanswered, then `list_changed`, then a tool call: ordinary discovery runs, activates the discovered project, and issues exactly **one** `roots/list` for that call — not one for discovery and another for the refresh.
- [x] 5.8 **Delivery obligation on the refresh path.** Reuse the existing `suppressStandaloneStream` harness (`mcp-integration.test.ts::connectRoots`): with the client's standalone GET answered 405, the refreshing `roots/list` still reaches the client and the refreshed suggestion is observable on that tool call. Retries stay disabled on every arm above, per `mcp-api/spec.md`: a retried test asserts only that one attempt of several passed.
- [x] 5.9 Unit arms in `roots-discovery.test.ts` for the state record: two distinct fake servers, a refresh pending on one, and the other's `answered` set and suggestions untouched. Use two distinct objects — reusing one fake server for "two transports" now shares state and would silently invert what the test asserts (design Risk 2).

## 6. Mutation check — each guard independently load-bearing

`scripts/mutate.mjs` counts occurrences and **skips** a non-unique match, reporting the skip as uncovered. So for every `--mutation` string below, first run `grep -c '<string>' <file>` and confirm it prints `1`; if not, extend the string with surrounding context until it does. A careless string reads as a failure that is really a skip.

- [x] 6.1 The `refreshPending` branch in `ensureRootsDiscoveryRun` → force it never to run. 5.3, 5.4 and 5.8 must go red.
- [x] 6.2 The clear-before-await in 3.4 → move it after the await (or delete it). 5.4 must go red — specifically its latency assertion. If only the count assertion reddens, the latency arm is not doing its job.
  - **Both variants run. DELETING the clear is CAUGHT by 5.4 on its latency assertion** (`warm 7ms, first-after 2508ms, roots/list count 3: expected 2507.9 to be less than 500`) — the pre-fix stall exactly. **MOVING it after the await is NOT CAUGHT, and that is a real finding, not a test gap** (6.7): `singleFlight` wraps the attempt in `.catch(() => undefined)`, so the post-await assignment still runs after a timeout or rejection and there is no reachable state where the two orderings differ today. The clear-before-await is kept because D4 mandates an ordering that does not depend on that swallow staying in place, but it is defence-in-depth rather than an independently observable guard. No test was added for it: a test for an unreachable state would pass on both sides of the mutation and prove nothing.
- [x] 6.3 The per-server state lookup → return one shared record for every server. 5.2 and 5.9 must go red; the CONTROL must stay green.
- [x] 6.4 The D6 ordering in 3.2 → let the refresh branch win over the unanswered-slot branch. 5.7 must go red.
- [x] 6.5 The empty-roots clear (`roots-discovery.ts:167`) → delete the `setSuggestedSlugs(…, [])` call. 5.6 must go red.
- [x] 6.6 The flag assignment in the notification handler (`mcp/server.ts`) → delete it. 5.3 must go red. This is the mutation that proves defect 1's test is a guard rather than a description.
- [x] 6.7 Record every mutation that reddens **nothing** as the finding it is, and fix the test rather than the note.

## 7. Measure — name the numbers the change must produce

- [x] 7.1 One instrument, stated: all figures are **end-to-end tool-call latency at the SDK client**, not an isolated statement's timing.
- [x] 7.2 CROSS: B's `roots/list` count **2 → 1**, and B's `suggestedSlugs` `['<b's own slug>'] → []`.
- [x] 7.3 GONE-QUIET: the second and third tool calls after `list_changed` go from **2507 ms / 2506 ms → under 500 ms** (warm baseline 5 ms), with the total `roots/list` count **3 → 2**. The first call after the notification may still spend one budget (≈2500 ms); that is D4's accepted cost, and the measurement must say so rather than quietly excluding it.
- [x] 7.4 EMITTER: unchanged, deliberately — `suggestedSlugs` still `[] → ['new']` and the total count still 2. State this explicitly, because "no regression on the path that already worked" is a result, not an omission.
- [x] 7.5 No memory figure is claimed. The ≈120 bytes/entry (22.9 MB at 200 000 entries) in the proposal is the _pre-fix_ leak's size and is not re-measured; after D3 the property asserted is ownership (task 4.1), not a byte count.

## 8. Verification

- [x] 8.1 `pnpm run typecheck`
- [x] 8.2 `pnpm run lint`
- [x] 8.3 `pnpm test`
- [x] 8.4 `pnpm run eval` is **not** required: no retrieval, ranking, embedding or scoring path is touched. Recorded so the omission reads as a decision.
- [x] 8.5 `openspec validate fix-the-roots-discovery-lifecycle --strict` and `pnpm run check:delta-freshness`. The freshness gate reports exactly **one** body advisory, on the "once-only guarantee" paragraph, which this change rewrites on purpose. A second advisory means the delta has drifted from the published spec — reconcile before archiving. The gate cannot see scenario bodies (it compares only the text before the first scenario, and matches scenarios by title), so hand-diff the two scenarios this change edits: "An answered discovery is not re-issued" and "Roots changes mid-session via `notifications/roots/list_changed`". No published scenario title is renamed, and no `## RENAMED Requirements` block is needed.

## 9. Docker smoke against pre-existing seeded data

- [x] 9.1 Follow `.agents/skills/rembric-smoke-tests/`. `pnpm run dev:docker:up` runs `seed-dev --reset` on every boot, so bring the stack up **first**, confirm a non-empty corpus (`memory` count > 0 on `/dashboard`), and only then probe — a probe against an empty DB proves nothing about production behaviour.
- [x] 9.2 Verify your worktree is the one mounted (`docker inspect rembric-dev --format '{{range .Mounts}}…'`) before trusting any result.
- [x] 9.3 Probe with a real MCP client against the container: connect two clients advertising `roots.listChanged` on `/mcp` with roots naming two different seeded projects, confirm each resolves to its own project, emit `list_changed` on one, and confirm the other receives no `roots/list` and its `project.current` is byte-identical before and after. This is the smoke equivalent of 5.2, at the real HTTP edge, against seeded data.
- [x] 9.4 Confirm a path-scoped connection (`/mcp/<slug>`) is untouched: it short-circuits on `pathSlug` and must issue no `roots/list` at all, before or after a `list_changed`.
- [x] 9.5 Tear down.
  - Method note: a `rembric-dev` container was already up from a prior boot, and its `tsx watch` had stopped reacting to bind-mount writes, so the running process could not be trusted to be this change's code. `docker compose … restart` was used instead of `dev:docker:up` — it re-runs the same container CMD (`seed-dev --reset` then `tsx watch`), which is the same reseed the task describes. `data-dev/` was copied out beforehand and restored byte-for-byte after teardown, so the operator's dev DB is as they left it. Corpus at probe time: memory=35, projects=20, sessions=5. 20/20 probe assertions passed, including the gone-quiet latency at the HTTP edge (first-after 2508 ms, second **3 ms**).

## 10. Deliberately out of scope — recorded so it is not lost

- [x] 10.1 **`ROOTS_LIST_TIMEOUT_MS` stays 2500** (design D7). Not an oversight: its original justification rested on a diagnosis this morning's archived change refuted, so there is no evidence either way, and retuning is blocked on the still-open question of which shipped clients advertise `capabilities.roots` (`archive/2026-08-09-route-roots-discovery-over-the-tool-call-stream/design.md:140`). Do not change the constant in this change, even though task 7.3 makes it visible.
- [x] 10.2 **The delivery mechanism and the initial-discovery slot-consumption rule are inputs, not questions.** Both were settled and archived this morning. A task here that re-opens either is out of scope by construction.
- [x] 10.3 **`SessionRouter.entries` and `discoveryInFlight` leak on the identical key** (`session-router.ts:44-46`), and `McpTransportManager.sessions` retains a whole `{server, transport}` pair for a client that vanishes without a DELETE. Not fixed here; both need the same unanswered "when is a silent client gone" decision (design Open Question 1).
- [x] 10.4 **A suggestion naming the transport's own active project is not suppressed** (design Open Question 2). Measured today; cosmetic, since `project.use` on the active slug is idempotent, and suppressing it means modifying `mcp-api/spec.md:1122`.
- [x] 10.5 **Whether `getRequestContext()` is live inside an SDK notification handler was not measured** (design Open Question 3). D3 makes the answer unnecessary here; if a later change needs it, measure with a control (a tool handler in the same server asserting the store IS visible).
