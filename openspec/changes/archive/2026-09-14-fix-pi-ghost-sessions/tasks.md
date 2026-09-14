# Tasks: fix-pi-ghost-sessions (issue #377)

Scope is fixed by `proposal.md` (A + B-narrow + D3 + D4′) and every code shape, test name
and pin value comes from `design.md` (`## 0` gate, Decisions 1–7). The design is
authoritative: do not redesign, rename or fold. Spec deltas under `specs/` are already
written and are NOT part of these estimates.

Ordering rule for every unit: **RED → GREEN → mutation → REFACTOR**. The mutation
obligation is the repo's: `node scripts/mutate.mjs --file … --spec … --mutation … --with …`
(exit non-zero = the guard is uncovered). A test that is green on both sides of a change
proves nothing here.

## Review Workload Forecast

| Field                   | Value                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Estimated changed lines | ~950–1,050 (code + tests; spec deltas excluded)                                      |
| 400-line budget risk    | High                                                                                 |
| Chained PRs recommended | Yes                                                                                  |
| Suggested split         | PR 1 (§1.1–1.4, 1.8) → PR 2 (§1.5–1.7, 1.9–1.13) → PR 3 (§2) → PR 4 (§3) → PR 5 (§4) |
| Delivery strategy       | ask-on-risk                                                                          |
| Chain strategy          | pending                                                                              |

```text
Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High
```

Both decision triggers are red: the blocking prerequisite gate (§0) is unmet, and the
delivery/chain strategy is not yet chosen. Per `ask-on-risk`, stop and ask the owner
before apply starts; do not infer a chain strategy and do not declare a `size:exception`.

## 0. Blocking pre-apply gate — prerequisite change must be archived first

**Measured status at authoring time: RED.** `openspec/changes/expose-session-start-agent/`
still exists as an active change (`proposal.md`, `design.md`, `specs/`, `tasks.md`,
`.openspec.yaml`) and has no entry under `openspec/changes/archive/`. The canonical
`openspec/specs/mcp-api/spec.md` does not yet carry the `agent` field text its delta owns
(no match for `MAY differ from the`, `reports the attribution`, `REQUIRED \`agent\` field`).
That change also owns the same`memory.session_start`description literal and the same`mcp-integration.test.ts` pins this change re-measures (design.md §0, proposal.md
"Sequencing dependency"). Requirement: this change applies **after** that archive, so
nothing below may run until §0.2 closes.

- [x] 0.1 Re-confirm the gate before any edit: `ls openspec/changes/archive/ | grep expose-session-start-agent` returns the directory, `ls openspec/changes/expose-session-start-agent` fails, and `openspec/specs/mcp-api/spec.md` carries the `agent` field requirement (grep for `MAY differ from the \`agent\` you passed`). All three must hold; report the three raw results, do not paraphrase them. <!-- sdd-owner: implementation -->
- [x] 0.2 Owner lifecycle gate — archive `expose-session-start-agent` (or explicitly reorder it) before apply begins. If the owner cannot archive it, stop the change here; do not rebase the deltas on an unarchived tree and do not hand-merge its spec text. <!-- sdd-owner: parent -->
- [x] 0.3 After §0.2, re-read `apps/server/src/mcp/server.ts:313` and `apps/server/src/test/mcp-integration.test.ts:793–805` and record the current `memory.session_start` description length in the PR description, because every citation in `design.md` was taken from the post-archive tree (design.md §0 point 3). If the measured length is not 818, treat design.md §Decision 3's before-value as stale and re-derive the headroom from the measurement. <!-- sdd-owner: implementation -->

## 1. Unit 1 — server-side resolution order (A binding-first + B-narrow sole-active)

Start: §0 closed. Finish: `handleSessionStart` resolves binding → windowed lookup →
sole-active → mint, with the four lookups' contracts unchanged for every other caller.
Verification: the tests named in design.md §Decision 5 plus the four mutation cases.
Rollback: design.md §Decision 7 (revert handler block, delete both new methods;
uncommitted work reverts file-by-file, committed work is a plain `git revert` — nothing is
persisted by this unit).

