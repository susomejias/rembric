<!-- spike result: plan-a -->
<!-- opencode version verified: 1.15.5 -->
<!-- cwd/PWD spike output (captured 2026-05-19):
     cwd: /private/tmp/rembric-spike  (resolved realpath)
     PWD: /tmp/rembric-spike          (symlink form, used by bridge)
     CLAUDE_PROJECT_DIR: null
     → Plan A: bridge's existing chain works, no bridge change needed.
-->

## 0. Cwd spike (operator-only, GATES everything below)

- [x] 0.1 opencode CLI 1.15.5 installed. Minimum supported recorded in README troubleshooting section.
- [x] 0.2 Bridge stub written to ~/.config/rembric/bin/ and verified to spawn under opencode.
- [x] 0.3 ~/.config/opencode/opencode.json written with candidate MCP block.
- [x] 0.4 Launched opencode (`opencode mcp list`); MCP subprocess spawned the bridge.
- [x] 0.5 Captured bridge stderr: `cwd=/private/tmp/rembric-spike, PWD=/tmp/rembric-spike, CLAUDE_PROJECT_DIR=null`.
- [x] 0.6 Plan A confirmed (both cwd and PWD resolve to user repo). Recorded at top of this file.
- [ ] 0.7 chat.message vs message.updated — N/A, both handlers dropped from v1 (passive capture deferred per design.md scope reduction).

## 1. Plugin module skeleton

- [x] 1.1 Created `plugin/.opencode-plugin/` with `plugin.ts`, `install.sh`, `uninstall.sh`, `README.md`, plus the test-only sibling `helpers.ts` + co-located `plugin.test.ts`.
- [x] 1.2 plugin.ts header: `// @rembric-plugin-version 0.7.0`, `// cwd-spike-result: plan-a`, locally-defined `Plugin` type stub (no `@opencode-ai/plugin` import to keep the dep out of the repo).
- [x] 1.3 `parseDotenv()` implemented in helpers.ts (test mirror) + duplicated as non-exported function in plugin.ts (invariant test enforces parity).
- [x] 1.4 `readRembricSlug()` implemented with the same slug regex as the bridge. Byte-for-byte equivalence test added.
- [x] 1.5 `stripPrivateTags()` — REMOVED. No longer needed after v1 scope reduction; was used only by the dropped `chat.message`/`tool.execute.after` handlers.
- [x] 1.6 `truncate()` — REMOVED for same reason as 1.5.

## 2. HTTP client

- [x] 2.1 `rembricPost` implemented in plugin.ts: bearer header, JSON content-type, AbortSignal.timeout(3_000), silent failure with one-line stderr diagnostic. GET helper removed in v1 scope reduction.
- [x] 2.2 Module-construction-time env-var check writes `[rembric] REMBRIC_SERVER_URL or REMBRIC_API_TOKEN missing; plugin disabled` and short-circuits every HTTP path via the closure-scoped `disabled` flag.
- [ ] 2.3 Handler-level fetch-mock harness — DEFERRED. Helper unit tests landed; end-to-end verified against the live dev server (POST `/api/demo/sessions` confirmed via `data-dev/data.db` query).

## 3. Event handlers

- [x] 3.1 `event` dispatcher: handles `session.created` (sub-agent filter via parentID + title-suffix, dedup via knownSessions Set, diagnostic stderr line, POST to `/api/<slug>/sessions` once) and `session.deleted` (in-memory cleanup, no HTTP). E2E-verified: top-level POST landed in `data-dev/data.db`, sub-agent suppressed.
- [ ] 3.2 `"chat.message"` handler — DROPPED FROM v1. `/api/<slug>/prompts/passive` endpoint does not exist on `src/server/api-router.ts`. Spec updated to remove. Deferred to a follow-up change that adds the server endpoint first.
- [ ] 3.3 `"tool.execute.after"` handler — DROPPED FROM v1. Same reason as 3.2 (`/api/<slug>/observations/passive` absent).
- [x] 3.4 `"experimental.session.compacting"` handler: pushes ONE reminder string to `output.context` instructing the post-compaction agent to call `memory.session_summary` (project slug interpolated when known). `/context` GET removed in v1 scope reduction — endpoint doesn't exist yet.
- [x] 3.5 Plan A: `shell.env` handler intentionally absent. Verified via `Object.keys(handlers) === ['event', 'experimental.session.compacting']`.

## 4. Bridge change (Plan B only — skip entirely if Plan A)