### RED

- [x] 1.1 RED (repository): add a `findSoleActiveForReuse` describe to
      `apps/server/src/db/repositories/agent-sessions-repository.test.ts`, mirroring the
      `findActiveForTransport` cases, with the eight cases named in design.md §Decision 5:
      sole fresh row returns the row; **idle >30 min returns the row** (backdate
      `last_activity_at`/`started_at` — raw-SQL pattern from
      `apps/server/src/services/agent-sessions.test.ts:274–276`); two rows → `undefined`
      (never recency, whichever of `started_at`/`last_activity_at` is newer); zero →
      `undefined`; three rows → `undefined` (the `LIMIT 2` boundary, repo-level); a
      soft-deleted row excluded; `ended`/`abandoned` excluded; another token's or another
      project's row not returned. Run
      `pnpm vitest run apps/server/src/db/repositories/agent-sessions-repository.test.ts`
      and confirm it fails for the missing method. <!-- sdd-owner: implementation -->
- [x] 1.3 RED (service): add a sole-active describe to
      `apps/server/src/services/agent-sessions.test.ts` (mirror the
      `findActiveForTransport` describe at `:248–287`) covering the same eight outcomes
      through `AgentSessionsService.findSoleActiveForReuse({ tokenId, projectId })`,
      including the returns-`null` (not `undefined`) convention of its sibling at
      `apps/server/src/services/agent-sessions.ts:574–588`. Confirm red. <!-- sdd-owner: implementation -->
- [x] 1.5 RED (handler): extend the reuse describe in
      `apps/server/src/mcp/session-tools.test.ts` (the `memory.session_start — reuse vs.
mint` block, `:91–137`; `makeContext()` there already carries `mcpSessionId`
      variants) with, per design.md §Decision 5: _sole-active adoption past the window_
      (one backdated row → `reused: true`, same id, row count 1); _ambiguity still mints
      with two stale rows_ (two backdated rows → `reused: false` — sole-or-nothing is not
      recency); _binding-first precedence_ (one stale + one fresh row, transport bound to
      the stale row → `reused: true` with the bound id, row count unchanged);
      _binding established by `memory.session_resume` answers step (1)_ (pattern of the
      resume-binding test at `:356–368`, then `session_start` adopts the resumed row);
      _fall-through with the binding preserved_ (parameterize the bound row as `ended`,
      `abandoned`, soft-deleted via `softDelete`, and other-project via a second project —
      assert the response id ≠ bound id **and** that after the call
      `router.get(tokenId, mcpSessionId)?.rembricSessionId` equals the row the call
      resolved, i.e. re-pointed, never cleared). Confirm red. <!-- sdd-owner: implementation -->
- [x] 1.6 RED (repro conversion): rewrite `apps/server/src/mcp/ghost-session-repro.test.ts`
      in place (keep the filename — it anchors #377), flip the header comment from
      REPRODUCTION to REGRESSION, add a `makeContext()` variant with
      `mcpSessionId: 'repro-transport'`, and convert the three tests per design.md
      §Decision 5: keep the control test as-is; the weeks-long timeline gains the bound
      variant (89-min idle call → `reused: true` with R1 adopted — this inverts today's
      `expect(g1.reused).toBe(false)` on line ~143 — row count 1; post-sweep Monday call
      → `reused: false` kept as the by-design control; post-resume with two live rows →
      the first call mints **once**, every later call on the bound transport is
      `reused: true` with the bound id, and the row count stops growing — the snowball
      case); add the binding-less timeline (`mcpSessionId: null`: ghost #1 gone, and under
      two live rows it still mints each call — the no-guess control); convert the opencode
      cadence test to a regression case (no declaration ever; sole-active adoption at the
      89-min idle call; two live rows → mint). Final assertions per proposal.md "Testing
      shape": `agent='unknown'` ghost count 0 in the common path and ≤2 live rows for the
      logical conversation. Confirm red on the inverted assertions only. <!-- sdd-owner: implementation -->

### GREEN

- [x] 1.2 GREEN (repository): add `findSoleActiveForReuse(tokenId, projectId)` to
      `apps/server/src/db/repositories/agent-sessions-repository.ts` directly after
      `findActiveForTransport` (`:150–170`), using the exact shape in design.md §Decision 2
      — same `conditions` array minus the staleness predicate, `limit(2)`,
      `rows.length === 1 ? rows[0] : undefined`, the the No-ORDER-BY comment comment, and one
      comment sentence naming `memory.session_start` as the only caller and pointing at
      the delta requirement. No `activeSinceMs` parameter. Run §1.1 and confirm green. <!-- sdd-owner: implementation -->
- [x] 1.4 GREEN (service): add `AgentSessionsService.findSoleActiveForReuse({ tokenId,
projectId })` to `apps/server/src/services/agent-sessions.ts` directly after
      `findActiveForTransport` (`:574–588`), delegating to the new repo method with `?? null`,
      per design.md §Decision 2. The service computes no clock here — deliberately unlike
      its sibling at `:580`. Run §1.3 and confirm green. <!-- sdd-owner: implementation -->
- [x] 1.7 GREEN (handler): replace the block at
      `apps/server/src/mcp/session-tools.ts:178–206` with the exact code shape in design.md
      §Decision 1: compute `key = routerKey()` and `boundId` from
      `deps.router.get(key.tokenId, key.mcpSessionId)?.rembricSessionId`, load the row with
      `deps.agentSessions.getById(boundId)`, adopt it only when `status === 'active'` **and**
      `deletedAt === null` **and** it matches `ctx.token.id` and `projectId`, otherwise
      `findActiveForTransport(...) ?? findSoleActiveForReuse(...)`, then `touchActivity` or
      mint as today (`agent: args.agent ?? 'unknown'` at `:201`). Leave `deps.sweep?.`
      (`:210`), the `setActiveSession`/`setActiveProject` re-pin including the
      `source !== 'default'` guard (`:212–221`) and the response shape (`:222–231`)
      untouched. Do NOT resolve step (1) through `resolveSessionId`, do NOT touch
      `resolveSessionId`/`resolveActiveSessionId` (`_shared.ts:308–334`,
      `memory-tools.ts:667–698`), and do NOT call `router.clearSession` anywhere in this
      handler. Run §1.5 and §1.6 and confirm green. <!-- sdd-owner: implementation -->
- [x] 1.8 CONTROL (no-leak, delta-mandated): add the auto-attaching-write control to
      `apps/server/src/mcp/memory-tools.test.ts` — one backdated `active` row, no router
      entry → `memory.save` without a `sessionId` persists `session_id = NULL`. This is a
      control, not a RED: record that it is green **before** §1.7 and green after, and
      that it reds only under the inverse mutation in §1.12. <!-- sdd-owner: implementation -->

### Mutation checks (design.md §Decision 5)

- [x] 1.9 MUTATION 1 — binding guards: `node scripts/mutate.mjs --file
apps/server/src/mcp/session-tools.ts --spec
apps/server/src/mcp/session-tools.test.ts --mutation '<adoption condition>' --with
'true'`, dropping each guard separately (`status === 'active'`, `deletedAt === null`,
      token match, project match). Each weakened condition must red the fall-through
      parameterized tests from §1.5; a mutation that reddens nothing is a finding, not a
      pass. <!-- sdd-owner: implementation -->
- [x] 1.10 MUTATION 2 — sole-or-nothing: mutate
      `apps/server/src/db/repositories/agent-sessions-repository.ts` so
      `findSoleActiveForReuse` returns `rows[0]` unconditionally (and, as a second case,
      `limit(1)`), running it against `apps/server/src/db/repositories/agent-sessions-repository.test.ts`,
      `apps/server/src/services/agent-sessions.test.ts` and
      `apps/server/src/mcp/session-tools.test.ts`. Must red the two-rows-never-recency
      tests and the ambiguity-still-mints handler/repro tests. <!-- sdd-owner: implementation -->
- [x] 1.11 MUTATION 3 — no-staleness: reintroduce the `EFFECTIVE_LAST_ACTIVITY` window into
      `findSoleActiveForReuse` (repo, and the `activeSinceMs` derivation in the service as a
      second case), running it against the repository, service and
      `apps/server/src/mcp/ghost-session-repro.test.ts` specs. Must red the
      backdated-sole-adoption tests in all three layers. <!-- sdd-owner: implementation -->
- [x] 1.12 MUTATION 3-inverse — remove the staleness predicate from
      `findActiveForTransport` (`apps/server/src/db/repositories/agent-sessions-repository.ts:150–170`).
      Must red the §1.8 no-leak control and the existing `fix-audited-defects` tests; if it
      reddens only the control, the window is under-covered and that gap goes in the PR
      description. <!-- sdd-owner: implementation -->

### REFACTOR

- [x] 1.13 REFACTOR: `git diff` proves `resolveSessionId`, `resolveActiveSessionId`, and every
      other `findActiveForTransport` caller are byte-for-byte untouched; the new method is
      named `findSoleActiveForReuse` with exactly two callers/layers and is not foldable into
      its sibling; comments carry only the two non-obvious invariants from design.md
      §Decision 2; `pnpm run typecheck` and `pnpm run lint` clean; no `any` introduced. Then
      re-run §1.1–1.8 as one pass. <!-- sdd-owner: implementation -->

## 2. Unit 2 — D3 description clause and the pin re-measurement

Start: §1 merged or at least green. Finish: one sentence appended and the length pin
holding the measured value. Rollback: restore the 818-char literal and re-run the pin
(design.md §Decision 7 — the `it.each` makes a half-removed clause fail the build).

- [x] 2.1 RED: add the clause assertions to the `memory.session_start names every field its
outputSchema requires` test in `apps/server/src/test/mcp-integration.test.ts`
      (`:853–870` region of the `descriptions agree with what the tools do` describe):
      `expect(desc).toMatch(/do NOT call this again/i)` and
      `expect(desc).toMatch(/attach automatically/i)`, read from the live `tools/list`
      response as the neighbouring assertions are. Run
      `pnpm vitest run apps/server/src/test/mcp-integration.test.ts` and confirm these fail
      and nothing else does. <!-- sdd-owner: implementation -->
- [x] 2.2 GREEN: append exactly one sentence to the `memory.session_start` description
      literal at `apps/server/src/mcp/server.ts:313`, after "…so it reports whose session
      you are now writing into." — the exact text in design.md §Decision 3. Do not reflow any
      other part of the description, and do not touch the length pin in this task. <!-- sdd-owner: implementation -->
- [x] 2.3 RE-MEASURE (part of this unit, not a follow-up): run
      `pnpm vitest run apps/server/src/test/mcp-integration.test.ts`; the length pin at
      `apps/server/src/test/mcp-integration.test.ts:795` (`['memory.session_start', 818]`)
      must fail with `expected 818 to be <actual>`, where `actual` is measured from the live
      `tools/list` (`beforeAll`, `:782–790`). Take that `actual` verbatim and update the row
      to it. Do not hand-count the new description, and do not raise
      `DESCRIPTION_MAX_LENGTH` (`server.ts:133`) to fit — if the clause stops fitting,
      reword it shorter (design.md §Decision 3 steps 1–4). <!-- sdd-owner: implementation -->
- [x] 2.4 RECORD: put the before/after measurement and the remaining headroom under
      `DESCRIPTION_MAX_LENGTH = 1900` in the PR description (before: 818/1900, 1082
      headroom), naming the instrument — the live `tools/list` string, never the source
      constant. The mcp-api delta keeps the 818/1082 before-value verbatim; do not edit the
      delta. <!-- sdd-owner: implementation -->
- [x] 2.5 CONTROL: confirm the adjacent pins stay green untouched — the required-field list
      (`:857–870`, including the `reused:true.*ADOPTED` and `agent.*MAY differ` regexes) and
      "a second `memory.session_start` adopts the first session and says so" (`:908`). If
      either needs editing, the clause was placed wrong: fix the placement, not the pin. <!-- sdd-owner: implementation -->
- [x] 2.6 MUTATION (prose guard): delete the appended clause from
      `apps/server/src/mcp/server.ts` via
      `node scripts/mutate.mjs --file apps/server/src/mcp/server.ts --spec
apps/server/src/test/mcp-integration.test.ts --mutation '<the clause>' --with ''` and
      confirm §2.1's two assertions red. <!-- sdd-owner: implementation -->

## 3. Unit 3 — D4′: the Pi extension declares its identity on the MCP transport

Pi-only. `apps/plugin/bin/rembric-plugin-core.mjs`, the MCP bridge, the other four
clients and the HTTP lifecycle (`ensure` / /resume / /turn / /end) are NOT touched
(design.md §Decision 4, proposal.md decision 5). Start: §1 green. Rollback: revert the
extension — the server-side pieces do not depend on any client declaring.

### RED (harness: `startedHarness` `:183–187`, `harness.fire` `:175–179`

`callThroughExtension` `:1229` in `apps/plugin/.pi-plugin/plugin.test.ts`)