- [x] 4.1 N/A — Plan A.
- [x] 4.2 N/A — Plan A.
- [x] 4.3 N/A — Plan A.
- [x] 4.4 Plan A: `git diff plugin/bin/rembric-bridge.mjs` is empty.

## 5. Install / uninstall scripts

- [x] 5.1 `install.sh`: resolves repo via `git rev-parse --show-toplevel`, copies plugin.ts + bridge to their respective destinations, prints the MCP snippet with $HOME expanded. Idempotent (re-run produces no diff vs source).
- [x] 5.2 `uninstall.sh`: removes both files, attempts to remove empty parent dirs, prints what was/wasn't removed. Idempotent (2nd run exits 0 with same banner). opencode.json untouched. Manually verified.
- [ ] 5.3 Bash smoke test for install.sh — DEFERRED. Covered by the manual e2e smoke that ran during this implementation (install + uninstall both exercised against the real layout).

## 6. README + plugin docs

- [x] 6.1 `plugin/.opencode-plugin/README.md` written: two-step install, Update, Verify, Troubleshooting sections. No npm path.
- [x] 6.2 `docs/agents.md` extended with `### opencode (bundled plugin)` section: Install, Configure, Verify, Troubleshooting subsections in order.
- [x] 6.3 `README.md` updated: opencode in toc, intro paragraph, and the `## Hooking up opencode` section.
- [x] 6.4 Dashboard help copy not currently a single source — covered by README + docs/agents.md updates. No `src/dashboard/*.ts` lists clients today (verified by grep).

## 7. Version lock-step + CHANGELOG

- [x] 7.1 Bumped `0.6.0 → 0.7.0` in all three: `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml`.
- [x] 7.2 `// @rembric-plugin-version 0.7.0` in `plugin/.opencode-plugin/plugin.ts`.
- [x] 7.3 `plugin/CHANGELOG.md` `[0.7.0] — unreleased` block added describing the opencode plugin and v1 scope.
- [x] 7.4 `src/test/invariants.test.ts` extended with `plugin version lock-step` describe block reading all four sources. Also extended with `plugin/.opencode-plugin/ helpers parity` invariant ensuring plugin.ts and helpers.ts share identical helper bodies.

## 8. Validation + tests

- [x] 8.1 `pnpm vitest run` → 464/464 passed (full suite, includes the 18 new helper tests + 2 new invariants).
- [x] 8.2 `pnpm vitest run plugin/.opencode-plugin/plugin.test.ts` → 18/18 passed.
- [x] 8.3 `pnpm run lint` and `pnpm run typecheck` → 0 errors.
- [x] 8.4 `openspec validate add-opencode-plugin --strict` → valid.

## 9. End-to-end manual smoke

Executed by the implementation against the dev stack on 2026-05-19 (Plan A path):

- [x] 9.1 install.sh copied both files to expected locations; MCP snippet printed with $HOME expanded.
- [x] 9.2 Triggered `session.created` via tsx harness invoking the real plugin module → `data-dev/data.db` shows `agent='opencode'` row for `opencode-e2e-1779188472461`, `status='active'`, project=demo, title placeholder.
- [x] 9.3 `opencode mcp list` against the live `/mcp/demo` endpoint → `✓ rembric connected, toolCount=19`. MCP `initialize` returned the path-scoped instructions block.
- [ ] 9.4 Compaction with a real LLM call — DEFERRED. Unit-tested via the tsx harness: `output.context` got exactly one push starting with `CRITICAL INSTRUCTION FOR THE POST-COMPACTION AGENT`. Real LLM compaction left for the user to verify if desired.
- [x] 9.5 `<private>` redaction — N/A in v1 (redaction handler dropped along with chat.message).
- [x] 9.6 Sub-agent filtering verified: tsx harness sent `session.created` with `title="subtask (claude subagent)"` → no row in `data-dev/data.db` for that id, only the top-level session.
- [x] 9.7 Top-level row stayed `status='active'` after the harness completed (no `/end` POST from the plugin, as designed). abandonStale-flip behavior is the same as Codex's steady state.
- [x] 9.8 uninstall.sh removed both files on 1st run, exited 0 on 2nd run (idempotent), opencode.json preserved.

## 10. Wrap-up

- [ ] 10.1 Commit on `main` (single-maintainer repo — no feature branch required).
- [ ] 10.2 PR — N/A for single-maintainer commit on main. Track via the OpenSpec archive.
- [ ] 10.3 `/opsx:archive add-opencode-plugin` after commit.