- [x] 3.1 RED (bind after ensure, and the binding answers `session_start`): in
      `apps/plugin/.pi-plugin/plugin.test.ts`, seed a second `active` row for the same
      project over HTTP first (so the sole-active lookup would refuse), then
      `fire('before_agent_start')` and drive the registered `memory.session_start` tool →
      `reused: true` with `sessionId === <host uuid>`, row count unchanged. Spy `fetch` to
      assert a `tools/call` body naming `memory.session_resume` with
      `{ sessionId: <host uuid> }` was sent **and** that no body names
      `memory.session_start`. Confirm red (today no resume call is issued). <!-- sdd-owner: implementation -->
- [x] 3.2 RED (silent retry): stub the first `memory.session_resume` call with an MCP error
      body `{"ok":false,"code":"session_not_found",…}` (wire shape: `errors.ts:11–19`) → no
      throw out of `before_agent_start`, no entry in `harness.notifications`; the next
      `fire('before_agent_start')` retries, binds, and `session_start` then adopts. Confirm
      red. <!-- sdd-owner: implementation -->
- [x] 3.3 RED (re-init re-declares): stub one /mcp/ response with a fresh
      `mcp-session-id` header (body passthrough) so `send()` re-keys the transport from
      headers (`apps/plugin/.pi-plugin/index.ts:151–156`), then `fire('before_agent_start')`
      again → a second `memory.session_resume` goes out on the new transport. Confirm red. <!-- sdd-owner: implementation -->
- [x] 3.4 RED (silent degradation): stub every `memory.session_resume` as failing → exactly
      `BIND_FAILURE_LIMIT = 3` attempts across ≥4 turns and none afterwards; no
      notifications, no throw; nudges still injected and the shutdown flush still lands.
      Confirm red. <!-- sdd-owner: implementation -->

### GREEN

- [x] 3.5 GREEN (accessor): add `sessionId(): string | null { return mcpSessionId; }` to the
      object returned by `createMcpClient` in `apps/plugin/.pi-plugin/index.ts` — the
      closure already refreshes `mcpSessionId` from every response header (`:151–156`), so
      no new state is introduced (design.md §Decision 4 step 1). <!-- sdd-owner: implementation -->
- [x] 3.6 GREEN (bind state): inside `rembric()` add the per-instance state
      `boundKey: string | null` (`` `${mcpSessionId}::${hostId}` `` last successfully
      declared) and `bindFailures` with `const BIND_FAILURE_LIMIT = 3;` (design.md
      §Decision 4 step 2). <!-- sdd-owner: implementation -->
- [x] 3.7 GREEN (declaration): in `before_agent_start`, immediately after
      `await core.ensureSession(sessionId)` (`index.ts:393`) and before the
      nudge/system-prompt assembly, insert the exact block from design.md §Decision 4 step
      3: compute `bindKey` from `mcp?.sessionId()` and the host id; when `mcp && bindKey &&
bindKey !== boundKey && bindFailures < BIND_FAILURE_LIMIT`, `await
mcp.callTool('memory.session_resume', { sessionId })` inside a try/catch, resetting
      `bindFailures` and `boundKey` only on a non-error result, incrementing `bindFailures`
      and calling `diag(...)` on either failure kind. Never `memory.session_start`, never
      `ctx.ui.notify`, never a rejection escaping the handler, no error-kind sniffing.
      `session_shutdown` and `mcp.close()` stay as they are (`:505–521`). Run §3.1–3.4 and
      confirm green. <!-- sdd-owner: implementation -->

### Mutation + REFACTOR

- [x] 3.8 MUTATION (two cases in one invocation, against
      `apps/plugin/.pi-plugin/plugin.test.ts`): `node scripts/mutate.mjs --file
apps/plugin/.pi-plugin/index.ts --spec apps/plugin/.pi-plugin/plugin.test.ts
--mutation 'bindFailures < BIND_FAILURE_LIMIT' --with 'true'` must red §3.4 (the
      exactly-three-attempts assertion); `--mutation 'bindKey !== boundKey' --with 'true'`
      must red §3.3 (and the once-per-turn assertions in §3.1). Record both results. <!-- sdd-owner: implementation -->
- [x] 3.9 REFACTOR: prove by `git diff`/grep that this unit changed only
      `apps/plugin/.pi-plugin/index.ts` (+ its test): no edit to
      `apps/plugin/bin/rembric-plugin-core.mjs`, `mcp-bridge/`, `scripts/_api.sh`,
      `.hermes-plugin/`, `.opencode-plugin/`, `.claude-plugin/`, `.codex-plugin/`, and no
      new `memory.session_start` call or endpoint string anywhere under `apps/plugin/`
      (`grep -rn "memory.session_start" apps/plugin/` empty; `grep -rn "memory.session_resume"
apps/plugin/` only the new declaration). `pnpm run typecheck` + `pnpm run lint` clean
      and `pnpm vitest run apps/plugin/.pi-plugin/plugin.test.ts` green. <!-- sdd-owner: implementation -->

## 4. Unit 4 — docs sweep and the mandatory e2e walkthrough

Start: §3 green (docs describe shipped behaviour). Rollback: revert the doc files; the
e2e run leaves nothing behind by construction (design.md §Decision 6 step 6).

- [x] 4.1 DOCS: `apps/plugin/.pi-plugin/README.md` — document the identity declaration next
      to the session-capture bullet (`:76`) and the "Session close" section (`:104–117`):
      the extension declares its row over MCP with `memory.session_resume` after the first
      `ensure`, re-declares when the transport re-initialises, retries a `not_found`, and
      stays silent on failure. <!-- sdd-owner: implementation -->
- [x] 4.2 DOCS: `docs/agents.md` Pi section (`:358–426`, where the lifecycle is already
      documented at `:362` and `:412–414`) — same fact, in that section's voice. <!-- sdd-owner: implementation -->
- [x] 4.3 DOCS SWEEP AUDIT (self-check item): check the remaining sweep paths —
      root `README.md` and `apps/plugin/README.md` — for text that documents Pi session
      attachment; edit only those that do, and record per path either the edit or an
      explicit "no edit needed" with the matching line numbers as evidence. <!-- sdd-owner: implementation -->
- [x] 4.4 DOCS / CHANGELOG handling: `apps/plugin/CHANGELOG.md` is release-please-generated
      (entries carry `plugin-vX.Y.Z` compare links and commit hashes; there is no
      Unreleased section), so ship the Pi-only wording in the conventional-commit body and
      the PR description instead — stating that one `plugin` version bumps for all five
      clients and only Pi behaviour changed (proposal.md Risks) — and confirm
      `git diff --stat apps/plugin/CHANGELOG.md` is empty. If the owner's convention
      requires a hand entry, follow the owner; do not hand-edit a generated file by
      inference. <!-- sdd-owner: implementation -->
- [ ] 4.5 E2E (OPERATOR-ONLY — needs the host's Docker; run the isolated-rails variant of
      design.md §Decision 6 with `references/e2e-walkthrough.md` §5b): scratch HOME
      (`mktemp -d`) plus a scratch workspace holding `.rembric` with `PROJECT_SLUG=demo`;
      `pnpm run dev:docker:up` and wait for `[bootstrap] listening on`; capture the seeded
      `demo-writer` token from the seed banner; launch Pi in the scratch dir with the local
      URL/token, overriding any ambient `REMBRIC_API_TOKEN`/`REMBRIC_SERVER_URL` so the
      extension never sees a prod token; load the extension per-run from the repo tree (no
      `pi install`); one conversation with ≥2 turns, turn 1 ending in a `memory.save`. This
      step belongs to the rembric-plugin-development skill's mandatory e2e and is the gate
      for merging the plugin unit. <!-- sdd-owner: implementation -->
- [ ] 4.6 E2E assertions (same run): after turn 1 exactly ONE `sessions` row with
      `agent='pi'` for that token+project and the saved memory carries that row's
      `session_id` (dashboard /sessions + /memories, or sqlite in the container); after
      turn 2 (any idle gap) the row count is still 1 and no `agent='unknown'` row appeared.
      Discriminating leg: create a second `active` row for the project over the HTTP API
      before turn 2 and confirm writes still land on the bound row. Also enumerate in the PR
      what is NOT covered locally — the published `@rembric/pi` artifact, the real 30-min
      staleness boundary, the 24 h abandonment sweep, multi-week timelines, the other four
      clients (design.md §Decision 6 step 5). <!-- sdd-owner: implementation -->
- [x] 4.7 SELF-CHECK (install/idempotency, N/A justified by evidence): confirm the diff
      touches no `install.sh`, no repo-root shim, no per-client `install.sh`/`uninstall.sh`
      and no `marketplace.json` (`git diff --stat` shows none), so installer idempotency is
      genuinely out of scope for this change — record that as an evidence-backed N/A rather
      than an assumption. <!-- sdd-owner: implementation -->
- [x] 4.8 SELF-CHECK (two-track release): confirm the diff touches no release-please
      config/manifest and no client version carrier (`.claude-plugin/`, `.codex-plugin/`,
      `.hermes-plugin/plugin.yaml`, `.opencode-plugin/plugin.ts`,
      `.pi-plugin/package.json`), so the unified `plugin` version bumps normally on release
      and the server image is untouched. <!-- sdd-owner: implementation -->
- [x] 4.9 SELF-CHECK (single source of truth): `git ls-files apps/plugin/` still shows ONE
      copy of each shared resource and the diff touches no shared module; grep proves no
      second copy of `parseDotenv` / `SLUG_RE` / the core's helpers / endpoint strings was
      introduced. <!-- sdd-owner: implementation -->
- [x] 4.10 TEARDOWN / local state: `docker compose … down`, scratch HOME and workspace
      deleted, no uninstall needed (per-run extension load), nothing to restore — assert the
      the operator's real home directory and any client config file were never written. <!-- sdd-owner: implementation -->

## 5. Final verification gates (after all units)

- [x] 5.1 `pnpm test` green (includes the Pi harness file via
      `apps/server/vitest.config.ts::include`'s `../plugin/.*-plugin/*.test.ts` glob). <!-- sdd-owner: implementation -->
- [x] 5.2 `pnpm run typecheck` clean. <!-- sdd-owner: implementation -->
- [x] 5.3 `pnpm run lint` clean. <!-- sdd-owner: implementation -->
- [x] 5.4 `openspec validate fix-pi-ghost-sessions --strict` passes. <!-- sdd-owner: implementation -->
- [x] 5.5 `pnpm run check:delta-freshness` passes, and is re-run after EVERY archive of the
      four active `mcp-api`-delta changes (`expose-session-start-agent`,
      `expose-session-write-verdict`, `proactive-entity-recall`, this one — design.md §0
      point 4). <!-- sdd-owner: implementation -->
- [x] 5.6 `pnpm run check:delta-sections` passes, re-run alongside §5.5 for the same
      reason. <!-- sdd-owner: implementation -->
- [ ] 5.7 `pnpm run check:spec-provenance` passes (proposal.md Success criteria). <!-- sdd-owner: implementation -->
- [x] 5.8 Record the four mutation outcomes (§1.9–1.12) and the two plugin mutation
      outcomes (§3.8) in the PR description, naming each mutation, the test that reddened and
      the instrument — a mutation that reddened nothing is reported as uncovered, not
      omitted. <!-- sdd-owner: implementation -->
- [x] 5.9 Confirm the no-guess rule still refuses, in code and spec text: the
      two-stale-rows-mint tests (§1.5, §1.6) are green and red under §1.10, and the
      published scenario `sessions/spec.md` "memory.session_start mints a fresh session
      instead of reusing an ambiguous one" is carried unchanged in the delta. <!-- sdd-owner: implementation -->

## 6. Post-apply bounded review and lifecycle gates

- [x] 6.1 Ask the owner the delivery/chain decision before opening the second PR
      (`ask-on-risk`): chain strategy is `pending`, risk is High, and a `size:exception` is
      never inferred. <!-- sdd-owner: parent -->
- [ ] 6.2 Start or reuse the bounded review for the §1 server-unit PR, confirming the
      reviewer sees §1.9–1.12's mutation evidence and the `findActiveForTransport` no-leak
      control. <!-- sdd-owner: parent -->
- [ ] 6.3 Start or reuse the bounded review for the §3 Pi-extension PR, confirming §4.5–4.6
      e2e evidence (or the explicitly-listed unverified paths) is attached. <!-- sdd-owner: parent -->
- [ ] 6.4 Post-apply lifecycle gate: re-run §5.5/§5.6 after each of the four mcp-api-delta
      archives, and only then request this change's own archive. <!-- sdd-owner: parent -->

## 7. Review workload forecast (per unit, code + tests only)

Spec deltas are excluded because they are already written. Estimates are changed lines
(`additions + deletions`), measured against the current tree.

| Unit                                                    | Files                                                                                                                                      | Estimated changed lines |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| §1.1–1.4 repository + service lookup and their tests    | `agent-sessions-repository.ts` (+12), `agent-sessions.ts` (+14), `agent-sessions-repository.test.ts` (+75), `agent-sessions.test.ts` (+85) | ~185                    |
| §1.5–1.7 handler order + handler tests                  | `session-tools.ts` (+15/−8), `session-tools.test.ts` (+150)                                                                                | ~175                    |
| §1.6 repro conversion (test-only)                       | `ghost-session-repro.test.ts` (+240/−160)                                                                                                  | ~400                    |
| §1.8 + §1.9–1.13 controls, four mutation runs, refactor | `memory-tools.test.ts` (+25) + mutation evidence                                                                                           | ~30                     |
| §2 D3 clause + re-measured pin                          | `server.ts` (+2), `mcp-integration.test.ts` (+10/−2)                                                                                       | ~15                     |
| §3 Pi declaration + plugin tests                        | `.pi-plugin/index.ts` (+25), `plugin.test.ts` (+180)                                                                                       | ~205                    |
| §4 docs + e2e                                           | `.pi-plugin/README.md`, `docs/agents.md` (+40); e2e is run, not diffed                                                                     | ~40                     |
| **Total**                                               |                                                                                                                                            | **~1,050**              |

- Exceeds the 400-line review budget by roughly 2.6×. No single unit fits except §2 and
  the two doc/test slices, and §1 alone (~790 lines) does too — so chained PRs are
  recommended rather than optional.
- Suggested split (each with a clean start/finish/verification/rollback boundary):
  PR 1 = §1.1–1.4 + §1.8 (lookup plus no-leak control, ~215) → PR 2 = §1.5–1.7 + §1.9–1.13
  (handler, regression conversion, mutation evidence, ~600; the test-only repro file may
  be raised as its own PR if the reviewer asks) → PR 3 = §2 (~15) → PR 4 = §3 (~205, gated
  by §4.5–4.6 e2e) → PR 5 = §4 docs (~40).
- Decision needed before apply: **Yes**. The owner must pick the chain strategy (or
  accept an explicit `size:exception`, which only the owner can authorise) and must first
  close the §0 archive gate; nothing in §1–§7 may start while that gate is red.
